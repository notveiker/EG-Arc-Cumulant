# Cumulant Architecture

Cumulant turns prediction-market outcome distributions into structured products. The system is
three layers — Solidity on Arc, a viem read/resolver service, and a wallet-signed Next.js app —
with the **chain as the single source of truth**.

```text
Next.js + wagmi/RainbowKit  :13200
        │   (user signs buy / claim / deposit / settle / redeem)
        ▼
   EVM (Anvil :8545 local · Circle Arc chainId 5042002)
   ├─ PredictionMarket.sol  — binary markets, parimutuel payout, USDC collateral
   ├─ BasketVault.sol       — weighted multi-leg basket over markets
   ├─ TrancheVault.sol      — senior/junior waterfall over a basket of legs
   └─ ProtectedNote.sol     — principal-protected note with issuer-funded upside
        ▲
        │   (read state; sign ONLY the resolver role)
   Express + viem  :13201  ──►  JSON: /api/markets /baskets /tranches /notes /portfolio /config
```

## On-chain (`contracts/`)

USDC on Arc (`0x3600…0000`, 6-decimal ERC-20) is the collateral. Arc uses USDC as the native
gas token too, so `msg.value` semantics are USDC and no separate gas asset is needed.

### PredictionMarket.sol
- `createMarket(question, closeTime)` — permissionless; creation carries no trust because only
  the resolver can settle.
- `buy(marketId, side, amount)` — pulls USDC, records a per-trader, per-side stake.
- `resolve(marketId, outcome)` — **resolver-only**. Arc's `PREVRANDAO` is always 0, so outcomes
  come from a trusted oracle/admin, never on-chain randomness.
- `claim(marketId)` — parimutuel: a winner recovers its stake **plus** a pro-rata share of the
  losing pool. Across all winners, payouts sum to exactly the total collateral → every market is
  solvent and self-draining. Winning positions are zeroed on claim (no double-claim).
- Guards: `Ownable2Step` ownership, settable `resolver`, `ReentrancyGuard`, `SafeERC20`.

### BasketVault.sol
- `createBasket(name, marketIds, sides, weightsBps)` — weights sum to 10000; each market may
  back **at most one** basket, so the vault's position in a market belongs to a single basket and
  settlement claims each leg exactly once with no cross-basket attribution math.
- `deposit(basketId, amount)` — splits the deposit by weight and buys every leg in one tx; mints
  shares (1 share = 1 USDC contributed). The vault is the on-chain trader; it pre-approves the
  market once.
- `settle(basketId)` — permissionless once all legs resolve; claims winning legs into the vault.
- `redeem(basketId, shares)` — pro-rata slice of recovered USDC against the share supply frozen
  at settlement.

### TrancheVault.sol
- `createTranche(name, couponBps, marketIds, sides, weightsBps)` — like a basket, plus a senior
  coupon rate. Each market backs at most one tranche.
- `deposit(trancheId, amount, senior)` — senior and junior capital are **pooled** and buy the same
  leg positions; the class only changes the settlement split.
- `settle(trancheId)` — claims winners into `recovered`, then applies the waterfall:
  `seniorEntitlement = seniorPrincipal·(1+couponBps)`, `seniorPot = min(recovered, seniorEntitlement)`,
  `juniorPot = recovered − seniorPot`. Senior is protected only up to the junior buffer.
- `redeem(trancheId, shares, senior)` — pro-rata against the chosen pot.

### ProtectedNote.sol
- `createNote(name, marketId, side, issuerUpside)` — the issuer funds and opens the upside
  position up front; depositor principal is never deployed.
- `deposit(noteId, amount)` — principal reserved 1:1.
- `settle(noteId)` — claims the upside into a shared coupon (0 if the side lost; the issuer ate
  the cost).
- `redeem(noteId)` — `principal + coupon·principal/totalPrincipal`. Payout is always ≥ principal.

### Hardening (post-audit)
- Resolution is gated on `block.timestamp >= closeTime`; a resolver-only `voidMarket` plus a
  no-winner branch in `claim` guarantee funds are never burned or permanently frozen.
- Vault `settle` uses `try/catch` per leg (a single unresolvable/lost leg can't block settlement)
  and flips `settled` before external calls (reentrancy defense-in-depth).
- Product creation (basket/tranche/note) is **owner-curated**; participation is permissionless.
  `MAX_LEGS`, a senior-coupon bound, non-empty names, and a non-zero per-leg allocation close the
  griefing / cross-subsidization vectors. See [`../SECURITY.md`](../SECURITY.md).

Tests: `forge test` runs **62 cases** — unit, every revert path, a parimutuel **solvency fuzz**
(`payout == yes+no`, contract drained), the tranche **waterfall** (junior leverage, junior
first-loss, senior impairment), a protected-note **`payout ≥ principal`** fuzz invariant, and the
void/refund, deposit-bound, leg-cap, coupon-bound, and access-control hardening cases.

## Backend (`backend/`)

Express + viem. `config.ts` resolves the active chain (`arc` | `local`) and contract addresses
(env first, else `contracts/deployments/<chainId>.json`). `contracts.ts` reads markets, baskets,
and portfolios and serializes USDC amounts as `{ raw, usd }`.

The backend **never signs user actions.** Its only signing key is the server-owned resolver
account, used solely for the two resolver routes: `POST /api/resolver/resolve` (the legitimate
admin/oracle role) and `POST /api/resolver/void` (the liveness escape that refunds a stuck market).
This is the core fix over a custodial design: real users own and sign their own trades. On local
the resolver key defaults to Anvil account #0 (the deployer/resolver that holds the seeded USDC);
on Arc it's the funded deployer.

## Frontend (`frontend/`)

Next.js (App Router) + wagmi v2 + viem + RainbowKit, themed to the Cumulant design system.
`lib/tx.ts` exposes `useCumulant()` — each action (`buy`, `claim`, `depositBasket`, `settleBasket`,
`redeemBasket`, `resolve`) handles inline USDC approval and waits for the receipt. Read data comes
from the backend via React Query; writes go straight to Arc through the connected wallet, so the
UI reflects real on-chain odds, positions, and explorer-linked transactions.

## Why this is "production-shaped"

Earlier prototypes signed user actions with a backend dev key and kept positions in
browser-local storage. Cumulant removes both: **all user state lives on-chain**, **all user
actions are wallet-signed**, and collateral is **real network USDC** rather than a mock. What
remains for production is breadth (an event indexer, resolver decentralization, a third-party
audit), not a change of trust model.
