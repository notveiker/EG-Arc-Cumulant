// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {TrancheVault} from "../src/TrancheVault.sol";
import {ProtectedNote} from "../src/ProtectedNote.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Tests the pre-settlement MM secondary-market exit (`sellToMM`) across all three vaults.
/// The MM/owner is an EOA so we can sign quotes; the digest format here is the EXACT format
/// the backend replicates in viem: keccak256(abi.encode(chainId, vault, id, seller, shares,
/// [senior,] payout, deadline)) signed as an EIP-191 personal_sign message.
contract SellToMMTest is Test {
    MockUSDC usdc;
    PredictionMarket pm;
    BasketVault basket;
    TrancheVault tranche;
    ProtectedNote note;

    uint256 constant OWNER_PK = 0xA11CE;
    uint256 constant WRONG_PK = 0xBAD;
    address mm; // owner / market-maker (signs quotes)
    address alice = makeAddr("alice");
    uint256 constant USDC1 = 1e6;
    uint64 closeTime;

    function setUp() public {
        mm = vm.addr(OWNER_PK);
        usdc = new MockUSDC();
        pm = new PredictionMarket(usdc, address(this)); // this = resolver
        basket = new BasketVault(pm);
        tranche = new TrancheVault(pm);
        note = new ProtectedNote(pm);
        closeTime = uint64(block.timestamp + 1 days);

        usdc.mint(alice, 10_000 * USDC1);
        usdc.mint(address(this), 2_000_000 * USDC1); // issuer upside + reserve funding
        vm.startPrank(alice);
        usdc.approve(address(basket), type(uint256).max);
        usdc.approve(address(tranche), type(uint256).max);
        usdc.approve(address(note), type(uint256).max);
        vm.stopPrank();
        usdc.approve(address(basket), type(uint256).max);
        usdc.approve(address(tranche), type(uint256).max);
        usdc.approve(address(note), type(uint256).max);
    }

    function _ethSig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    function _oneLegBasket() internal returns (uint256 id) {
        uint256 m0 = pm.createMarket("b", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory s = new PredictionMarket.Side[](1);
        s[0] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        id = basket.createBasket("B", ids, s, w);
    }

    function _oneLegTranche() internal returns (uint256 id) {
        uint256 m0 = pm.createMarket("t", closeTime);
        uint256[] memory ids = new uint256[](1);
        ids[0] = m0;
        PredictionMarket.Side[] memory s = new PredictionMarket.Side[](1);
        s[0] = PredictionMarket.Side.Yes;
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        id = tranche.createTranche("T", 1000, ids, s, w);
    }

    function _note() internal returns (uint256 id) {
        uint256 m0 = pm.createMarket("n", closeTime);
        id = note.createNote("N", m0, PredictionMarket.Side.Yes, 100 * USDC1);
    }

    // ── Baskets ──────────────────────────────────────────────────────────────

    function test_BasketSellToMM() public {
        uint256 id = _oneLegBasket();
        basket.fundMmReserve(50_000 * USDC1);
        basket.transferOwnership(mm);

        vm.prank(alice);
        basket.deposit(id, 100 * USDC1);

        uint256 shares = 100 * USDC1;
        uint256 payout = 97 * USDC1; // MM's quoted bid
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(block.chainid, address(basket), id, alice, shares, payout, deadline));
        bytes memory sig = _ethSig(OWNER_PK, digest);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        basket.sellToMM(id, shares, payout, deadline, sig);

        assertEq(usdc.balanceOf(alice), before + payout, "seller paid the quote");
        assertEq(basket.sharesOf(id, alice), 0, "seller shares cleared");
        assertEq(basket.sharesOf(id, mm), shares, "MM warehoused the shares");
        assertEq(basket.mmReserve(), 50_000 * USDC1 - payout, "reserve debited");
    }

    function test_BasketSellToMM_RevertBadSig() public {
        uint256 id = _oneLegBasket();
        basket.fundMmReserve(50_000 * USDC1);
        basket.transferOwnership(mm);
        vm.prank(alice);
        basket.deposit(id, 100 * USDC1);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(block.chainid, address(basket), id, alice, 100 * USDC1, 97 * USDC1, deadline));
        bytes memory badSig = _ethSig(WRONG_PK, digest); // not the owner

        vm.prank(alice);
        vm.expectRevert(BasketVault.BadQuote.selector);
        basket.sellToMM(id, 100 * USDC1, 97 * USDC1, deadline, badSig);
    }

    function test_BasketSellToMM_RevertReserveTooLow() public {
        uint256 id = _oneLegBasket();
        basket.fundMmReserve(10 * USDC1); // tiny reserve
        basket.transferOwnership(mm);
        vm.prank(alice);
        basket.deposit(id, 100 * USDC1);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(block.chainid, address(basket), id, alice, 100 * USDC1, 97 * USDC1, deadline));
        bytes memory sig = _ethSig(OWNER_PK, digest);

        vm.prank(alice);
        vm.expectRevert(BasketVault.ReserveTooLow.selector);
        basket.sellToMM(id, 100 * USDC1, 97 * USDC1, deadline, sig);
    }

    function test_BasketSellToMM_RevertExpired() public {
        uint256 id = _oneLegBasket();
        basket.fundMmReserve(50_000 * USDC1);
        basket.transferOwnership(mm);
        vm.prank(alice);
        basket.deposit(id, 100 * USDC1);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(abi.encode(block.chainid, address(basket), id, alice, 100 * USDC1, 97 * USDC1, deadline));
        bytes memory sig = _ethSig(OWNER_PK, digest);
        vm.warp(deadline + 1);

        vm.prank(alice);
        vm.expectRevert(BasketVault.QuoteExpired.selector);
        basket.sellToMM(id, 100 * USDC1, 97 * USDC1, deadline, sig);
    }

    // ── Tranches (senior + junior) ─────────────────────────────────────────────

    function test_TrancheSellToMM_Senior() public {
        uint256 id = _oneLegTranche();
        tranche.fundMmReserve(50_000 * USDC1);
        tranche.transferOwnership(mm);

        vm.prank(alice);
        tranche.deposit(id, 100 * USDC1, true); // senior

        uint256 shares = 100 * USDC1;
        uint256 payout = 96 * USDC1;
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest =
            keccak256(abi.encode(block.chainid, address(tranche), id, alice, shares, true, payout, deadline));
        bytes memory sig = _ethSig(OWNER_PK, digest);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        tranche.sellToMM(id, shares, true, payout, deadline, sig);

        assertEq(usdc.balanceOf(alice), before + payout);
        (uint256 sBal,) = tranche.sharesOf(id, alice);
        (uint256 sMm,) = tranche.sharesOf(id, mm);
        assertEq(sBal, 0, "alice senior cleared");
        assertEq(sMm, shares, "MM warehoused senior");
        assertEq(tranche.mmReserve(), 50_000 * USDC1 - payout);
    }

    function test_TrancheSellToMM_Junior() public {
        uint256 id = _oneLegTranche();
        tranche.fundMmReserve(50_000 * USDC1);
        tranche.transferOwnership(mm);

        vm.prank(alice);
        tranche.deposit(id, 100 * USDC1, false); // junior

        uint256 shares = 100 * USDC1;
        uint256 payout = 30 * USDC1; // junior trades at a discount
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest =
            keccak256(abi.encode(block.chainid, address(tranche), id, alice, shares, false, payout, deadline));
        bytes memory sig = _ethSig(OWNER_PK, digest);

        vm.prank(alice);
        tranche.sellToMM(id, shares, false, payout, deadline, sig);

        (, uint256 jBal) = tranche.sharesOf(id, alice);
        (, uint256 jMm) = tranche.sharesOf(id, mm);
        assertEq(jBal, 0, "alice junior cleared");
        assertEq(jMm, shares, "MM warehoused junior");
    }

    // ── Protected notes ────────────────────────────────────────────────────────

    function test_NoteSellToMM() public {
        uint256 id = _note();
        note.fundMmReserve(50_000 * USDC1);
        note.transferOwnership(mm);

        vm.prank(alice);
        note.deposit(id, 100 * USDC1);

        uint256 principal = 100 * USDC1;
        uint256 payout = 99 * USDC1; // principal-protected: trades near par
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest =
            keccak256(abi.encode(block.chainid, address(note), id, alice, principal, payout, deadline));
        bytes memory sig = _ethSig(OWNER_PK, digest);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        note.sellToMM(id, principal, payout, deadline, sig);

        assertEq(usdc.balanceOf(alice), before + payout);
        assertEq(note.principalOf(id, alice), 0, "alice principal cleared");
        assertEq(note.principalOf(id, mm), principal, "MM warehoused principal");
        assertEq(note.mmReserve(), 50_000 * USDC1 - payout);
    }
}
