// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PredictionMarket} from "./PredictionMarket.sol";

/// @title Cumulant BasketVault
/// @notice A native structured product: a basket bundles several PredictionMarket legs
///         at fixed weights. Depositors stake USDC once; the vault atomically buys every
///         leg on-chain and credits the depositor basket shares proportional to capital
///         contributed. After every leg resolves, the basket is settled (winning legs are
///         claimed into the vault) and shareholders redeem their pro-rata slice of the
///         recovered USDC.
/// @dev    Within this contract each market may back at most one basket, so the vault's position
///         in a market belongs entirely to a single basket and settlement claims each leg exactly
///         once with no attribution math. (A market may independently back products in the other
///         vault contracts — each is a distinct on-chain trader, so that is safe.) Basket creation
///         is owner-curated to prevent griefers from permanently squatting markets via the
///         per-market reservation; participation (deposit/settle/redeem) is permissionless. Shares
///         are internal accounting (not yet an ERC-1155); tokenizing them is a documented v2 step.
contract BasketVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    uint16 internal constant BPS = 10_000;
    uint256 internal constant MAX_LEGS = 40;

    struct Leg {
        uint256 marketId;
        PredictionMarket.Side side;
        uint16 weightBps;
    }

    struct Basket {
        string name;
        uint256 totalShares; // 1 share == 1 USDC base unit deposited
        uint256 recovered; // USDC claimed into the vault at settlement
        bool settled;
        address creator;
    }

    IERC20 public immutable usdc;
    PredictionMarket public immutable market;

    Basket[] private _baskets;
    mapping(uint256 => Leg[]) private _legs; // basketId => legs
    mapping(uint256 => mapping(address => uint256)) private _shares; // basketId => user => shares
    mapping(uint256 => bool) public marketAssigned; // marketId => already backs a basket

    /// USDC the protocol market-maker has posted to buy positions back before settlement.
    uint256 public mmReserve;

    event BasketCreated(uint256 indexed basketId, address indexed creator, string name, uint256 legCount);
    event Deposited(uint256 indexed basketId, address indexed depositor, uint256 amount, uint256 sharesMinted);
    event Settled(uint256 indexed basketId, uint256 recovered, uint256 totalShares);
    event Redeemed(uint256 indexed basketId, address indexed redeemer, uint256 shares, uint256 payout);
    event MmReserveFunded(address indexed from, uint256 amount, uint256 reserve);
    event SoldToMM(uint256 indexed basketId, address indexed seller, uint256 shares, uint256 payout);

    error LengthMismatch();
    error NoLegs();
    error BadWeights();
    error MarketTaken(uint256 marketId);
    error MarketResolvedAlready(uint256 marketId);
    error UnknownBasket();
    error ZeroAmount();
    error AlreadySettled();
    error NotAllResolved();
    error NotSettled();
    error InsufficientShares();
    error TooManyLegs();
    error EmptyName();
    error DepositTooSmall();
    error BadQuote();
    error ReserveTooLow();
    error QuoteExpired();

    constructor(PredictionMarket market_) Ownable(msg.sender) {
        market = market_;
        usdc = market_.usdc();
        // The vault is the on-chain trader for every basket; pre-approve the market once.
        usdc.forceApprove(address(market_), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Basket creation
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Create a basket from existing, unresolved markets. Owner-curated; weights must
    ///         sum to 10000 and at most MAX_LEGS legs are allowed.
    /// @param name       Display name for the basket.
    /// @param marketIds  PredictionMarket ids for each leg.
    /// @param sides      Side (Yes/No) bought for each leg.
    /// @param weightsBps Capital weight per leg in basis points; must total 10000.
    function createBasket(
        string calldata name,
        uint256[] calldata marketIds,
        PredictionMarket.Side[] calldata sides,
        uint16[] calldata weightsBps
    ) external onlyOwner returns (uint256 basketId) {
        uint256 n = marketIds.length;
        if (n == 0) revert NoLegs();
        if (n > MAX_LEGS) revert TooManyLegs();
        if (bytes(name).length == 0) revert EmptyName();
        if (sides.length != n || weightsBps.length != n) revert LengthMismatch();

        uint256 weightSum;
        for (uint256 i; i < n; ++i) {
            uint256 marketId = marketIds[i];
            if (marketAssigned[marketId]) revert MarketTaken(marketId);
            // Touches the market to assert it exists and is still open/unresolved.
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

        basketId = _baskets.length;
        _baskets.push(Basket({name: name, totalShares: 0, recovered: 0, settled: false, creator: msg.sender}));
        for (uint256 i; i < n; ++i) {
            _legs[basketId].push(Leg({marketId: marketIds[i], side: sides[i], weightBps: weightsBps[i]}));
        }
        emit BasketCreated(basketId, msg.sender, name, n);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Deposit / settle / redeem
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Deposit USDC into a basket. The vault splits the deposit across legs by
    ///         weight and buys each on-chain in a single transaction. Caller must have
    ///         approved this vault for `amount` USDC.
    /// @return sharesMinted Shares credited (equal to `amount`).
    function deposit(uint256 basketId, uint256 amount) external nonReentrant returns (uint256 sharesMinted) {
        Basket storage b = _basket(basketId);
        if (amount == 0) revert ZeroAmount();
        if (b.settled) revert AlreadySettled();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        Leg[] storage legs = _legs[basketId];
        uint256 n = legs.length;
        uint256 spent;
        for (uint256 i; i < n; ++i) {
            // Last leg absorbs the rounding remainder so the full deposit is allocated.
            uint256 legAmount = i == n - 1 ? amount - spent : (amount * legs[i].weightBps) / BPS;
            // Every leg must receive a non-zero allocation, otherwise a tiny deposit would skip
            // legs while still minting full shares — silently re-weighting the basket and letting
            // depositors cross-subsidize. Reverting enforces a sane minimum deposit.
            if (legAmount == 0) revert DepositTooSmall();
            spent += legAmount;
            market.buy(legs[i].marketId, legs[i].side, legAmount);
        }

        sharesMinted = amount;
        _shares[basketId][msg.sender] += sharesMinted;
        b.totalShares += sharesMinted;
        emit Deposited(basketId, msg.sender, amount, sharesMinted);
    }

    /// @notice Settle a basket once all legs are resolved (or voided). Claims whatever each leg
    ///         yields — a win, or a void/no-winner refund — into the vault. Permissionless.
    /// @dev    `settled` is flipped before the external claim loop (reentrancy defense-in-depth).
    ///         Each leg's claim is wrapped in try/catch so legs the vault did not win (which
    ///         revert `NothingToClaim`) are simply skipped, and so a single leg can't block
    ///         settlement; voided legs return the vault's stake via the refund path.
    function settle(uint256 basketId) external nonReentrant {
        Basket storage b = _basket(basketId);
        if (b.settled) revert AlreadySettled();
        b.settled = true;

        Leg[] storage legs = _legs[basketId];
        uint256 n = legs.length;
        uint256 recovered;
        for (uint256 i; i < n; ++i) {
            if (!market.getMarket(legs[i].marketId).resolved) revert NotAllResolved();
            try market.claim(legs[i].marketId) returns (uint256 payout) {
                recovered += payout;
            } catch {
                // Nothing claimable for this leg (lost side) — skip.
            }
        }

        b.recovered = recovered;
        emit Settled(basketId, recovered, b.totalShares);
    }

    /// @notice Redeem basket shares for a pro-rata slice of the recovered USDC.
    function redeem(uint256 basketId, uint256 shares) external nonReentrant returns (uint256 payout) {
        Basket storage b = _basket(basketId);
        if (!b.settled) revert NotSettled();
        uint256 bal = _shares[basketId][msg.sender];
        if (shares == 0) revert ZeroAmount();
        if (shares > bal) revert InsufficientShares();

        // Pro-rata against the share supply frozen at settlement.
        payout = (b.recovered * shares) / b.totalShares;
        _shares[basketId][msg.sender] = bal - shares;
        if (payout > 0) {
            usdc.safeTransfer(msg.sender, payout);
        }
        emit Redeemed(basketId, msg.sender, shares, payout);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Secondary market — sell back to the protocol market-maker pre-settlement
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Post USDC liquidity the market-maker uses to buy positions back before
    ///         settlement. Tracked separately from settled `recovered` so a sell can
    ///         never dip into shareholders' redeemable funds.
    function fundMmReserve(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        mmReserve += amount;
        emit MmReserveFunded(msg.sender, amount, mmReserve);
    }

    /// @notice Sell basket shares back to the protocol market-maker BEFORE settlement at a
    ///         price the MM (owner) signed off-chain. The MM warehouses the position (it
    ///         receives the shares and redeems them at settlement); the seller is paid
    ///         immediately from the MM reserve. `payout` is USDC base units; the quote is
    ///         bound to (chain, vault, basket, seller, shares, payout, deadline) so it can't
    ///         be replayed for a different seller/size/price.
    function sellToMM(uint256 basketId, uint256 shares, uint256 payout, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
    {
        Basket storage b = _basket(basketId);
        if (b.settled) revert AlreadySettled();
        if (shares == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert QuoteExpired();
        uint256 bal = _shares[basketId][msg.sender];
        if (shares > bal) revert InsufficientShares();

        bytes32 digest =
            keccak256(abi.encode(block.chainid, address(this), basketId, msg.sender, shares, payout, deadline));
        if (digest.toEthSignedMessageHash().recover(sig) != owner()) revert BadQuote();
        if (payout > mmReserve) revert ReserveTooLow();

        _shares[basketId][msg.sender] = bal - shares;
        _shares[basketId][owner()] += shares; // MM warehouses; redeems pro-rata at settlement
        mmReserve -= payout;
        if (payout > 0) usdc.safeTransfer(msg.sender, payout);
        emit SoldToMM(basketId, msg.sender, shares, payout);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function basketCount() external view returns (uint256) {
        return _baskets.length;
    }

    function getBasket(uint256 basketId) external view returns (Basket memory) {
        return _basket(basketId);
    }

    function getLegs(uint256 basketId) external view returns (Leg[] memory) {
        if (basketId >= _baskets.length) revert UnknownBasket();
        return _legs[basketId];
    }

    function sharesOf(uint256 basketId, address user) external view returns (uint256) {
        if (basketId >= _baskets.length) revert UnknownBasket();
        return _shares[basketId][user];
    }

    /// @notice Estimated current basket value (USDC) if every leg resolved to its bought
    ///         side right now — a simple mark for UI. Not used in settlement.
    function markToWin(uint256 basketId) external view returns (uint256 value) {
        if (basketId >= _baskets.length) revert UnknownBasket();
        Leg[] storage legs = _legs[basketId];
        for (uint256 i; i < legs.length; ++i) {
            value += market.previewPayout(legs[i].marketId, address(this), legs[i].side);
        }
    }

    function _basket(uint256 basketId) private view returns (Basket storage) {
        if (basketId >= _baskets.length) revert UnknownBasket();
        return _baskets[basketId];
    }
}
