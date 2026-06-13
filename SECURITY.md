# Cumulant — Security Audit & Hardening

This document records the internal security review of the Cumulant contracts and the fixes
applied. It is an **engineering self-audit**, not a substitute for a professional third-party
audit (see [Production readiness](#production-readiness)).

## Method

Three independent reviewers audited all four contracts (`PredictionMarket`, `BasketVault`,
`TrancheVault`, `ProtectedNote`) from separate angles:

1. **Reentrancy & call ordering** (CEI, cross-contract paths, read-only reentrancy).
2. **Accounting & solvency** (conservation of funds, double-claim, rounding, stuck funds, share
   accounting, first-depositor attacks).
3. **Access control, DoS/griefing & edge cases** (privilege, market reservation, resolution
   timing, unbounded loops, input validation).

Headline result: **no theft and no insolvency** were found — the parimutuel payout, basket
pro-rata, tranche waterfall, and note principal-protection math are sound, and the contracts are
reentrancy-safe (`nonReentrant` + `SafeERC20` + hookless canonical USDC, with state writes that
gate double-spend performed before transfers). The substantive findings were **liveness** and
**griefing**, all addressed below.

## Findings and fixes

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| H‑1 | High | `resolve` had no close-time check → resolver/front-runner could trade against a known outcome | **Fixed** — `resolve` requires `block.timestamp >= closeTime` |
| H‑3 | High | `settle` reverts unless every leg is resolved → one unresolvable leg permanently freezes all depositor funds | **Fixed** — `voidMarket` escape hatch + `try/catch` per-leg settle so funds are always recoverable |
| M‑2 | Medium | Resolving to a side nobody staked burned the whole pool | **Fixed** — `claim` refunds everyone their stake when the winning side has zero stake (or the market is voided) |
| TV‑1 | Medium | All-senior tranche with surplus recovery stranded the (empty) junior pot forever | **Fixed** — when `juniorPrincipal == 0`, senior takes all recovered |
| BV‑1 | Low/Med | Sub-weight deposits skipped leg buys while minting full shares → silent cross-subsidization | **Fixed** — every leg must receive a non-zero allocation (`DepositTooSmall`), enforcing a sane minimum |
| C‑1 | High* | Permissionless product creation let a griefer squat a market for free and block legitimate use | **Fixed** — product creation is owner-curated (`onlyOwner`); participation stays permissionless |
| M‑5 | Medium | Unbounded leg arrays → gas-DoS of `deposit`/`settle` and state bloat | **Fixed** — `MAX_LEGS = 40` |
| M‑4 | Medium | `seniorCouponBps` unbounded (footgun) | **Fixed** — bounded to `MAX_COUPON_BPS = 50000` (500%) |
| PN‑orphan | Low | A winning note with no depositors stranded the issuer's coupon | **Fixed** — issuer `reclaim` |
| L‑1 | Low | Empty `question`/`name` accepted | **Fixed** — non-empty checks |
| RE‑DiD | Info | `settle` set `settled` after the claim loop | **Fixed** — `settled` flipped before external calls (defense-in-depth) |

\* C‑1 is critical only under permissionless creation; owner-curation removes the vector.

New tests cover every fix: void/no-winner refunds, junior-empty waterfall, deposit-too-small,
too-many-legs, coupon bound, owner-gating, and issuer reclaim. **62 Foundry tests pass**,
including the parimutuel solvency fuzz and the note `payout ≥ principal` fuzz.

## Accepted design decisions (documented, not bugs)

- **Trusted resolver/owner.** Real-world outcomes can't be determined on-chain (and Arc's
  `PREVRANDAO` is 0), so resolution is centralized. Privilege is minimized — the resolver can only
  resolve/void, the owner can only curate products and rotate the resolver — and both should be a
  **multisig** in production.
- **Parimutuel dust.** Per-winner integer division can leave sub-cent USDC permanently in a market
  (always rounds down → never insolvent). Negligible; a `skim` could be added if strict
  conservation is required.
- **Void with depositors (notes).** On a void, the issuer's upside is refunded into the note and
  distributed to depositors as coupon. Principal stays fully protected (`payout ≥ principal`); the
  issuer bears void risk. Minor economic quirk, documented.
- **Internal shares.** Basket/tranche/note positions are internal accounting, not yet ERC-1155.

## Backend hardening

- `helmet` security headers; `x-powered-by` disabled; JSON body capped at 16 kb.
- Rate limiting (240/min global, 20/min on the mutating resolver routes).
- Error sanitization — internal RPC/viem details are logged server-side only; clients get a safe
  message (a contract revert reason when present, otherwise generic).
- The backend signs **only** the server-owned resolver/owner role; all user trades are
  wallet-signed client-side.

## Production readiness

Cumulant is a **testnet build hardened to a high engineering standard**, not a mainnet-audited
protocol. Before real value:

- Commission a professional third-party audit and (ideally) formal verification of the waterfall
  and parimutuel invariants.
- Move owner / resolver to a multisig with a timelock; consider an optimistic-oracle resolution
  with a dispute window.
- Add `Pausable` kill-switches and an event indexer; tokenize shares (ERC-1155).
- Run the full suite in CI with coverage and a fuzz/invariant campaign.

> Testnet only. Not investment advice.
