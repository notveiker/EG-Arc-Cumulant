# Dynamic (dynamic.xyz) × Cumulant — ETHGlobal NY 2026

API source of truth: the Dynamic docs (MCP in `.mcp.json` → https://www.dynamic.xyz/docs).
Environment: **Sandbox**, Arc testnet (chainId 5042002). Frontend env id in `frontend/.env.local`
(`NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID`).

## Status

| # | Track | Cumulant flow | State |
|---|---|---|---|
| 1 | **Wallet Glow Up** (core) | Email / social / passkey + embedded wallet → trade with no extension | ✅ **done + verified** — app boots on Dynamic, tsc clean, all routes 200. Needs dashboard login-method toggles to populate the modal. |
| 2 | **Flow** (headline) | Fund a product with any token/chain (or exchange) → settle Arc USDC → unlock the on-chain deposit | ✅ **backend done + verified** (HMAC webhook → eligibility → gate); ✅ **frontend wired + gated** (`FlowFundCard` on the ppn buy panel). Needs dashboard Flow + `DYNAMIC_WEBHOOK_SECRET` to go live. |
| 1c | Gas sponsorship | Sign an Arc deposit without pre-funding USDC-gas | 📋 documented (ZeroDev + dashboard + 1 connector line) — not wired, to keep Track 1 stable. |
| 3 | Agentic (stretch) | Robo-structurer server wallet auto-`settle()`/`redeem` | 📋 module outline. |

## Dynamic facets incorporated (grounded in the docs)

Cumulant now touches Dynamic across several surfaces, not just login:

| Facet | Dynamic API | Where in Cumulant |
|---|---|---|
| Email / social / passkey auth | `DynamicContextProvider` + `setShowAuthFlow` | every connect entry point |
| Embedded (MPC) wallet | embedded-wallet connectors | no-extension users get an Arc wallet |
| wagmi bridge for all trading | `DynamicWagmiConnector` | `lib/tx.ts useCumulant` (unchanged) |
| Cross-chain / exchange funding | Fireblocks **Flow** + HMAC webhooks | `FlowFundCard` + `/api/flow/*` |
| **Human identity** | `useDynamicContext().user` (email / social) | connect pill + card show "signed in as …" |
| **Multi-wallet identity** | `useUserWallets()` | linked-wallet chip (`+N`) in the header |
| **Cross-wallet book** | `useUserWallets()` + `/api/portfolio/:addr` | portfolio aggregates on-chain positions across every linked wallet (`LinkedWalletsCard` + `useLinkedPortfolio`) |
| **Auth state** | `useIsLoggedIn()` | gates identity rendering |
| **Verified JWT (ready)** | `getAuthToken()` | exposed via `useDynamicIdentity().getToken()` for authenticated backend calls |

`useDynamicIdentity()` (`app/app/_lib/dynamic-identity.ts`) bundles the identity facets into one
type-safe hook; all reads are defensive so it renders harmlessly when logged out.

## What's built + verified

### Track 1 — wallet (code)
- `app/layout.tsx` boots **`./providers.dynamic`** (`DynamicContextProvider → WagmiProvider → QueryClientProvider → DynamicWagmiConnector`). RainbowKit kept in `./providers` + `lib/wagmi.ts` as a **one-line-revert fallback**.
- Four RainbowKit wrappers → Dynamic (`useDynamicContext` / `setShowAuthFlow`), Tidal theme preserved: `app/app/_components/{ConnectButton,ConnectModal}.tsx`, `components/{ConnectButton,ConnectWalletCard}.tsx`.
- **`lib/tx.ts` `useCumulant` untouched** — pure wagmi, so every buy/deposit/claim/settle/redeem resolves the Dynamic wallet via `DynamicWagmiConnector`.

### Track 2 — Flow (back + front)
- **Backend** (`backend/src/services/flow.ts`, `routes/flow.ts`, mounted at `/api/flow`):
  - `POST /api/flow/webhook` — verifies the Dynamic **HMAC-SHA256** signature (`x-dynamic-signature: sha256=<hex>` over the JSON body, timing-safe), then records the settlement (destination wallet + bundle + USDC). **Fail-closed**: a configured secret must verify; an unset secret is rejected on Arc (503), accepted only on local dev. Verified end-to-end against the compiled code: valid sig → recorded, bad/missing sig → rejected.
  - `GET /api/flow/eligibility/:wallet/:bundle` — has this wallet's Flow deposit for this bundle settled? (gates the on-chain deposit)
  - `GET /api/flow/status` — is the webhook wired? (frontend feature gate)
  - **No on-chain signing, no resolver change** — the user still signs the deposit with their own wallet.
- **Frontend** (`app/app/_lib/flow-client.ts`, `app/app/_components/FlowFundCard.tsx`, wired into `app/app/ppn/page.tsx`):
  - `FlowFundCard` reads `/api/flow/eligibility`, opens Dynamic's flow (`setShowAuthFlow`) for the cross-chain pay, polls until settled, then shows the deposit as unlocked. Gated by `NEXT_PUBLIC_DYNAMIC_FLOW_ENABLED` — shows an informational state until enabled (no broken button).

Verification: `npx tsc --noEmit` clean (front + back) · backend builds · app boots on Dynamic · `/api/flow/*` behave correctly (status, eligibility, fail-closed 503, signed-path unit-verified) · `/app/ppn` renders 200 with the Flow card.

## New env vars
- **Backend** `DYNAMIC_WEBHOOK_SECRET` — Dynamic webhook signing secret (fail-closed when unset). See `.env.example`.
- **Frontend** `NEXT_PUBLIC_DYNAMIC_FLOW_ENABLED=true` — shows the "Fund from any chain" entry once Flow is on.

## ⚠️ Dashboard steps you must do (Sandbox — I can't reach it)

https://app.dynamic.xyz → the Sandbox env matching `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID`:

1. **Log in & User Profile** → enable **Email**, **Social**, **Passkey** (populates the `setShowAuthFlow` modal).
2. **Embedded Wallets** → enable **EVM** embedded wallets (email/social user → auto Arc wallet).
3. **Chains & Networks** → allow **Arc Testnet (5042002)**.
4. **(Track 2 Flow)** Enable Fireblocks Flow, settle-asset = **Arc USDC**; **Developers → Webhooks** → create an endpoint pointing at `https://<your-backend>/api/flow/webhook`, copy the **signing secret** to backend `DYNAMIC_WEBHOOK_SECRET`, then set `NEXT_PUBLIC_DYNAMIC_FLOW_ENABLED=true`. (Reconcile the webhook payload field names with `routes/flow.ts`'s extractor — they're centralized there.)
5. **(Track 1c gas)** Smart Wallets → enable AA + a **ZeroDev gas policy for Arc 5042002**, then add `@dynamic-labs/ethereum-aa` connectors to `settings.walletConnectors` in `providers.dynamic.tsx`. EIP-7702 is the default. Tell me when it's on and I'll wire the connector.

## 60-second judge demo
1. Open `http://localhost:13200/app/ppn` as a brand-new user — no browser wallet.
2. Click **Connect / deploy** → Dynamic modal → **log in with email** → an Arc embedded wallet is created instantly.
3. On the buy panel, **Fund from any chain** → pay **$100 USDC on Base** via Flow → it settles to **Arc USDC**; the card flips to "✓ Funded via Flow" and unlocks the deposit.
4. **(gas)** Sign the on-chain `deposit` — **gas sponsored**, no Arc USDC needed.
5. `/app/portfolio` → the note position is live on Arc with an **Arcscan** link.

(Steps 1–2 + 5 are live once the dashboard login methods are on; step 3 lights up after Flow + the webhook secret; step 4 after the gas policy.)

## Next (code, when dashboard is set)
- **Track 1c:** add `@dynamic-labs/ethereum-aa` connectors (gated by a flag) once the ZeroDev policy exists.
- **Track 2 polish:** reconcile the webhook payload extractor against a live Flow event; extend `FlowFundCard` onto the basket/tranche buy paths (same component, drop-in).
- **Track 3:** `backend/src/agents/robo-structurer.ts` — Dynamic **server wallet** (key in server env/KMS, never frontend or git) watching resolved legs to call `settle()` / `redeem`.
