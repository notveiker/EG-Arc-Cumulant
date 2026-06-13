// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract BasketVaultTest is Test {
    MockUSDC usdc;
    PredictionMarket pm;
    BasketVault vault;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address ext = makeAddr("ext");
    address stranger = makeAddr("stranger");

    uint256 constant USDC1 = 1e6;
    uint64 closeTime;

    function setUp() public {
        usdc = new MockUSDC();
        pm = new PredictionMarket(usdc, address(this)); // this test is the resolver + owner
        vault = new BasketVault(pm);
        closeTime = uint64(block.timestamp + 1 days);

        address[3] memory users = [alice, bob, ext];
        for (uint256 i; i < users.length; ++i) {
            usdc.mint(users[i], 1_000 * USDC1);
            vm.prank(users[i]);
            usdc.approve(address(vault), type(uint256).max);
            vm.prank(users[i]);
            usdc.approve(address(pm), type(uint256).max);
        }
    }

    function _resolve(uint256 id, PredictionMarket.Side side) internal {
        if (block.timestamp < closeTime) vm.warp(closeTime);
        pm.resolve(id, side);
    }

    function _twoMarketBasket() internal returns (uint256 basketId, uint256 m0, uint256 m1) {
        m0 = pm.createMarket("CPI > 3%?", closeTime);
        m1 = pm.createMarket("Fed cut in March?", closeTime);

        uint256[] memory ids = new uint256[](2);
        ids[0] = m0;
        ids[1] = m1;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](2);
        sides[0] = PredictionMarket.Side.Yes;
        sides[1] = PredictionMarket.Side.No;
        uint16[] memory weights = new uint16[](2);
        weights[0] = 6000;
        weights[1] = 4000;
        basketId = vault.createBasket("Macro Basket", ids, sides, weights);
    }

    function test_CreateBasketStoresLegs() public {
        (uint256 bId,,) = _twoMarketBasket();
        assertEq(vault.basketCount(), 1);
        BasketVault.Leg[] memory legs = vault.getLegs(bId);
        assertEq(legs.length, 2);
        assertEq(legs[0].weightBps, 6000);
        assertEq(uint8(legs[1].side), uint8(PredictionMarket.Side.No));
        assertTrue(vault.marketAssigned(0));
        assertTrue(vault.marketAssigned(1));
    }

    function test_DepositBuysLegsByWeight() public {
        (uint256 bId, uint256 m0, uint256 m1) = _twoMarketBasket();
        vm.prank(alice);
        uint256 shares = vault.deposit(bId, 100 * USDC1);
        assertEq(shares, 100 * USDC1);
        assertEq(vault.sharesOf(bId, alice), 100 * USDC1);
        assertEq(pm.getPosition(m0, address(vault)).yes, 60 * USDC1);
        assertEq(pm.getPosition(m1, address(vault)).no, 40 * USDC1);
        assertEq(vault.getBasket(bId).totalShares, 100 * USDC1);
    }

    function test_FullLifecycle_TwoDepositors() public {
        (uint256 bId, uint256 m0, uint256 m1) = _twoMarketBasket();

        vm.prank(alice);
        vault.deposit(bId, 100 * USDC1);
        vm.prank(bob);
        vault.deposit(bId, 100 * USDC1);

        vm.prank(ext);
        pm.buy(m0, PredictionMarket.Side.No, 120 * USDC1);
        vm.prank(ext);
        pm.buy(m1, PredictionMarket.Side.Yes, 80 * USDC1);

        _resolve(m0, PredictionMarket.Side.Yes);
        _resolve(m1, PredictionMarket.Side.No);

        vault.settle(bId);
        BasketVault.Basket memory b = vault.getBasket(bId);
        assertTrue(b.settled);
        assertEq(b.recovered, 400 * USDC1);

        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        assertEq(vault.redeem(bId, 100 * USDC1), 200 * USDC1);
        assertEq(usdc.balanceOf(alice) - aBefore, 200 * USDC1);
        vm.prank(bob);
        assertEq(vault.redeem(bId, 100 * USDC1), 200 * USDC1);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_MarkToWin() public {
        (uint256 bId,,) = _twoMarketBasket();
        vm.prank(alice);
        vault.deposit(bId, 100 * USDC1);
        assertEq(vault.markToWin(bId), 100 * USDC1);
    }

    /// A voided leg refunds the vault's stake at settlement (liveness).
    function test_VoidedLegSettlesAndRefunds() public {
        uint256 m0 = pm.createMarket("solo", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](1);
        sides[0] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        uint256 bId = vault.createBasket("solo basket", ids, sides, w);

        vm.prank(alice);
        vault.deposit(bId, 100 * USDC1);

        vm.warp(closeTime);
        pm.voidMarket(m0);
        vault.settle(bId);
        assertEq(vault.getBasket(bId).recovered, 100 * USDC1); // stake refunded

        vm.prank(alice);
        assertEq(vault.redeem(bId, 100 * USDC1), 100 * USDC1);
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
        vault.createBasket("x", ids, sides, w);
    }

    function test_RevertWhen_DepositTooSmall() public {
        (uint256 bId,,) = _twoMarketBasket(); // 60/40 weights
        vm.prank(alice);
        // 1 base unit: leg0 = 1*6000/10000 = 0 → DepositTooSmall
        vm.expectRevert(BasketVault.DepositTooSmall.selector);
        vault.deposit(bId, 1);
    }

    function test_RevertWhen_TooManyLegs() public {
        uint256[] memory ids = new uint256[](41);
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](41);
        uint16[] memory w = new uint16[](41);
        vm.expectRevert(BasketVault.TooManyLegs.selector);
        vault.createBasket("big", ids, sides, w);
    }

    function test_RevertWhen_EmptyName() public {
        uint256 m0 = pm.createMarket("a", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](1);
        sides[0] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        vm.expectRevert(BasketVault.EmptyName.selector);
        vault.createBasket("", ids, sides, w);
    }

    function test_RevertWhen_MarketReused() public {
        (, uint256 m0,) = _twoMarketBasket();
        uint256 m2 = pm.createMarket("third", closeTime);
        uint256[] memory ids = new uint256[](2);
        ids[0] = m0;
        ids[1] = m2;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](2);
        sides[0] = PredictionMarket.Side.Yes;
        sides[1] = PredictionMarket.Side.Yes;
        uint16[] memory weights = new uint16[](2);
        weights[0] = 5000;
        weights[1] = 5000;
        vm.expectRevert(abi.encodeWithSelector(BasketVault.MarketTaken.selector, m0));
        vault.createBasket("dup", ids, sides, weights);
    }

    function test_RevertWhen_BadWeights() public {
        uint256 m0 = pm.createMarket("a", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory sides = new PredictionMarket.Side[](1);
        sides[0] = PredictionMarket.Side.Yes;
        uint16[] memory weights = new uint16[](1);
        weights[0] = 9999;
        vm.expectRevert(BasketVault.BadWeights.selector);
        vault.createBasket("bad", ids, sides, weights);
    }

    function test_RevertWhen_SettleBeforeAllResolved() public {
        (uint256 bId, uint256 m0,) = _twoMarketBasket();
        vm.prank(alice);
        vault.deposit(bId, 100 * USDC1);
        _resolve(m0, PredictionMarket.Side.Yes);
        vm.expectRevert(BasketVault.NotAllResolved.selector);
        vault.settle(bId);
    }

    function test_RevertWhen_RedeemBeforeSettle() public {
        (uint256 bId,,) = _twoMarketBasket();
        vm.prank(alice);
        vault.deposit(bId, 100 * USDC1);
        vm.prank(alice);
        vm.expectRevert(BasketVault.NotSettled.selector);
        vault.redeem(bId, 100 * USDC1);
    }

    function test_RevertWhen_RedeemTooMuch() public {
        (uint256 bId, uint256 m0, uint256 m1) = _twoMarketBasket();
        vm.prank(alice);
        vault.deposit(bId, 100 * USDC1);
        _resolve(m0, PredictionMarket.Side.Yes);
        _resolve(m1, PredictionMarket.Side.No);
        vault.settle(bId);
        vm.prank(alice);
        vm.expectRevert(BasketVault.InsufficientShares.selector);
        vault.redeem(bId, 101 * USDC1);
    }
}
