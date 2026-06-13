// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {ProtectedNote} from "../src/ProtectedNote.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract ProtectedNoteTest is Test {
    MockUSDC usdc;
    PredictionMarket pm;
    ProtectedNote notes;

    // The test contract is the resolver + owner/issuer of the notes.
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address ext = makeAddr("ext");
    address stranger = makeAddr("stranger");

    uint256 constant USDC1 = 1e6;
    uint64 closeTime;

    function setUp() public {
        usdc = new MockUSDC();
        pm = new PredictionMarket(usdc, address(this));
        notes = new ProtectedNote(pm);
        closeTime = uint64(block.timestamp + 1 days);

        // issuer = this test contract
        usdc.mint(address(this), 10_000 * USDC1);
        usdc.approve(address(notes), type(uint256).max);

        address[3] memory users = [alice, bob, ext];
        for (uint256 i; i < users.length; ++i) {
            usdc.mint(users[i], 10_000 * USDC1);
            vm.prank(users[i]);
            usdc.approve(address(notes), type(uint256).max);
            vm.prank(users[i]);
            usdc.approve(address(pm), type(uint256).max);
        }
    }

    function _resolve(uint256 id, PredictionMarket.Side side) internal {
        if (block.timestamp < closeTime) vm.warp(closeTime);
        pm.resolve(id, side);
    }

    function _note(uint256 upside) internal returns (uint256 id, uint256 m0) {
        m0 = pm.createMarket("Will ETH 2x?", closeTime);
        id = notes.createNote("ETH Upside Note", m0, PredictionMarket.Side.Yes, upside * USDC1);
    }

    function test_CreateBuysIssuerUpside() public {
        (, uint256 m0) = _note(50);
        assertEq(pm.getPosition(m0, address(notes)).yes, 50 * USDC1);
        assertEq(usdc.balanceOf(address(notes)), 0);
    }

    function test_PrincipalPlusCoupon_OnWin() public {
        (uint256 id, uint256 m0) = _note(50);
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 50 * USDC1);

        vm.prank(alice);
        notes.deposit(id, 100 * USDC1);
        assertEq(usdc.balanceOf(address(notes)), 100 * USDC1);

        _resolve(m0, PredictionMarket.Side.Yes);
        notes.settle(id);
        assertEq(notes.getNote(id).coupon, 100 * USDC1);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        assertEq(notes.redeem(id), 200 * USDC1);
        assertEq(usdc.balanceOf(alice) - before, 200 * USDC1);
    }

    function test_PrincipalProtected_OnLoss() public {
        (uint256 id, uint256 m0) = _note(50);
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 50 * USDC1); // real NO winner so YES truly loses
        vm.prank(alice);
        notes.deposit(id, 100 * USDC1);

        _resolve(m0, PredictionMarket.Side.No);
        notes.settle(id);
        assertEq(notes.getNote(id).coupon, 0);

        vm.prank(alice);
        assertEq(notes.redeem(id), 100 * USDC1);
    }

    /// Deposits are refused once the underlying market's trading window closes,
    /// so no one can enter risk-free after the outcome is observable and skim coupon.
    function test_RevertWhen_DepositAfterClose() public {
        (uint256 id, uint256 m0) = _note(50);
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 50 * USDC1);
        vm.warp(closeTime);
        vm.prank(alice);
        vm.expectRevert(ProtectedNote.MarketClosed.selector);
        notes.deposit(id, 100 * USDC1);
    }

    function test_CouponSplitProRata() public {
        (uint256 id, uint256 m0) = _note(60);
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 60 * USDC1);

        vm.prank(alice);
        notes.deposit(id, 100 * USDC1);
        vm.prank(bob);
        notes.deposit(id, 300 * USDC1);

        _resolve(m0, PredictionMarket.Side.Yes);
        notes.settle(id);
        uint256 coupon = notes.getNote(id).coupon;
        assertEq(coupon, 120 * USDC1);

        vm.prank(alice);
        assertEq(notes.redeem(id), 100 * USDC1 + (coupon * 100) / 400);
        vm.prank(bob);
        assertEq(notes.redeem(id), 300 * USDC1 + (coupon * 300) / 400);
    }

    /// Issuer recovers an orphaned coupon when a winning note attracted no depositors.
    function test_IssuerReclaimsOrphanedCoupon() public {
        (uint256 id, uint256 m0) = _note(50);
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 50 * USDC1);
        // nobody deposits
        _resolve(m0, PredictionMarket.Side.Yes);
        notes.settle(id);
        assertEq(notes.getNote(id).coupon, 100 * USDC1);

        uint256 before = usdc.balanceOf(address(this));
        uint256 amount = notes.reclaim(id);
        assertEq(amount, 100 * USDC1);
        assertEq(usdc.balanceOf(address(this)) - before, 100 * USDC1);
    }

    /// Void refunds the note's position; principal stays protected (depositor ≥ principal).
    function test_VoidKeepsPrincipalProtected() public {
        (uint256 id, uint256 m0) = _note(50);
        vm.prank(alice);
        notes.deposit(id, 100 * USDC1);

        vm.warp(closeTime);
        pm.voidMarket(m0);
        notes.settle(id);

        vm.prank(alice);
        uint256 payout = notes.redeem(id);
        assertGe(payout, 100 * USDC1); // principal fully protected
    }

    function testFuzz_NeverBelowPrincipal(uint96 principal, uint96 upside, bool yesWins) public {
        principal = uint96(bound(principal, 1, 5_000 * USDC1));
        upside = uint96(bound(upside, 1, 5_000 * USDC1));
        usdc.mint(alice, principal);

        uint256 m0 = pm.createMarket("fuzz", closeTime);
        uint256 id = notes.createNote("n", m0, PredictionMarket.Side.Yes, upside);

        vm.startPrank(alice);
        usdc.approve(address(notes), principal);
        notes.deposit(id, principal);
        vm.stopPrank();

        _resolve(m0, yesWins ? PredictionMarket.Side.Yes : PredictionMarket.Side.No);
        notes.settle(id);
        vm.prank(alice);
        assertGe(notes.redeem(id), principal);
    }

    // ── Reverts ───────────────────────────────────────────────────────────────

    function test_RevertWhen_CreateNotOwner() public {
        uint256 m0 = pm.createMarket("z", closeTime);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        notes.createNote("z", m0, PredictionMarket.Side.Yes, 10 * USDC1);
    }

    function test_RevertWhen_MarketTaken() public {
        (, uint256 m0) = _note(50);
        vm.expectRevert(abi.encodeWithSelector(ProtectedNote.MarketTaken.selector, m0));
        notes.createNote("dup", m0, PredictionMarket.Side.Yes, 10 * USDC1);
    }

    function test_RevertWhen_ZeroUpside() public {
        uint256 m0 = pm.createMarket("z", closeTime);
        vm.expectRevert(ProtectedNote.ZeroUpside.selector);
        notes.createNote("z", m0, PredictionMarket.Side.Yes, 0);
    }

    function test_RevertWhen_ReclaimWithDepositors() public {
        (uint256 id, uint256 m0) = _note(50);
        vm.prank(alice);
        notes.deposit(id, 100 * USDC1);
        _resolve(m0, PredictionMarket.Side.No);
        notes.settle(id);
        vm.expectRevert(ProtectedNote.HasDepositors.selector);
        notes.reclaim(id);
    }

    function test_RevertWhen_SettleBeforeResolved() public {
        (uint256 id,) = _note(50);
        vm.prank(alice);
        notes.deposit(id, 100 * USDC1);
        vm.expectRevert(ProtectedNote.NotResolved.selector);
        notes.settle(id);
    }

    function test_RevertWhen_RedeemBeforeSettle() public {
        (uint256 id,) = _note(50);
        vm.prank(alice);
        notes.deposit(id, 100 * USDC1);
        vm.prank(alice);
        vm.expectRevert(ProtectedNote.NotSettled.selector);
        notes.redeem(id);
    }
}
