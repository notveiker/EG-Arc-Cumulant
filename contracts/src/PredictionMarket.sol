// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Cumulant PredictionMarket
/// @notice USDC-collateralized binary (YES/NO) prediction markets for the Cumulant
///         protocol on Circle Arc. Collateral is a configured ERC-20 (6 decimals) — this
///         Arc testnet deployment uses a freely-mintable Test USDC. Trading is wallet-signed; resolution is performed
///         by a trusted resolver (oracle/admin) because Arc's PREVRANDAO is always 0
///         and outcomes are real-world events, not on-chain randomness.
/// @dev    Parimutuel payout: a correct position always recovers its stake and earns
///         a pro-rata share of the losing pool. Across all winners the payouts sum to
///         exactly (winningStake + losingStake), so each market is fully solvent and
///         self-draining with no protocol fee in this v1.
contract PredictionMarket is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Side {
        None, // 0 — unset
        Yes, // 1
        No // 2
    }

    struct Market {
        string question;
        uint64 closeTime; // trading closes at this unix timestamp
        uint64 resolvedAt; // 0 until resolved
        Side outcome; // None until resolved (or if voided)
        bool resolved;
        bool voided; // true if settled with no winner (everyone refunded)
        address creator;
        uint256 yesStake; // total USDC staked YES
        uint256 noStake; // total USDC staked NO
    }

    struct Position {
        uint256 yes;
        uint256 no;
    }

    /// @notice Collateral token: canonical Arc testnet USDC (6 decimals).
    IERC20 public immutable usdc;

    /// @notice Address authorized to resolve markets (the protocol oracle/admin).
    address public resolver;

    Market[] private _markets;

    /// @dev marketId => trader => staked amounts per side.
    mapping(uint256 => mapping(address => Position)) private _positions;

    event ResolverUpdated(address indexed previous, address indexed current);
    event MarketCreated(uint256 indexed marketId, address indexed creator, string question, uint64 closeTime);
    event PositionBought(uint256 indexed marketId, address indexed trader, Side side, uint256 amount);
    event MarketResolved(uint256 indexed marketId, Side outcome, uint64 resolvedAt);
    event MarketVoided(uint256 indexed marketId, uint64 resolvedAt);
    event Claimed(uint256 indexed marketId, address indexed trader, Side side, uint256 stake, uint256 payout);

    error InvalidSide();
    error ZeroAmount();
    error UnknownMarket();
    error TradingClosed();
    error TradingNotClosed();
    error AlreadyResolved();
    error NotResolved();
    error NotResolver();
    error CloseTimeInPast();
    error EmptyQuestion();
    error NothingToClaim();

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    /// @param usdc_     Arc USDC address (0x3600...0000 on testnet).
    /// @param resolver_ Initial resolver (oracle/admin); typically the deployer.
    constructor(IERC20 usdc_, address resolver_) Ownable(msg.sender) {
        require(address(usdc_) != address(0), "usdc=0");
        require(resolver_ != address(0), "resolver=0");
        usdc = usdc_;
        resolver = resolver_;
        emit ResolverUpdated(address(0), resolver_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Update the trusted resolver. Owner-controlled so resolution authority
    ///         can move to a multisig/oracle without redeploying.
    function setResolver(address resolver_) external onlyOwner {
        require(resolver_ != address(0), "resolver=0");
        emit ResolverUpdated(resolver, resolver_);
        resolver = resolver_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Market lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Permissionlessly create a binary market. Anyone may propose a market;
    ///         only the resolver can settle it, so creation carries no trust.
    /// @param question  Human-readable market question.
    /// @param closeTime Unix timestamp after which trading is closed.
    /// @return marketId Index of the new market.
    function createMarket(string calldata question, uint64 closeTime) external returns (uint256 marketId) {
        if (bytes(question).length == 0) revert EmptyQuestion();
        if (closeTime <= block.timestamp) revert CloseTimeInPast();
        marketId = _markets.length;
        _markets.push(
            Market({
                question: question,
                closeTime: closeTime,
                resolvedAt: 0,
                outcome: Side.None,
                resolved: false,
                voided: false,
                creator: msg.sender,
                yesStake: 0,
                noStake: 0
            })
        );
        emit MarketCreated(marketId, msg.sender, question, closeTime);
    }

    /// @notice Buy into a market on a chosen side by staking USDC. Wallet-signed;
    ///         the trader must have approved this contract for `amount` of USDC.
    function buy(uint256 marketId, Side side, uint256 amount) external nonReentrant {
        Market storage m = _market(marketId);
        if (side != Side.Yes && side != Side.No) revert InvalidSide();
        if (amount == 0) revert ZeroAmount();
        if (m.resolved) revert AlreadyResolved();
        if (block.timestamp >= m.closeTime) revert TradingClosed();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        Position storage p = _positions[marketId][msg.sender];
        if (side == Side.Yes) {
            m.yesStake += amount;
            p.yes += amount;
        } else {
            m.noStake += amount;
            p.no += amount;
        }
        emit PositionBought(marketId, msg.sender, side, amount);
    }

    /// @notice Resolve a market to a final outcome. Resolver-only. Resolution is only allowed
    ///         once trading has closed, which removes any window where the resolver (or a
    ///         front-runner watching a `resolve` tx) could trade against a known outcome.
    function resolve(uint256 marketId, Side outcome) external onlyResolver {
        Market storage m = _market(marketId);
        if (m.resolved) revert AlreadyResolved();
        if (block.timestamp < m.closeTime) revert TradingNotClosed();
        if (outcome != Side.Yes && outcome != Side.No) revert InvalidSide();
        m.resolved = true;
        m.outcome = outcome;
        m.resolvedAt = uint64(block.timestamp);
        emit MarketResolved(marketId, outcome, m.resolvedAt);
    }

    /// @notice Void a market: settles it with no winner so every participant can reclaim their
    ///         own stake. The liveness escape hatch for markets whose real-world outcome is
    ///         cancelled, ambiguous, or otherwise unresolvable — guarantees funds are never
    ///         permanently locked behind an un-resolvable leg. Resolver-only.
    function voidMarket(uint256 marketId) external onlyResolver {
        Market storage m = _market(marketId);
        if (m.resolved) revert AlreadyResolved();
        m.resolved = true;
        m.voided = true;
        m.resolvedAt = uint64(block.timestamp);
        emit MarketVoided(marketId, m.resolvedAt);
    }

    /// @notice Claim from a resolved market. The winning side gets its stake plus a pro-rata
    ///         share of the losing pool. If the market is voided, or resolved to a side that
    ///         nobody staked (no winner), every participant instead reclaims their own stake in
    ///         full — so collateral is never burned or stranded. Idempotent: the claimed
    ///         position is zeroed so it cannot be claimed twice.
    /// @return payout USDC transferred to the caller.
    function claim(uint256 marketId) external nonReentrant returns (uint256 payout) {
        Market storage m = _market(marketId);
        if (!m.resolved) revert NotResolved();

        Position storage p = _positions[marketId][msg.sender];

        // Refund mode: voided, or resolved to a side with zero stake (no winner exists).
        bool noWinner =
            m.voided || (m.outcome == Side.Yes && m.yesStake == 0) || (m.outcome == Side.No && m.noStake == 0);
        if (noWinner) {
            uint256 refund = p.yes + p.no;
            if (refund == 0) revert NothingToClaim();
            p.yes = 0;
            p.no = 0;
            usdc.safeTransfer(msg.sender, refund);
            emit Claimed(marketId, msg.sender, m.outcome, refund, refund);
            return refund;
        }

        uint256 stake;
        uint256 winningStake;
        uint256 losingStake;
        if (m.outcome == Side.Yes) {
            stake = p.yes;
            if (stake == 0) revert NothingToClaim();
            p.yes = 0;
            winningStake = m.yesStake;
            losingStake = m.noStake;
        } else {
            stake = p.no;
            if (stake == 0) revert NothingToClaim();
            p.no = 0;
            winningStake = m.noStake;
            losingStake = m.yesStake;
        }

        // payout = stake + stake * losingStake / winningStake  (parimutuel)
        payout = stake + _prorata(stake, winningStake, losingStake);
        usdc.safeTransfer(msg.sender, payout);
        emit Claimed(marketId, msg.sender, m.outcome, stake, payout);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _market(marketId);
    }

    function getPosition(uint256 marketId, address trader) external view returns (Position memory) {
        if (marketId >= _markets.length) revert UnknownMarket();
        return _positions[marketId][trader];
    }

    /// @notice Implied YES probability in basis points (0..10000), or 5000 if no stake.
    function impliedYesBps(uint256 marketId) external view returns (uint256) {
        Market storage m = _market(marketId);
        uint256 total = m.yesStake + m.noStake;
        if (total == 0) return 5000;
        return (m.yesStake * 10_000) / total;
    }

    /// @notice Previews the payout a trader would receive if the market resolved to
    ///         `outcome` right now. Pure view; does not require resolution.
    function previewPayout(uint256 marketId, address trader, Side outcome) external view returns (uint256) {
        Market storage m = _market(marketId);
        Position storage p = _positions[marketId][trader];
        if (outcome == Side.Yes) {
            if (p.yes == 0) return 0;
            return p.yes + _prorata(p.yes, m.yesStake, m.noStake);
        } else if (outcome == Side.No) {
            if (p.no == 0) return 0;
            return p.no + _prorata(p.no, m.noStake, m.yesStake);
        }
        return 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────────────────

    function _market(uint256 marketId) private view returns (Market storage) {
        if (marketId >= _markets.length) revert UnknownMarket();
        return _markets[marketId];
    }

    /// @dev Pro-rata reward (excludes the original stake). Returns 0 if either side is
    ///      empty, which also means a one-sided market simply refunds winners' stakes.
    function _prorata(uint256 stake, uint256 winningStake, uint256 losingStake) private pure returns (uint256) {
        if (winningStake == 0 || losingStake == 0) return 0;
        return (stake * losingStake) / winningStake;
    }
}
