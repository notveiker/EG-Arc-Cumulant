// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {TrancheVault} from "../src/TrancheVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract TrancheVaultTest is Test {
    MockUSDC usdc;
    PredictionMarket pm;
    TrancheVault tranche;

    address senior = makeAddr("senior");
    address junior = makeAddr("junior");
    address ext = makeAddr("ext");
    address stranger = makeAddr("stranger");

    uint256 constant USDC1 = 1e6;
    uint64 closeTime;

    function setUp() public {
        usdc = new MockUSDC();
        pm = new PredictionMarket(usdc, address(this));
        tranche = new TrancheVault(pm);
        closeTime = uint64(block.timestamp + 1 days);

        address[3] memory users = [senior, junior, ext];
        for (uint256 i; i < users.length; ++i) {
            usdc.mint(users[i], 10_000 * USDC1);
            vm.prank(users[i]);
            usdc.approve(address(tranche), type(uint256).max);
            vm.prank(users[i]);
            usdc.approve(address(pm), type(uint256).max);
        }
    }

    function _resolve(uint256 id, PredictionMarket.Side side) internal {
        if (block.timestamp < closeTime) vm.warp(closeTime);
        pm.resolve(id, side);
    }

    function _twoLeg(uint16 coupon) internal returns (uint256 id, uint256 m0, uint256 m1) {
        m0 = pm.createMarket("leg0", closeTime);
        m1 = pm.createMarket("leg1", closeTime);
        uint256[] memory ids = new uint256[](2);
        ids[0] = m0;
        ids[1] = m1;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](2);
        sides[0] = PredictionMarket.Side.Yes;
        sides[1] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](2);
        w[0] = 5000;
        w[1] = 5000;
        id = tranche.createTranche("Macro 60/40", coupon, ids, sides, w);
    }

    function _single(uint16 coupon) internal returns (uint256 id, uint256 m0) {
        m0 = pm.createMarket("solo", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](1);
        sides[0] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        id = tranche.createTranche("Solo", coupon, ids, sides, w);
    }

    function test_DepositBuysLegsAndCredits() public {
        (uint256 id, uint256 m0, uint256 m1) = _twoLeg(1000);
        vm.prank(senior);
        tranche.deposit(id, 100 * USDC1, true);
        assertEq(pm.getPosition(m0, address(tranche)).yes, 50 * USDC1);
        assertEq(pm.getPosition(m1, address(tranche)).yes, 50 * USDC1);
        (uint256 s, uint256 j) = tranche.sharesOf(id, senior);
        assertEq(s, 100 * USDC1);
        assertEq(j, 0);
        assertEq(tranche.getTranche(id).seniorPrincipal, 100 * USDC1);
    }

    function test_Waterfall_BothWin() public {
        (uint256 id, uint256 m0, uint256 m1) = _twoLeg(1000);
        vm.prank(senior);
        tranche.deposit(id, 100 * USDC1, true);
        vm.prank(junior);
        tranche.deposit(id, 100 * USDC1, false);
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 100 * USDC1);
        vm.prank(ext);
        pm.buy(m1, PredictionMarket.Side.No, 100 * USDC1);

        _resolve(m0, PredictionMarket.Side.Yes);
        _resolve(m1, PredictionMarket.Side.Yes);
        tranche.settle(id);

        TrancheVault.Tranche memory t = tranche.getTranche(id);
        assertEq(t.recovered, 400 * USDC1);
        assertEq(t.seniorPot, 110 * USDC1);
        assertEq(t.juniorPot, 290 * USDC1);

        vm.prank(senior);
        assertEq(tranche.redeem(id, 100 * USDC1, true), 110 * USDC1);
        vm.prank(junior);
        assertEq(tranche.redeem(id, 100 * USDC1, false), 290 * USDC1);
    }

    function test_Waterfall_JuniorFirstLoss() public {
        (uint256 id, uint256 m0, uint256 m1) = _twoLeg(1000);
        vm.prank(senior);
        tranche.deposit(id, 100 * USDC1, true);
        vm.prank(junior);
        tranche.deposit(id, 100 * USDC1, false);
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 50 * USDC1);
        vm.prank(ext);
        pm.buy(m1, PredictionMarket.Side.No, 50 * USDC1); // real NO winner so leg1 truly loses

        _resolve(m0, PredictionMarket.Side.Yes);
        _resolve(m1, PredictionMarket.Side.No);
        tranche.settle(id);

        TrancheVault.Tranche memory t = tranche.getTranche(id);
        assertEq(t.recovered, 150 * USDC1);
        assertEq(t.seniorPot, 110 * USDC1);
        assertEq(t.juniorPot, 40 * USDC1);

        vm.prank(senior);
        assertEq(tranche.redeem(id, 100 * USDC1, true), 110 * USDC1);
        vm.prank(junior);
        assertEq(tranche.redeem(id, 100 * USDC1, false), 40 * USDC1);
    }

    function test_Waterfall_SeniorImpairedOnTotalLoss() public {
        (uint256 id, uint256 m0) = _single(1000);
        vm.prank(senior);
        tranche.deposit(id, 100 * USDC1, true);
        vm.prank(junior);
        tranche.deposit(id, 100 * USDC1, false);
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 100 * USDC1);

        _resolve(m0, PredictionMarket.Side.No);
        tranche.settle(id);

        TrancheVault.Tranche memory t = tranche.getTranche(id);
        assertEq(t.recovered, 0);
        assertEq(t.seniorPot, 0);
        assertEq(t.juniorPot, 0);
        vm.prank(senior);
        assertEq(tranche.redeem(id, 100 * USDC1, true), 0);
    }

    /// TV-1 fix: with no junior buffer, surplus recovery goes to senior (not stranded).
    function test_JuniorEmpty_SeniorTakesAllRecovered() public {
        (uint256 id, uint256 m0) = _single(1000); // +10% coupon
        vm.prank(senior);
        tranche.deposit(id, 100 * USDC1, true); // no junior deposits
        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 100 * USDC1);

        _resolve(m0, PredictionMarket.Side.Yes);
        tranche.settle(id);

        TrancheVault.Tranche memory t = tranche.getTranche(id);
        assertEq(t.recovered, 200 * USDC1);
        assertEq(t.seniorPot, 200 * USDC1); // all of it, not capped at 110
        assertEq(t.juniorPot, 0);
        vm.prank(senior);
        assertEq(tranche.redeem(id, 100 * USDC1, true), 200 * USDC1);
        assertEq(usdc.balanceOf(address(tranche)), 0);
    }

    // ── Reverts / hardening ─────────────────────────────────────────────────────

    function test_RevertWhen_CreateNotOwner() public {
        uint256 m0 = pm.createMarket("a", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](1);
        sides[0] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        tranche.createTranche("x", 0, ids, sides, w);
    }

    function test_RevertWhen_CouponTooHigh() public {
        uint256 m0 = pm.createMarket("a", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](1);
        sides[0] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        vm.expectRevert(TrancheVault.CouponTooHigh.selector);
        tranche.createTranche("x", 50_001, ids, sides, w);
    }

    function test_RevertWhen_DepositTooSmall() public {
        (uint256 id,,) = _twoLeg(1000); // 50/50
        vm.prank(senior);
        vm.expectRevert(TrancheVault.DepositTooSmall.selector);
        tranche.deposit(id, 1, true); // leg0 = 0
    }

    function test_RevertWhen_BadWeights() public {
        uint256 m0 = pm.createMarket("a", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](1);
        sides[0] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](1);
        w[0] = 5000;
        vm.expectRevert(TrancheVault.BadWeights.selector);
        tranche.createTranche("bad", 0, ids, sides, w);
    }

    function test_RevertWhen_RedeemBeforeSettle() public {
        (uint256 id,,) = _twoLeg(1000);
        vm.prank(senior);
        tranche.deposit(id, 100 * USDC1, true);
        vm.prank(senior);
        vm.expectRevert(TrancheVault.NotSettled.selector);
        tranche.redeem(id, 100 * USDC1, true);
    }
}
