# Cumulant — Arc testnet deployment

Network: **Arc Testnet** · chainId `5042002` · RPC `https://rpc.testnet.arc.network`
Explorer: https://testnet.arcscan.app

Run `make deploy-arc` to deploy the audited four-product suite, then fill in the addresses and
tx hashes below from your own deployment.

## Addresses

| Contract | Address |
| --- | --- |
| PredictionMarket | `<set after deploy>` |
| BasketVault | `<set after deploy>` |
| TrancheVault | `<set after deploy>` |
| ProtectedNote | `<set after deploy>` |
| USDC (collateral + native gas) | `0x3600000000000000000000000000000000000000` |
| Owner / resolver / issuer | `<your deployer address>` |

Machine-readable copy: `deployments/<chainId>.json` (written by the deploy; gitignored).

## Deploy transactions

| Tx | Hash |
| --- | --- |
| Deploy PredictionMarket | `<tx hash>` |
| Deploy BasketVault | `<tx hash>` |
| Deploy TrancheVault | `<tx hash>` |
| Deploy ProtectedNote | `<tx hash>` |
| Seed note — createNote | `<tx hash>` |

The markets, baskets, and tranches are created in the same `forge script` broadcast (recorded
under `broadcast/` locally; gitignored).

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

> `make deploy-arc` deploys a fresh audited suite, seeds the grid, and writes
> `deployments/<chainId>.json` (the backend's source of truth). It needs a funded deployer key and
> testnet gas. `make deploy-local` produces the identical full grid on Anvil for free.

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
`.env` after a redeploy, or rely on `deployments/<chainId>.json`, which the backend reads as the
source of truth.
