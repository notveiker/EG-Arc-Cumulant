# Cumulant — Arc testnet deployment

Network: **Arc Testnet** · chainId `5042002` · RPC `https://rpc.testnet.arc.network`
Explorer: https://testnet.arcscan.app · Audited four-product suite

## Addresses

Current live deploy — these match [`deployments/5042002.json`](deployments/5042002.json), the
source of truth the backend reads after any redeploy.

| Contract | Address |
| --- | --- |
| PredictionMarket | `0xD8cAE8f89063fFaE0B508D50DFF9DDC73093507b` |
| BasketVault | `0x961f7CAc643cBe81F807F145f7d19a2ff9E989ac` |
| TrancheVault | `0x47861b4dF86918932f5feED504BE3BA45C229851` |
| ProtectedNote | `0xEDF1a7EE11138e73E8d357a26bF3A26F7480ABC1` |
| Test USDC (collateral — freely mintable) | `0xFaA6d484F86E696EE59fF1A71f52a48e8a978306` |
| Owner / resolver / issuer | `0x20A9ae354207181b6eA3aEbd76fD4073a9D4663b` |

Gas is paid in Arc's native USDC (`0x3600…0000`); collateral uses the deployed **Test USDC** above —
anyone can `mint` / `faucet` / `redeem` it (6 decimals), so demos aren't capped by the $20 testnet
faucet. Machine-readable copy: [`deployments/5042002.json`](deployments/5042002.json).

## Deploy transactions

The contracts, markets, baskets, tranches, and funded notes are all created in a single `forge
script` broadcast. The per-tx hashes for the current deploy are in
`broadcast/Deploy.s.sol/5042002/run-latest.json`; the resulting addresses are the table above and in
[`deployments/5042002.json`](deployments/5042002.json).

## Seeded state

`SEED_DEMO=true` creates a full product grid so every surface reflects a real venue:

- **66 prediction markets** — curated standalone markets plus the slices that back the baskets,
  maturities staggered short / medium / long.
- **9 Baskets** — the `CMLT-{TIER}-{WINDOW}` catalog: `CMLT-HIGH-SHORT`, `CMLT-HIGH-MED`,
  `CMLT-HIGH-LONG`, `CMLT-MID-SHORT`, `CMLT-MID-MED`, `CMLT-MID-LONG`, `CMLT-LOW-SHORT`,
  `CMLT-LOW-MED`, `CMLT-LOW-LONG` (risk tier × maturity window).
- **9 Tranches** — one mirrored senior/junior tranche per basket.
- **5 Protected Notes** — issuer-funded, plus seeded deposits so the UI shows live TVL.

> The address table above is the current live Arc deploy, collateralized in the freely-mintable
> **Test USDC** and seeded with the full grid (66 markets + 9 CMLT baskets + 9 tranches + 5 notes).
> To redeploy, run `make deploy-arc-mock`; `make deploy-local` produces the identical grid on Anvil
> for free.

## Test USDC faucet

The collateral token (`0xFaA6d484…`) is a freely-mintable ERC-20 (`MockUSDC`, 6 decimals) — no cap:

```bash
# mint 10,000 test USDC to yourself
cast send 0xFaA6d484F86E696EE59fF1A71f52a48e8a978306 "faucet(uint256)" 10000000000 \
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
