# Cumulant — Arc testnet deployment

Network: **Arc Testnet** · chainId `5042002` · RPC `https://rpc.testnet.arc.network`
Explorer: https://testnet.arcscan.app · Audited four-product suite deployed **2026-06-04**

## Addresses

| Contract | Address |
| --- | --- |
| PredictionMarket | `0xdea4E388998c95d342dDA3E9f390cFcba85f60C9` |
| BasketVault | `0x69880F01482B175d56e42f35008f184874173E91` |
| TrancheVault | `0xbf4B8A33d3BBDcDD41aC84019257d0720B8BAE0D` |
| ProtectedNote | `0x7ad54E69EA9919C6F066A05fb770f804ED2f362A` |
| USDC (collateral + native gas) | `0x3600000000000000000000000000000000000000` |
| Owner / resolver / issuer | `0x7E9F7D571BbfBbDd1f41661CA421073B8f2Eebba` |

Machine-readable copy: [`deployments/5042002.json`](deployments/5042002.json).

## Deploy transactions

| Tx | Hash |
| --- | --- |
| Deploy PredictionMarket | `0xc7f9974f4d45ba1ba869d3622739524ebc4483b9bf1b45f99c3674df7f600b11` |
| Deploy BasketVault | `0x7ea0caaecfd93f693959c87cc10296811b20d504bb1e32eefe617d2cf573bcd2` |
| Deploy TrancheVault | `0x80a8fd9839ba5a98a40fd106c74f706c51e717ffd04366fab342f739276aa257` |
| Deploy ProtectedNote | `0xbb9cca36571fae40cc15d1623118c1df3cf9e44b5b351e8e6640005ed98449c7` |
| Seed note — createNote | `0xbf6e6f438693aa3394dde1e326e626e64d0636fa4d8b8edfe07f2fc97a29aae8` |

The four markets, the "Macro Risk Basket", and the "Senior / Junior Macro" tranche are created in
the same `forge script` broadcast (see `broadcast/Deploy.s.sol/5042002/run-latest.json`).

## Seeded state

`SEED_DEMO=true` (used by both `make deploy-local` and `make deploy-arc`) creates a full product
grid so every surface reflects a real venue, not a handful of demos:

- **318 prediction markets** — 48 curated standalone markets (macro / crypto / equities / rates)
  plus a 270-market pool whose slices back the baskets, with maturities staggered across
  short (≤30d) / medium / long (>120d) windows.
- **9 Market Baskets** (`Macro Risk Basket`, `Crypto Majors`, `Rates & Recession`, `Frontier Tech`,
  `Inflation Hedge`, `AI & Chips`, `Big-Cap Equity`, `Crypto Moonshot`, `Global Macro`) — 30 legs each.
- **9 Risk-Slice tranches** — one mirrored senior/junior tranche per basket, coupons 6–20%.
- **5 Protected Notes** (funded on local; on Arc via `make seed-note-arc`) — ETH, BTC, gold,
  recession and AI upside notes, issuer-funded, plus seeded deposits so the UI shows live TVL.

> The address table above is the original **2026-06-04** Arc deploy, which used an earlier minimal
> seed (4 markets + one of each product). To publish the full grid on Arc, re-run `make deploy-arc`
> — it deploys a fresh audited suite, seeds the grid, and rewrites `deployments/5042002.json` (the
> backend's source of truth). That needs the funded deployer key and testnet gas. `make deploy-local`
> produces the identical full grid on Anvil for free.

## Ownership / roles (production custody)

- **Owner** (BasketVault / TrancheVault / ProtectedNote, and PredictionMarket via Ownable2Step):
  curates products and rotates the resolver. Should be a multisig in production.
- **Resolver** (PredictionMarket): resolves / voids markets after close. Should be a multisig or
  oracle in production. Owner can rotate it via `setResolver`.
- The deployer holds all three roles on testnet for convenience.

## Deploy notes

Arc's USDC routes `transferFrom` through a native blocklist precompile that forge's local script
EVM can't execute, so a `forge script` that *moves* USDC reverts in the record/simulation phase.
The deploy therefore seeds USDC-free objects (markets/basket/tranche) in the forge broadcast and
creates the protected note (which funds an issuer position) afterward via `cast`. Both are wired
in the Makefile:

```bash
make deploy-arc        # forge: deploy 4 contracts + markets/basket/tranche, then `make seed-note-arc`
make seed-note-arc     # cast: approve + createNote on market 0
```

Resolution is gated on `block.timestamp >= closeTime`, so the seeded markets (close +30 days)
become resolvable only after that window — the realistic production behavior. Update the root
`.env` after a redeploy, or rely on `deployments/5042002.json`, which the backend reads as the
source of truth.
