# Cumulant — Arc testnet deployment

Network: **Arc Testnet** · chainId `5042002` · RPC `https://rpc.testnet.arc.network`
Explorer: https://testnet.arcscan.app · Audited four-product suite deployed **2026-06-13**

## Addresses

| Contract | Address |
| --- | --- |
| PredictionMarket | `0xB6dD53f568e2d56AaE5095aD057346e4A063a877` |
| BasketVault | `0x1c2Af09997DC9A7985cB59B1f5F7533F17c3e75d` |
| TrancheVault | `0xCc44C4f3b128b4781108266380a2595d89D0CBdf` |
| ProtectedNote | `0xe3cDD4e5082cD9950B7561b6A9744DB9C1D5430A` |
| Test USDC (collateral — freely mintable) | `0x4a929c93ED1B23018EA0277883C7BbA5fbf2fBbF` |
| Owner / resolver / issuer | `0x20A9ae354207181b6eA3aEbd76fD4073a9D4663b` |

Gas is paid in Arc's native USDC (`0x3600…0000`); collateral uses the deployed **Test USDC** above —
anyone can `mint` / `faucet` / `redeem` it (6 decimals), so demos aren't capped by the $20 testnet
faucet. Machine-readable copy: [`deployments/5042002.json`](deployments/5042002.json).

## Deploy transactions

| Tx | Hash |
| --- | --- |
| Deploy MockUSDC (test collateral) | `0x6c46a11c9da0bace397c9976450639c0f513fba7c74a70f9d0ccfb870b3abb89` |
| Deploy PredictionMarket | `0x56363a32d2534089fd3604f5b60a8bcf014df210bd7086c8369ed0ac56f94544` |
| Deploy BasketVault | `0xd08f2d40f8e33ff8a2b13ff6483bc13aa782c27a904d3f1ed5a4bbc9339a3735` |
| Deploy TrancheVault | `0x2b614b338c5b7dd964b48082af53b1aa4a8d9573e364059287fc9b0fee684f78` |
| Deploy ProtectedNote | `0xd5e255b6bb94176f436a72e73ac819c5c9056e2cf421167f7ed315e1696f5357` |

The markets, baskets, tranches, and the funded notes are all created in the same `forge script`
broadcast (see `broadcast/Deploy.s.sol/5042002/run-latest.json`).

## Seeded state

`SEED_DEMO=true` creates a full product grid so every surface reflects a real venue:

- **318 prediction markets** — 48 curated standalone markets (macro / crypto / equities / rates)
  plus a 270-market pool whose slices back the baskets, maturities staggered short / medium / long.
- **9 Market Baskets** (`Macro Risk Basket`, `Crypto Majors`, `Rates & Recession`, `Frontier Tech`,
  `Inflation Hedge`, `AI & Chips`, `Big-Cap Equity`, `Crypto Moonshot`, `Global Macro`) — 30 legs each.
- **9 Risk-Slice tranches** — one mirrored senior/junior tranche per basket, coupons 6–20%.
- **5 Protected Notes** — ETH, BTC, gold, recession and AI upside notes, issuer-funded, plus seeded
  deposits so the UI shows live TVL.

> The address table above is the current live Arc deploy (**2026-06-13**), collateralized in the
> freely-mintable **Test USDC** and seeded with the full grid (318 markets + 9 baskets + 9 tranches +
> 5 notes). To redeploy, run `make deploy-arc-mock`; `make deploy-local` produces the identical grid
> on Anvil for free.

## Test USDC faucet

The collateral token (`0x4a929c93…`) is a freely-mintable ERC-20 (`MockUSDC`, 6 decimals) — no cap:

```bash
# mint 10,000 test USDC to yourself
cast send 0x4a929c93ED1B23018EA0277883C7BbA5fbf2fBbF "faucet(uint256)" 10000000000 \
  --rpc-url https://rpc.testnet.arc.network --private-key $YOUR_KEY
# mint(address,uint256) mints to anyone · redeem(uint256) burns your balance
```

(You still need a little native USDC for gas from [faucet.circle.com](https://faucet.circle.com).)

## Ownership / roles (production custody)

- **Owner** (BasketVault / TrancheVault / ProtectedNote, and PredictionMarket via Ownable2Step):
  curates products and rotates the resolver. Should be a multisig in production.
- **Resolver** (PredictionMarket): resolves / voids markets after close. Should be a multisig or
  oracle in production. Owner can rotate it via `setResolver`.
- The deployer holds all three roles on testnet for convenience.

## Deploy modes (see `Makefile`)

```bash
make deploy-arc-mock   # Arc testnet, collateralized in a freely-mintable MockUSDC (recommended for
                       # demos). The mock has no native blocklist precompile, so the suite + full
                       # funded seed deploy in a single forge broadcast.
make deploy-arc        # Arc testnet against canonical USDC (0x3600…0000). Arc routes USDC
                       # transferFrom through a native precompile forge's script EVM can't execute,
                       # so the note is seeded post-deploy via `make seed-note-arc` (cast).
make deploy-local      # Local Anvil — MockUSDC + the full funded grid, free.
```

Resolution is gated on `block.timestamp >= closeTime`, so seeded markets become resolvable only
after their window. The backend reads `deployments/5042002.json` as the source of truth after a redeploy.
