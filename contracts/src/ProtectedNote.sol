// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PredictionMarket} from "./PredictionMarket.sol";

/// @title Cumulant ProtectedNote
/// @notice A principal-protected note over a single prediction market. Depositors always get
///         their full principal back; on top of that they share a convex "coupon" if the market
///         resolves to the note's favored side. The upside is funded entirely by the note's
///         issuer, so principal is never deployed and never at risk.
/// @dev    Economics (no free lunch — the issuer pays for the upside):
///           - issuer commits `issuerUpside` USDC at creation; the note buys the favored side
///             with it once, up front.
///           - depositor principal is held 100% in reserve, never spent.
///           - at settlement the note claims its position: if the side won, the claim
///             (issuer stake + winnings) becomes the shared coupon; if it lost, coupon = 0 and
///             the issuer simply forfeited its upside budget.
///           - redeem pays principal + coupon * principal / totalPrincipal.
///         Reserve always covers principal, so redemption is solvent in every outcome. One
///         market backs at most one note (single on-chain position, claimed once).
contract ProtectedNote is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    struct Note {
        string name;
        uint256 marketId;
        PredictionMarket.Side side; // favored outcome that pays the coupon
        uint256 issuerUpside; // USDC the issuer staked on the upside position
        uint256 principal; // total depositor principal (fully reserved)
        uint256 coupon; // upside recovered at settlement
        bool settled;
        address issuer;
    }

    IERC20 public immutable usdc;
    PredictionMarket public immutable market;

    Note[] private _notes;
    mapping(uint256 => mapping(address => uint256)) private _principal; // noteId => user => principal
    mapping(uint256 => bool) public marketAssigned;

    event NoteCreated(
        uint256 indexed noteId,
        address indexed issuer,
        uint256 marketId,
        PredictionMarket.Side side,
        uint256 issuerUpside
    );
    event Deposited(uint256 indexed noteId, address indexed user, uint256 principal);
    event Settled(uint256 indexed noteId, uint256 coupon);
    event Redeemed(uint256 indexed noteId, address indexed user, uint256 principal, uint256 coupon);
    event Reclaimed(uint256 indexed noteId, address indexed issuer, uint256 amount);

    error MarketTaken(uint256 marketId);
    error MarketResolvedAlready(uint256 marketId);
    error InvalidSide();
    error ZeroUpside();
    error ZeroAmount();
    error EmptyName();
    error UnknownNote();
    error AlreadySettled();
    error NotResolved();
    error NotSettled();
    error MarketClosed();
    error NothingDeposited();
    error NotIssuer();
    error HasDepositors();
    error NothingToReclaim();

    constructor(PredictionMarket market_) Ownable(msg.sender) {
        market = market_;
        usdc = market_.usdc();
        usdc.forceApprove(address(market_), type(uint256).max);
    }

    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Create a note. Owner-curated; the issuer funds and opens the upside up front.
    function createNote(string calldata name, uint256 marketId, PredictionMarket.Side side, uint256 issuerUpside)
        external
        onlyOwner
        nonReentrant
        returns (uint256 noteId)
    {
        if (marketAssigned[marketId]) revert MarketTaken(marketId);
        if (bytes(name).length == 0) revert EmptyName();
        if (side != PredictionMarket.Side.Yes && side != PredictionMarket.Side.No) {
            revert InvalidSide();
        }
        if (issuerUpside == 0) revert ZeroUpside();
        PredictionMarket.Market memory m = market.getMarket(marketId);
        if (m.resolved) revert MarketResolvedAlready(marketId);

        marketAssigned[marketId] = true;
        usdc.safeTransferFrom(msg.sender, address(this), issuerUpside);
        market.buy(marketId, side, issuerUpside); // upside funded by the issuer only

        noteId = _notes.length;
        _notes.push(
            Note({
                name: name,
                marketId: marketId,
                side: side,
                issuerUpside: issuerUpside,
                principal: 0,
                coupon: 0,
                settled: false,
                issuer: msg.sender
            })
        );
        emit NoteCreated(noteId, msg.sender, marketId, side, issuerUpside);
    }

    /// @notice Deposit principal into a note. Principal is reserved 1:1 and never deployed.
    function deposit(uint256 noteId, uint256 amount) external nonReentrant {
        Note storage note = _note(noteId);
        if (amount == 0) revert ZeroAmount();
        if (note.settled) revert AlreadySettled();
        PredictionMarket.Market memory m = market.getMarket(note.marketId);
        if (m.resolved) revert MarketClosed();

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _principal[noteId][msg.sender] += amount;
        note.principal += amount;
        emit Deposited(noteId, msg.sender, amount);
    }

    /// @notice Settle once the market resolves (or is voided): claim the upside into the shared
    ///         coupon. `settled` is set before the external claim (reentrancy defense-in-depth);
    ///         the claim is wrapped in try/catch so a losing upside (NothingToClaim) settles to a
    ///         zero coupon without reverting. Principal is unaffected in every branch.
    function settle(uint256 noteId) external nonReentrant {
        Note storage note = _note(noteId);
        if (note.settled) revert AlreadySettled();
        if (!market.getMarket(note.marketId).resolved) revert NotResolved();
        note.settled = true;

        uint256 coupon;
        try market.claim(note.marketId) returns (uint256 payout) {
            coupon = payout;
        } catch {
            // upside lost — no coupon, principal still fully protected
        }
        note.coupon = coupon;
        emit Settled(noteId, coupon);
    }

    /// @notice Redeem principal (always) plus a pro-rata slice of the coupon.
    function redeem(uint256 noteId) external nonReentrant returns (uint256 payout) {
        Note storage note = _note(noteId);
        if (!note.settled) revert NotSettled();
        uint256 principal = _principal[noteId][msg.sender];
        if (principal == 0) revert NothingDeposited();

        uint256 couponShare = note.principal == 0 ? 0 : (note.coupon * principal) / note.principal;
        payout = principal + couponShare;
        _principal[noteId][msg.sender] = 0;
        usdc.safeTransfer(msg.sender, payout);
        emit Redeemed(noteId, msg.sender, principal, couponShare);
    }

    /// @notice Recover the coupon of a settled note that received no deposits. Without this, an
    ///         issuer-funded upside that wins but attracts no depositors would be stranded
    ///         (no principal base to distribute against). Issuer-only.
    function reclaim(uint256 noteId) external nonReentrant returns (uint256 amount) {
        Note storage note = _note(noteId);
        if (!note.settled) revert NotSettled();
        if (msg.sender != note.issuer) revert NotIssuer();
        if (note.principal != 0) revert HasDepositors();
        amount = note.coupon;
        if (amount == 0) revert NothingToReclaim();
        note.coupon = 0;
        usdc.safeTransfer(note.issuer, amount);
        emit Reclaimed(noteId, note.issuer, amount);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function noteCount() external view returns (uint256) {
        return _notes.length;
    }

    function getNote(uint256 noteId) external view returns (Note memory) {
        return _note(noteId);
    }

    function principalOf(uint256 noteId, address user) external view returns (uint256) {
        if (noteId >= _notes.length) revert UnknownNote();
        return _principal[noteId][user];
    }

    /// @notice Live coupon estimate (USDC) if the market resolved to the note's side now.
    function projectedCoupon(uint256 noteId) external view returns (uint256) {
        Note storage note = _note(noteId);
        return market.previewPayout(note.marketId, address(this), note.side);
    }

    function _note(uint256 noteId) private view returns (Note storage) {
        if (noteId >= _notes.length) revert UnknownNote();
        return _notes[noteId];
    }
}
