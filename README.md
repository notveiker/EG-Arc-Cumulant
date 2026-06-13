# Cumulant

**Structured products on prediction markets — collateralized in USDC, built for Circle Arc.**

A _cumulant_ is the statistical object that describes the **shape of a probability
distribution**. Cumulant the protocol carves prediction-market outcome distributions into
four on-chain products — **binary markets**, **baskets**, **risk tranches**, and
**principal-protected notes** (all on one parimutuel engine) — plus **Distribution Markets**, a
live quoting surface that lets you trade a full probability curve against the market's
CLOB-implied curve.

Everything runs on the **EVM** with **USDC as both collateral and gas** (Circle Arc's model).
There is no mock token in production and no custodial backend signer: **every trade is signed by
the user's own wallet.** The full suite runs locally end-to-end on Anvil and deploys to Arc with
one command.

---

## The products

| Product | What it is |
| --- | --- |
| **PredictionMarket** | USDC-collateralized binary (YES/NO) markets. `createMarket → buy → resolve → claim`. Parimutuel: a winner recovers its stake plus a pro-rata share of the losing pool. Solvent by construction. |
| **BasketVault** | Bundles several markets at fixed weights. One `deposit` buys every leg on-chain and mints shares; `settle` claims winners; `redeem` pays pro-rata. |
| **TrancheVault** | Senior/junior **waterfall** over a basket of legs. Senior is paid first up to principal + a coupon; junior absorbs first losses and keeps the leveraged residual. |
| **ProtectedNote** | **Principal-protected** note. Principal is reserved 1:1 and always returned; an issuer-funded position adds convex upside (a coupon) if the market resolves the note's way. |
| **Distribution Markets** | A live **off-chain quoting** surface (no contract): discovers multi-band Polymarket events, lets you shape a target probability curve against the CLOB-implied reference, and quotes a net-USDC position sized from the L2 distance to the market. Served by `/api/distribution/*`. |

## What works

- All four Solidity contracts, with **63 passing Foundry tests** — unit, every revert path, a
  parimutuel **solvency fuzz**, the tranche **waterfall** (junior leverage, junior first-loss,
  senior impairment), a protected-note **`payout ≥ principal` invariant** fuzz, and the
  liveness/void/refund and access-control hardening cases.
- A **3-perspective security self-audit** (reentrancy, solvency, access-control/DoS) with all
  findings fixed — see [`SECURITY.md`](SECURITY.md). No theft or insolvency was found; the fixes
  address liveness (unresolvable legs can't freeze funds) and griefing (curated product creation).
- **Backend** (Express + viem) reads every market / basket / tranche / note / portfolio from
  chain as JSON. The **only** thing it signs is the server-owned resolver role.
- **Frontend** (Next.js App Router + wagmi + Dynamic) — a route per product
  (`/app/portfolio`, `/app/basket` + `/basket/[id]`, `/app/tranche` + `/tranche/[id]`, `/app/ppn`,
  `/app/distribution`, `/app/docs`). Connect a wallet and sign your own
  `buy / claim / deposit / settle / redeem` across all four on-chain products; live odds,
  senior/junior splits, projected coupons, a portfolio read straight from chain, and explorer links.
- **Distribution Markets** — the live quoting surface streams Polymarket candidates, prices a target
  curve against the CLOB-implied reference, and stages a launch plan.
- Verified **end-to-end** on both Anvil and Arc: deploy + a 318-market / 9-basket / 9-tranche /
  5-note seed, real deposits driven through every product, backend reflects on-chain TVL, every
  route renders live state.

## Repository layout

```text
contracts/   Foundry — PredictionMarket, BasketVault, TrancheVault, ProtectedNote + tests + deploy
backend/     Express API reading/writing Cumulant via viem (arc | local)
frontend/    Next.js app — wallet-signed trading UI
.env         Shared chain + deployer config (gitignored)
```

## Quickstart (local-first)

Prereqs: Node 20+, [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
cp .env.example .env

# 1. Local chain + full deployment
anvil &                         # local EVM on :8545
cd contracts
forge test                      # 63 passing
make deploy-local               # deploys MockUSDC + all 4 contracts + demo seed

# 2. Backend (reads the local deployment)
cd ../backend && npm install
CUMULANT_CHAIN=local npm run dev # http://localhost:13201

# 3. Frontend
cd ../frontend && npm install    # .env.local: NEXT_PUBLIC_CHAIN=local
npm run dev                      # http://localhost:13200
```

Deploy to **Arc testnet** instead: fund `DEPLOYER_PRIVATE_KEY` with a little native USDC for gas at
[faucet.circle.com](https://faucet.circle.com), run `make deploy-arc-mock`, and set
`CUMULANT_CHAIN=arc` / `NEXT_PUBLIC_CHAIN=arc`. `deploy-arc-mock` collateralizes the suite in a
freely-mintable **Test USDC** so demos aren't capped by the $20 faucet; `make deploy-arc` instead
uses Arc's canonical USDC at `0x3600…0000` as both collateral and gas.

The **full four-product suite is live on Arc testnet** ([explorer](https://testnet.arcscan.app)):

| Contract | Address |
| --- | --- |
| PredictionMarket | `0xB6dD53f568e2d56AaE5095aD057346e4A063a877` |
| BasketVault | `0x1c2Af09997DC9A7985cB59B1f5F7533F17c3e75d` |
| TrancheVault | `0xCc44C4f3b128b4781108266380a2595d89D0CBdf` |
| ProtectedNote | `0xe3cDD4e5082cD9950B7561b6A9744DB9C1D5430A` |
| Test USDC (collateral — freely mintable) | `0x4a929c93ED1B23018EA0277883C7BbA5fbf2fBbF` |

Mint test collateral with no cap — `faucet(uint256)` / `mint(address,uint256)` on the Test USDC,
`redeem(uint256)` to burn. Full addresses, tx hashes, and the faucet command are in
[`contracts/DEPLOYMENT.md`](contracts/DEPLOYMENT.md).

## Verification

```bash
cd contracts && forge test            # 63 passing
cd backend   && npm run build         # backend types/build
cd frontend  && npm run build         # frontend build
curl localhost:13201/api/health       # chain + contract status (markets/baskets/tranches/notes)
```

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md). In short: the Solidity contracts are the single source
of truth; the backend is a thin typed read layer (plus the resolver role); the frontend signs
every user action with the connected wallet.

## Roadmap

1. **ERC-1155 product shares** — make basket/tranche/note positions transferable and composable.
2. **Event indexer** — replace per-call reads with an indexed cache for scale.
3. **Resolver decentralization** — move resolution to a multisig / optimistic oracle.
4. **On-chain distribution settlement** — bring the Distribution Markets quoting surface fully
   on-chain (continuous outcome bands over the same parimutuel engine).
5. **Third-party audit + multisig custody** — before any mainnet deployment.

> Testnet demo. Not investment advice.
