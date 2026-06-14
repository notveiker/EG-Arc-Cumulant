// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PredictionMarket} from "./PredictionMarket.sol";

/// @title Cumulant TrancheVault
/// @notice Splits a weighted basket of prediction-market legs into two risk tranches over a
///         settlement waterfall. Senior capital is paid first up to its principal plus a fixed
///         coupon; junior capital absorbs first losses and keeps the leveraged residual.
/// @dev    Senior and junior deposits are pooled and buy the same leg positions on-chain — the
///         tranche class only changes how recovered USDC is distributed at settlement:
///
///           seniorEntitlement = seniorPrincipal * (1 + couponBps)
///           seniorPot         = min(recovered, seniorEntitlement)
///           juniorPot         = recovered - seniorPot
///
///         Senior is therefore protected only up to the size of the junior buffer — standard
///         tranching, not an absolute guarantee. Each market backs at most one tranche so
///         settlement claims every leg exactly once (see BasketVault for the same rationale).
contract TrancheVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    uint16 internal constant BPS = 10_000;
    uint256 internal constant MAX_LEGS = 40;
    uint16 internal constant MAX_COUPON_BPS = 50_000; // 500% — generous but bounded

    struct Leg {
        uint256 marketId;
        PredictionMarket.Side side;
        uint16 weightBps;
    }

    struct Tranche {
        string name;
        uint16 seniorCouponBps; // senior target return on principal
        uint256 seniorPrincipal; // total senior USDC in (== senior shares)
        uint256 juniorPrincipal; // total junior USDC in (== junior shares)
        bool settled;
        uint256 recovered; // USDC claimed at settlement
        uint256 seniorPot; // waterfall split, frozen at settle
        uint256 juniorPot;
        address creator;
    }

    IERC20 public immutable usdc;
    PredictionMarket public immutable market;

    Tranche[] private _tranches;
    mapping(uint256 => Leg[]) private _legs;
    mapping(uint256 => mapping(address => uint256)) private _senior; // trancheId => user => shares
    mapping(uint256 => mapping(address => uint256)) private _junior;
    mapping(uint256 => bool) public marketAssigned;

    /// USDC the protocol market-maker has posted to buy positions back before settlement.
    uint256 public mmReserve;

    event TrancheCreated(uint256 indexed trancheId, address indexed creator, string name, uint16 seniorCouponBps);
    event Deposited(uint256 indexed trancheId, address indexed user, bool senior, uint256 amount);
    event Settled(uint256 indexed trancheId, uint256 recovered, uint256 seniorPot, uint256 juniorPot);
    event Redeemed(uint256 indexed trancheId, address indexed user, bool senior, uint256 shares, uint256 payout);
    event MmReserveFunded(address indexed from, uint256 amount, uint256 reserve);
    event SoldToMM(uint256 indexed trancheId, address indexed seller, bool senior, uint256 shares, uint256 payout);

    error LengthMismatch();
    error NoLegs();
    error BadWeights();
    error MarketTaken(uint256 marketId);
    error MarketResolvedAlready(uint256 marketId);
    error UnknownTranche();
    error ZeroAmount();
    error AlreadySettled();
    error NotAllResolved();
    error NotSettled();
    error InsufficientShares();
    error TooManyLegs();
    error EmptyName();
    error CouponTooHigh();
    error DepositTooSmall();
    error BadQuote();
    error ReserveTooLow();
    error QuoteExpired();

    constructor(PredictionMarket market_) Ownable(msg.sender) {
        market = market_;
        usdc = market_.usdc();
        usdc.forceApprove(address(market_), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────────────

    /// @param name            Display name.
    /// @param seniorCouponBps Senior target return on principal in bps (e.g. 1000 = +10%).
    /// @param marketIds       Leg markets.
    /// @param sides           Side bought per leg.
    /// @param weightsBps      Capital weights per leg; must total 10000.
    function createTranche(
        string calldata name,
        uint16 seniorCouponBps,
        uint256[] calldata marketIds,
        PredictionMarket.Side[] calldata sides,
        uint16[] calldata weightsBps
    ) external onlyOwner returns (uint256 trancheId) {
        uint256 n = marketIds.length;
        if (n == 0) revert NoLegs();
        if (n > MAX_LEGS) revert TooManyLegs();
        if (bytes(name).length == 0) revert EmptyName();
        if (seniorCouponBps > MAX_COUPON_BPS) revert CouponTooHigh();
        if (sides.length != n || weightsBps.length != n) revert LengthMismatch();

        uint256 weightSum;
        for (uint256 i; i < n; ++i) {
            uint256 marketId = marketIds[i];
            if (marketAssigned[marketId]) revert MarketTaken(marketId);
            PredictionMarket.Market memory m = market.getMarket(marketId);
            if (m.resolved) revert MarketResolvedAlready(marketId);
            PredictionMarket.Side side = sides[i];
            if (side != PredictionMarket.Side.Yes && side != PredictionMarket.Side.No) {
                revert PredictionMarket.InvalidSide();
            }
            weightSum += weightsBps[i];
            marketAssigned[marketId] = true;
        }
        if (weightSum != BPS) revert BadWeights();

        trancheId = _tranches.length;
        _tranches.push(
            Tranche({
                name: name,
                seniorCouponBps: seniorCouponBps,
                seniorPrincipal: 0,
                juniorPrincipal: 0,
                settled: false,
                recovered: 0,
                seniorPot: 0,
                juniorPot: 0,
                creator: msg.sender
            })
        );
        for (uint256 i; i < n; ++i) {
            _legs[trancheId].push(Leg({marketId: marketIds[i], side: sides[i], weightBps: weightsBps[i]}));
        }
        emit TrancheCreated(trancheId, msg.sender, name, seniorCouponBps);
    }

    /// @notice Deposit USDC into the senior or junior tranche. Capital buys the leg positions
    ///         immediately; the class only affects the settlement waterfall.
    function deposit(uint256 trancheId, uint256 amount, bool senior) external nonReentrant {
        Tranche storage t = _tranche(trancheId);
        if (amount == 0) revert ZeroAmount();
        if (t.settled) revert AlreadySettled();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        Leg[] storage legs = _legs[trancheId];
        uint256 n = legs.length;
        uint256 spent;
        for (uint256 i; i < n; ++i) {
            uint256 legAmount = i == n - 1 ? amount - spent : (amount * legs[i].weightBps) / BPS;
            if (legAmount == 0) revert DepositTooSmall(); // every leg must get a non-zero buy
            spent += legAmount;
            market.buy(legs[i].marketId, legs[i].side, legAmount);
        }

        if (senior) {
            _senior[trancheId][msg.sender] += amount;
            t.seniorPrincipal += amount;
        } else {
            _junior[trancheId][msg.sender] += amount;
            t.juniorPrincipal += amount;
        }
        emit Deposited(trancheId, msg.sender, senior, amount);
    }

    /// @notice Settle once all legs resolve (or are voided): claim what each leg yields, then
    ///         split via the waterfall. `settled` is flipped before the external claim loop
    ///         (reentrancy defense-in-depth); per-leg claims use try/catch so lost legs are
    ///         skipped, a single leg can't block settlement, and voided legs refund the stake.
    function settle(uint256 trancheId) external nonReentrant {
        Tranche storage t = _tranche(trancheId);
        if (t.settled) revert AlreadySettled();
        t.settled = true;

        Leg[] storage legs = _legs[trancheId];
        uint256 recovered;
        for (uint256 i; i < legs.length; ++i) {
            if (!market.getMarket(legs[i].marketId).resolved) revert NotAllResolved();
            try market.claim(legs[i].marketId) returns (uint256 payout) {
                recovered += payout;
            } catch {
                // lost leg — nothing claimable
            }
        }

        uint256 seniorPot;
        if (t.juniorPrincipal == 0) {
            // No junior buffer exists: senior is the only class, so it takes everything.
            // (Without this, any recovery above the senior coupon cap would be stranded in an
            // empty junior pot with no one able to redeem it.)
            seniorPot = recovered;
        } else {
            uint256 seniorEntitlement = t.seniorPrincipal + (t.seniorPrincipal * t.seniorCouponBps) / BPS;
            seniorPot = recovered < seniorEntitlement ? recovered : seniorEntitlement;
        }

        t.recovered = recovered;
        t.seniorPot = seniorPot;
        t.juniorPot = recovered - seniorPot;
        emit Settled(trancheId, recovered, t.seniorPot, t.juniorPot);
    }

    /// @notice Redeem senior or junior shares for the corresponding waterfall pot, pro-rata.
    function redeem(uint256 trancheId, uint256 shares, bool senior) external nonReentrant returns (uint256 payout) {
        Tranche storage t = _tranche(trancheId);
        if (!t.settled) revert NotSettled();
        if (shares == 0) revert ZeroAmount();

        if (senior) {
            uint256 bal = _senior[trancheId][msg.sender];
            if (shares > bal) revert InsufficientShares();
            payout = (t.seniorPot * shares) / t.seniorPrincipal;
            _senior[trancheId][msg.sender] = bal - shares;
        } else {
            uint256 bal = _junior[trancheId][msg.sender];
            if (shares > bal) revert InsufficientShares();
            payout = (t.juniorPot * shares) / t.juniorPrincipal;
            _junior[trancheId][msg.sender] = bal - shares;
        }
        if (payout > 0) usdc.safeTransfer(msg.sender, payout);
        emit Redeemed(trancheId, msg.sender, senior, shares, payout);
    }

    // ── Secondary market — sell back to the protocol market-maker pre-settlement ──

    /// @notice Post USDC liquidity the market-maker uses to buy positions back before
    ///         settlement (separate from the settled waterfall pots).
    function fundMmReserve(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        mmReserve += amount;
        emit MmReserveFunded(msg.sender, amount, mmReserve);
    }

    /// @notice Sell senior/junior shares back to the protocol market-maker BEFORE settlement at
    ///         a price the MM (owner) signed off-chain. The MM warehouses the position and redeems
    ///         it at settlement; the seller is paid immediately from the MM reserve.
    function sellToMM(
        uint256 trancheId,
        uint256 shares,
        bool senior,
        uint256 payout,
        uint256 deadline,
        bytes calldata sig
    ) external nonReentrant {
        Tranche storage t = _tranche(trancheId);
        if (t.settled) revert AlreadySettled();
        if (shares == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert QuoteExpired();

        bytes32 digest = keccak256(
            abi.encode(block.chainid, address(this), trancheId, msg.sender, shares, senior, payout, deadline)
        );
        if (digest.toEthSignedMessageHash().recover(sig) != owner()) revert BadQuote();
        if (payout > mmReserve) revert ReserveTooLow();

        if (senior) {
            uint256 bal = _senior[trancheId][msg.sender];
            if (shares > bal) revert InsufficientShares();
            _senior[trancheId][msg.sender] = bal - shares;
            _senior[trancheId][owner()] += shares; // MM warehouses; redeems at settlement
        } else {
            uint256 bal = _junior[trancheId][msg.sender];
            if (shares > bal) revert InsufficientShares();
            _junior[trancheId][msg.sender] = bal - shares;
            _junior[trancheId][owner()] += shares;
        }
        mmReserve -= payout;
        if (payout > 0) usdc.safeTransfer(msg.sender, payout);
        emit SoldToMM(trancheId, msg.sender, senior, shares, payout);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function trancheCount() external view returns (uint256) {
        return _tranches.length;
    }

    function getTranche(uint256 trancheId) external view returns (Tranche memory) {
        return _tranche(trancheId);
    }

    function getLegs(uint256 trancheId) external view returns (Leg[] memory) {
        if (trancheId >= _tranches.length) revert UnknownTranche();
        return _legs[trancheId];
    }

    function sharesOf(uint256 trancheId, address user) external view returns (uint256 senior, uint256 junior) {
        if (trancheId >= _tranches.length) revert UnknownTranche();
        return (_senior[trancheId][user], _junior[trancheId][user]);
    }

    function _tranche(uint256 trancheId) private view returns (Tranche storage) {
        if (trancheId >= _tranches.length) revert UnknownTranche();
        return _tranches[trancheId];
    }
}
