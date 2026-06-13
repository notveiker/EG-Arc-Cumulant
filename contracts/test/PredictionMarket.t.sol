// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PredictionMarketTest is Test {
    MockUSDC usdc;
    PredictionMarket pm;

    address resolver = makeAddr("resolver");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant USDC1 = 1e6; // $1
    uint64 closeTime;

    function setUp() public {
        usdc = new MockUSDC();
        pm = new PredictionMarket(usdc, resolver);
        closeTime = uint64(block.timestamp + 1 days);

        for (uint256 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            usdc.mint(u, 1_000 * USDC1);
            vm.prank(u);
            usdc.approve(address(pm), type(uint256).max);
        }
    }

    function _market() internal returns (uint256 id) {
        id = pm.createMarket("Will it rain tomorrow?", closeTime);
    }

    /// Resolution is only allowed after trading closes — warp first.
    function _resolve(uint256 id, PredictionMarket.Side side) internal {
        if (block.timestamp < closeTime) vm.warp(closeTime);
        vm.prank(resolver);
        pm.resolve(id, side);
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    function test_CreateMarket() public {
        uint256 id = _market();
        assertEq(id, 0);
        assertEq(pm.marketCount(), 1);
        PredictionMarket.Market memory m = pm.getMarket(id);
        assertEq(m.question, "Will it rain tomorrow?");
        assertEq(m.closeTime, closeTime);
        assertFalse(m.resolved);
        assertFalse(m.voided);
        assertEq(uint8(m.outcome), uint8(PredictionMarket.Side.None));
    }

    function test_BuyUpdatesStakeAndPosition() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);

        PredictionMarket.Market memory m = pm.getMarket(id);
        assertEq(m.yesStake, 100 * USDC1);
        assertEq(m.noStake, 0);
        assertEq(pm.getPosition(id, alice).yes, 100 * USDC1);
        assertEq(usdc.balanceOf(address(pm)), 100 * USDC1);
    }

    function test_ImpliedProbability() public {
        uint256 id = _market();
        assertEq(pm.impliedYesBps(id), 5000);
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 75 * USDC1);
        vm.prank(bob);
        pm.buy(id, PredictionMarket.Side.No, 25 * USDC1);
        assertEq(pm.impliedYesBps(id), 7500);
    }

    function test_ResolveAndClaim_SingleWinner() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        vm.prank(bob);
        pm.buy(id, PredictionMarket.Side.No, 300 * USDC1);

        _resolve(id, PredictionMarket.Side.Yes);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 payout = pm.claim(id);
        assertEq(payout, 400 * USDC1);
        assertEq(usdc.balanceOf(alice) - before, 400 * USDC1);
        assertEq(usdc.balanceOf(address(pm)), 0);
    }

    function test_ResolveAndClaim_ProRataSplit() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        vm.prank(carol);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        vm.prank(bob);
        pm.buy(id, PredictionMarket.Side.No, 200 * USDC1);

        _resolve(id, PredictionMarket.Side.Yes);

        vm.prank(alice);
        assertEq(pm.claim(id), 200 * USDC1);
        vm.prank(carol);
        assertEq(pm.claim(id), 200 * USDC1);
        assertEq(usdc.balanceOf(address(pm)), 0);
    }

    function test_OneSidedMarketRefundsWinners() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        _resolve(id, PredictionMarket.Side.Yes);
        vm.prank(alice);
        assertEq(pm.claim(id), 100 * USDC1);
    }

    function test_PreviewPayout() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        vm.prank(bob);
        pm.buy(id, PredictionMarket.Side.No, 300 * USDC1);
        assertEq(pm.previewPayout(id, alice, PredictionMarket.Side.Yes), 400 * USDC1);
        assertEq(pm.previewPayout(id, bob, PredictionMarket.Side.No), 400 * USDC1);
    }

    function test_SetResolver() public {
        address newResolver = makeAddr("newResolver");
        pm.setResolver(newResolver);
        assertEq(pm.resolver(), newResolver);
    }

    // ── Hardening: void / no-winner refunds ─────────────────────────────────────

    /// A voided market refunds every participant their own stake in full.
    function test_VoidMarketRefundsEveryone() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        vm.prank(bob);
        pm.buy(id, PredictionMarket.Side.No, 50 * USDC1);

        vm.warp(closeTime);
        vm.prank(resolver);
        pm.voidMarket(id);
        assertTrue(pm.getMarket(id).voided);

        vm.prank(alice);
        assertEq(pm.claim(id), 100 * USDC1);
        vm.prank(bob);
        assertEq(pm.claim(id), 50 * USDC1);
        assertEq(usdc.balanceOf(address(pm)), 0);
    }

    /// Resolving to a side nobody staked refunds the losers instead of burning the pool.
    function test_NoWinnerSideRefundsLosers() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1); // only YES staked
        _resolve(id, PredictionMarket.Side.No); // resolves to empty NO side

        vm.prank(alice);
        assertEq(pm.claim(id), 100 * USDC1); // refunded, pool not burned
        assertEq(usdc.balanceOf(address(pm)), 0);
    }

    function test_VoidCanHappenBeforeClose() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 10 * USDC1);
        vm.prank(resolver); // no warp — void allowed anytime (cancelled events)
        pm.voidMarket(id);
        vm.prank(alice);
        assertEq(pm.claim(id), 10 * USDC1);
    }

    // ── Reverts ───────────────────────────────────────────────────────────────

    function test_RevertWhen_CreateEmptyQuestion() public {
        vm.expectRevert(PredictionMarket.EmptyQuestion.selector);
        pm.createMarket("", closeTime);
    }

    function test_RevertWhen_CreateClosePast() public {
        vm.expectRevert(PredictionMarket.CloseTimeInPast.selector);
        pm.createMarket("late", uint64(block.timestamp));
    }

    function test_RevertWhen_ResolveBeforeClose() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 1 * USDC1);
        vm.prank(resolver);
        vm.expectRevert(PredictionMarket.TradingNotClosed.selector);
        pm.resolve(id, PredictionMarket.Side.Yes);
    }

    function test_RevertWhen_BuyInvalidSide() public {
        uint256 id = _market();
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.InvalidSide.selector);
        pm.buy(id, PredictionMarket.Side.None, 1 * USDC1);
    }

    function test_RevertWhen_BuyZero() public {
        uint256 id = _market();
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.ZeroAmount.selector);
        pm.buy(id, PredictionMarket.Side.Yes, 0);
    }

    function test_RevertWhen_BuyAfterClose() public {
        uint256 id = _market();
        vm.warp(closeTime + 1);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.TradingClosed.selector);
        pm.buy(id, PredictionMarket.Side.Yes, 1 * USDC1);
    }

    function test_RevertWhen_BuyAfterResolve() public {
        uint256 id = _market();
        _resolve(id, PredictionMarket.Side.Yes);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.AlreadyResolved.selector);
        pm.buy(id, PredictionMarket.Side.Yes, 1 * USDC1);
    }

    function test_RevertWhen_ResolveNotResolver() public {
        uint256 id = _market();
        vm.warp(closeTime);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NotResolver.selector);
        pm.resolve(id, PredictionMarket.Side.Yes);
    }

    function test_RevertWhen_ResolveTwice() public {
        uint256 id = _market();
        _resolve(id, PredictionMarket.Side.Yes);
        vm.prank(resolver);
        vm.expectRevert(PredictionMarket.AlreadyResolved.selector);
        pm.resolve(id, PredictionMarket.Side.No);
    }

    function test_RevertWhen_ClaimBeforeResolve() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        vm.prank(alice);
        vm.expectRevert(PredictionMarket.NotResolved.selector);
        pm.claim(id);
    }

    function test_RevertWhen_DoubleClaim() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        _resolve(id, PredictionMarket.Side.Yes);
        vm.startPrank(alice);
        pm.claim(id);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        pm.claim(id);
        vm.stopPrank();
    }

    function test_RevertWhen_LoserClaims() public {
        uint256 id = _market();
        vm.prank(alice);
        pm.buy(id, PredictionMarket.Side.Yes, 100 * USDC1);
        vm.prank(bob);
        pm.buy(id, PredictionMarket.Side.No, 100 * USDC1);
        _resolve(id, PredictionMarket.Side.Yes);
        vm.prank(bob);
        vm.expectRevert(PredictionMarket.NothingToClaim.selector);
        pm.claim(id);
    }

    function test_RevertWhen_UnknownMarket() public {
        vm.expectRevert(PredictionMarket.UnknownMarket.selector);
        pm.getMarket(99);
    }

    // ── Fuzz ──────────────────────────────────────────────────────────────────

    function testFuzz_SolventSingleWinner(uint96 yes, uint96 no) public {
        yes = uint96(bound(yes, 1, 1_000 * USDC1));
        no = uint96(bound(no, 0, 1_000 * USDC1));
        usdc.mint(alice, yes);
        usdc.mint(bob, no);
        uint256 id = _market();
        vm.startPrank(alice);
        usdc.approve(address(pm), yes);
        pm.buy(id, PredictionMarket.Side.Yes, yes);
        vm.stopPrank();
        if (no > 0) {
            vm.startPrank(bob);
            usdc.approve(address(pm), no);
            pm.buy(id, PredictionMarket.Side.No, no);
            vm.stopPrank();
        }
        _resolve(id, PredictionMarket.Side.Yes);
        vm.prank(alice);
        uint256 payout = pm.claim(id);
        assertEq(payout, uint256(yes) + uint256(no));
        assertEq(usdc.balanceOf(address(pm)), 0);
    }
}
