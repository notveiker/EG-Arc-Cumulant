// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PredictionMarket} from "../src/PredictionMarket.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {TrancheVault} from "../src/TrancheVault.sol";
import {ProtectedNote} from "../src/ProtectedNote.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Deploys the full Cumulant protocol (PredictionMarket + BasketVault + TrancheVault +
///         ProtectedNote) and, optionally, seeds demo markets and one of each structured product.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY   broadcaster / initial resolver / note issuer
///   USDC_ADDRESS           collateral token (0x3600…0000 on Arc testnet)
///   DEPLOY_MOCK_USDC       "true" → deploy a local MockUSDC instead (Anvil only)
///   SEED_DEMO              "true" → create demo markets + basket + tranche + note
///
/// Arc:    forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
/// Local:  DEPLOY_MOCK_USDC=true SEED_DEMO=true forge script ... --rpc-url anvil --broadcast
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        bool deployMock = vm.envOr("DEPLOY_MOCK_USDC", false);
        bool seed = vm.envOr("SEED_DEMO", false);

        vm.startBroadcast(pk);

        IERC20 usdc;
        if (deployMock) {
            MockUSDC mock = new MockUSDC();
            mock.mint(deployer, 1_000_000e6);
            usdc = IERC20(address(mock));
            console2.log("MockUSDC:", address(mock));
        } else {
            usdc = IERC20(vm.envAddress("USDC_ADDRESS"));
        }

        PredictionMarket pm = new PredictionMarket(usdc, deployer);
        BasketVault basket = new BasketVault(pm);
        TrancheVault tranche = new TrancheVault(pm);
        ProtectedNote note = new ProtectedNote(pm);

        console2.log("Deployer / resolver:", deployer);
        console2.log("USDC:               ", address(usdc));
        console2.log("PredictionMarket:   ", address(pm));
        console2.log("BasketVault:        ", address(basket));
        console2.log("TrancheVault:       ", address(tranche));
        console2.log("ProtectedNote:      ", address(note));

        if (seed) {
            _seed(pm, basket, tranche);
            // Notes + deposits move USDC. Real-USDC chains (Arc) route transferFrom through a
            // native blocklist precompile forge's local EVM can't execute, so these run only on
            // local MockUSDC; on Arc the note is created post-deploy via cast (Makefile
            // `seed-note-arc`) and baskets/tranches are funded by users.
            if (deployMock) {
                _seedFunded(usdc, basket, tranche, note);
                // Seed the secondary-market MM reserve in each vault so positions are
                // sellable pre-settlement out of the box (the MM buys them back at its
                // signed quote and warehouses them to settlement).
                MockUSDC(address(usdc)).mint(deployer, 900_000e6);
                usdc.approve(address(basket), type(uint256).max);
                usdc.approve(address(tranche), type(uint256).max);
                usdc.approve(address(note), type(uint256).max);
                basket.fundMmReserve(300_000e6);
                tranche.fundMmReserve(300_000e6);
                note.fundMmReserve(300_000e6);
                console2.log("MM reserves funded (300k USDC each)");
            }
        }

        vm.stopBroadcast();

        _writeDeployment(address(usdc), address(pm), address(basket), address(tranche), address(note), deployer);
    }

    /// @dev Close timestamp `daysOut` days from now — used to stagger market maturities so the
    ///      demo baskets/tranches span short / medium / long windows (not all the same date).
    function _d(uint256 daysOut) internal view returns (uint64) {
        return uint64(block.timestamp + daysOut * 1 days);
    }

    /// @dev Generates a varied prediction-market question for pool leg `i` (asset × move × horizon).
    function _question(uint256 i) internal pure returns (string memory) {
        string[12] memory A = [
            "Bitcoin",
            "Ethereum",
            "Solana",
            "Avalanche",
            "Chainlink",
            "Nvidia",
            "Apple",
            "Tesla",
            "the S&P 500",
            "gold",
            "crude oil",
            "the 10-year yield"
        ];
        string[6] memory M = [
            "set a new high",
            "hold above support",
            "beat consensus estimates",
            "outperform its peers",
            "break out of its range",
            "close green"
        ];
        string[5] memory T = ["this month", "this quarter", "by mid-year", "before year-end", "this cycle"];
        return string.concat("Will ", A[i % 12], " ", M[(i / 12) % 6], " ", T[(i / 72) % 5], "?");
    }

    /// @dev Close for basket `b`, leg `k` — every leg of a basket shares a maturity window so the
    ///      Short/Medium/Long filter stays clean (baskets 0-2 short, 3-5 medium, 6-8 long).
    function _windowClose(uint256 b, uint256 k) internal view returns (uint64) {
        if (b < 3) return _d(14 + (k % 16)); // short  14-29d
        if (b < 6) return _d(45 + (k % 70)); // medium 45-114d
        return _d(150 + (k % 130)); // long  150-279d
    }

    function _basketName(uint256 b) internal pure returns (string memory) {
        string[9] memory NAMES = [
            "Macro Risk Basket",
            "Crypto Majors",
            "Rates & Recession",
            "Frontier Tech",
            "Inflation Hedge",
            "AI & Chips",
            "Big-Cap Equity",
            "Crypto Moonshot",
            "Global Macro"
        ];
        return NAMES[b];
    }

    function _coupon(uint256 b) internal pure returns (uint16) {
        uint16[9] memory CPN = [uint16(1000), 1500, 800, 1200, 600, 2000, 900, 1800, 700];
        return CPN[b];
    }

    function _two(uint256 a, PredictionMarket.Side sa, uint16 wa, uint256 b, PredictionMarket.Side sb, uint16 wb)
        internal
        pure
        returns (uint256[] memory ids, PredictionMarket.Side[] memory sides, uint16[] memory w)
    {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        sides = new PredictionMarket.Side[](2);
        sides[0] = sa;
        sides[1] = sb;
        w = new uint16[](2);
        w[0] = wa;
        w[1] = wb;
    }

    /// @dev USDC-free seed: 48 markets + 9 baskets + 9 tranches. Safe to simulate on any chain.
    function _seed(PredictionMarket pm, BasketVault basket, TrancheVault tranche) internal {
        PredictionMarket.Side Y = PredictionMarket.Side.Yes;
        PredictionMarket.Side N = PredictionMarket.Side.No;

        // Maturities staggered so the 9 baskets span short (<=30d) / medium / long (>120d).
        // Both legs of each basket share a window, so the basket's nearest-close maturity is clean.
        pm.createMarket("Will ETH close above $5,000 this quarter?", _d(20)); // 0  short
        pm.createMarket("Will the Fed cut rates at the next meeting?", _d(28)); // 1  short
        pm.createMarket("Will US CPI come in under 3.0% YoY?", _d(20)); // 2  short
        pm.createMarket("Will BTC make a new all-time high this year?", _d(75)); // 3  medium
        pm.createMarket("Will SOL trade above $300 this year?", _d(75)); // 4  medium
        pm.createMarket("Will the US enter a recession in 2026?", _d(28)); // 5  short
        pm.createMarket("Will Starship reach orbit this year?", _d(210)); // 6  long
        pm.createMarket("Will unemployment stay under 4.0%?", _d(210)); // 7  long
        pm.createMarket("Will gold close above $3,000/oz this year?", _d(95)); // 8  medium
        pm.createMarket("Will an AI safety bill pass the Senate?", _d(95)); // 9  medium
        pm.createMarket("Will ETH reach $10,000 this cycle?", _d(60)); // 10 medium
        pm.createMarket("Will BTC trade above $150,000 this year?", _d(60)); // 11 medium
        pm.createMarket("Will Powell be reappointed Fed Chair?", _d(180)); // 12 long
        pm.createMarket("Will the S&P 500 set a new all-time high?", _d(270)); // 13 long
        pm.createMarket("Will WTI crude close under $70 this year?", _d(270)); // 14 long
        pm.createMarket("Will China GDP growth exceed 5% in 2026?", _d(180)); // 15 long
        pm.createMarket("Will Apple reach a $4T market cap?", _d(18)); // 16 short
        pm.createMarket("Will Nvidia reach a $5T market cap?", _d(18)); // 17 short

        // Broader market book so the Markets surface reflects a real platform, not a handful of demos.
        pm.createMarket("Will BTC hold above $90,000 through month-end?", _d(22)); // 18
        pm.createMarket("Will the ECB hold rates at its next meeting?", _d(26)); // 19
        pm.createMarket("Will Tesla deliver a record quarter?", _d(24)); // 20
        pm.createMarket("Will the S&P 500 close green this month?", _d(16)); // 21
        pm.createMarket("Will oil close above $80 this month?", _d(21)); // 22
        pm.createMarket("Will the VIX spike above 25 this month?", _d(12)); // 23
        pm.createMarket("Will US GDP growth top 2.5% this year?", _d(80)); // 24
        pm.createMarket("Will inflation fall below 2.5% this year?", _d(88)); // 25
        pm.createMarket("Will OpenAI release a new flagship model this year?", _d(55)); // 26
        pm.createMarket("Will a top-5 bank cut its prime rate?", _d(50)); // 27
        pm.createMarket("Will copper close above $5/lb this year?", _d(65)); // 28
        pm.createMarket("Will the Nasdaq outperform the S&P this year?", _d(78)); // 29
        pm.createMarket("Will a new country adopt BTC as legal tender?", _d(90)); // 30
        pm.createMarket("Will Ethereum ETF inflows top $10B this year?", _d(70)); // 31
        pm.createMarket("Will a stablecoin top a $200B market cap?", _d(85)); // 32
        pm.createMarket("Will retail sales beat estimates this quarter?", _d(40)); // 33
        pm.createMarket("Will a Magnificent-7 stock split this year?", _d(58)); // 34
        pm.createMarket("Will mortgage rates drop below 6% this year?", _d(120)); // 35
        pm.createMarket("Will Disney+ subscribers top 200M this year?", _d(110)); // 36
        pm.createMarket("Will EVs top 20% of new US car sales?", _d(240)); // 37
        pm.createMarket("Will a fusion startup hit net energy gain?", _d(300)); // 38
        pm.createMarket("Will SpaceX fly humans around the Moon?", _d(260)); // 39
        pm.createMarket("Will the 10-year Treasury yield top 5%?", _d(160)); // 40
        pm.createMarket("Will the US pass major AI regulation in 2026?", _d(200)); // 41
        pm.createMarket("Will quantum computing reach 1,000 qubits?", _d(280)); // 42
        pm.createMarket("Will Bitcoin dominance fall below 40%?", _d(190)); // 43
        pm.createMarket("Will a major automaker go all-electric?", _d(250)); // 44
        pm.createMarket("Will the US debt ceiling be raised again?", _d(150)); // 45
        pm.createMarket("Will Meta ship consumer AR glasses?", _d(220)); // 46
        pm.createMarket("Will TikTok be banned in the US?", _d(140)); // 47

        // Build 9 baskets + a mirrored senior/junior tranche per basket, each over a disjoint
        // 2-market slice of a freshly-minted pool. Kept lean (2 legs) because the secondary-market
        // MM quoting is simulated in the backend and only buys/sells settle on chain — the venue
        // does not need a deep seeded book, and Arc gas is real (non-mintable) USDC. The 48 curated
        // markets above (0-47) stay standalone in the Markets book and back the protected notes.
        uint256 LEGS = 2;
        uint16 base = uint16(uint256(10_000) / LEGS); // 333 bps; leg 0 absorbs the remainder
        for (uint256 b = 0; b < 9; b++) {
            uint256[] memory ids = new uint256[](LEGS);
            PredictionMarket.Side[] memory sd = new PredictionMarket.Side[](LEGS);
            uint16[] memory w = new uint16[](LEGS);
            for (uint256 k = 0; k < LEGS; k++) {
                uint256 poolIdx = b * LEGS + k;
                pm.createMarket(_question(poolIdx), _windowClose(b, k));
                ids[k] = 48 + poolIdx; // curated markets occupy 0..47; pool starts at 48
                sd[k] = (k % 2 == 0) ? Y : N;
                w[k] = base;
            }
            w[0] = uint16(10_000 - uint256(base) * (LEGS - 1));
            basket.createBasket(_basketName(b), ids, sd, w);
            tranche.createTranche(_basketName(b), _coupon(b), ids, sd, w);
        }

        console2.log("Seeded (lean): 66 markets + 9 baskets + 9 tranches");
    }

    /// @dev Local/MockUSDC-only: create 5 protected notes (issuer-funded) and seed deposits across
    ///      several baskets / tranches / a note so the UI shows live TVL out of the box. Markets are
    ///      left without a pre-seeded odds book (the MM quoting that drives marks is simulated in the
    ///      backend; only buys/sells settle on chain), which keeps the deploy inside Arc's gas budget.
    function _seedFunded(IERC20 usdc, BasketVault basket, TrancheVault tranche, ProtectedNote note) internal {
        PredictionMarket.Side Y = PredictionMarket.Side.Yes;
        PredictionMarket.Side N = PredictionMarket.Side.No;
        usdc.approve(address(note), type(uint256).max);
        usdc.approve(address(basket), type(uint256).max);
        usdc.approve(address(tranche), type(uint256).max);

        note.createNote("ETH Upside Protected Note", 0, Y, 5e6);
        note.createNote("BTC Upside Note", 3, Y, 5e6);
        note.createNote("Gold Hedge Note", 8, N, 3e6);
        note.createNote("Recession Hedge Note", 5, Y, 4e6);
        note.createNote("AI Upside Note", 17, Y, 5e6);

        basket.deposit(0, 200e6);
        basket.deposit(1, 150e6);
        basket.deposit(2, 120e6);
        basket.deposit(5, 90e6);
        // Fund a spread of tranches (senior + junior) across all three coupon tiers so the UI
        // shows live TVL, not a wall of $0.
        tranche.deposit(0, 150e6, true); // Macro (mid)
        tranche.deposit(0, 100e6, false);
        tranche.deposit(1, 120e6, true); // Crypto Majors (high)
        tranche.deposit(1, 80e6, false);
        tranche.deposit(3, 90e6, true); // Frontier Tech (high)
        tranche.deposit(3, 60e6, false);
        tranche.deposit(4, 70e6, true); // Inflation Hedge (low)
        tranche.deposit(4, 40e6, false);
        tranche.deposit(6, 80e6, true); // Big-Cap Equity (mid)
        tranche.deposit(6, 50e6, false);
        note.deposit(0, 100e6);
        note.deposit(1, 80e6);

        console2.log("Seeded: 5 notes + deposits");
    }

    function _writeDeployment(address usdc, address pm, address basket, address tranche, address note, address resolver)
        internal
    {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "usdc", usdc);
        vm.serializeAddress(obj, "predictionMarket", pm);
        vm.serializeAddress(obj, "basketVault", basket);
        vm.serializeAddress(obj, "trancheVault", tranche);
        vm.serializeAddress(obj, "resolver", resolver);
        string memory json = vm.serializeAddress(obj, "protectedNote", note);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Wrote", path);
    }
}
