# Dynamic setup (ETHGlobal NY 2026)

Everything needed to integrate [Dynamic](https://www.dynamic.xyz/docs/overview/ethglobal-new-york-2026)
(login + embedded wallets + signing) is wired in and **live** — `app/layout.tsx` boots the
Dynamic provider (`app/providers.dynamic.tsx`); RainbowKit (`app/providers.tsx`) is kept only
as a reversible fallback.

## What's already done

- **SDK packages** installed in `frontend/`: `@dynamic-labs/sdk-react-core`,
  `@dynamic-labs/ethereum`, `@dynamic-labs/wagmi-connector` (all v4.88.6).
- **Env vars**: `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` added to
  `frontend/.env.local` (placeholder), `frontend/.env.example`, and the root
  `.env.example`.
- **Config module**: `frontend/lib/dynamic.ts` — environment id, Arc-testnet +
  Anvil custom EVM networks, and a wagmi config for the Dynamic path.
- **Provider (LIVE)**: `frontend/app/providers.dynamic.tsx` — the active provider
  booted by `app/layout.tsx`, ordered `DynamicContextProvider → WagmiProvider →
  QueryClientProvider → DynamicWagmiConnector`. The widget is rendered via
  `app/app/_components/ConnectButton.tsx` (`<DynamicWidget variant="dropdown" />`).
- **Docs MCP for Claude Code**: `.mcp.json` points Claude Code at the live
  Dynamic docs (`https://www.dynamic.xyz/docs/mcp`).

## The one manual step: environment id

1. Go to <https://app.dynamic.xyz> and sign in (create a free account if needed).
2. Create a **Sandbox** environment (good enough for the hackathon).
3. Copy **Developers → SDK & API Keys → Environment ID**.
4. Paste it into `frontend/.env.local`:
   ```
   NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID=<your-env-id>
   ```
   (`NEXT_PUBLIC_*` is inlined at build time — restart `npm run dev` after editing.)
5. In the dashboard, enable **EVM** and add **Email** / wallet log-in methods.

## How it's wired (current state)

Dynamic is the live wallet layer. `frontend/app/layout.tsx` imports
`Providers` from `./providers.dynamic`, and the header wallet control is
`<DynamicWidget variant="dropdown" />` (in `app/app/_components/ConnectButton.tsx`).
Existing wagmi hooks (`useAccount`, `useWalletClient`, the signer helpers in
`lib/tx.ts`) keep working — `DynamicWagmiConnector` syncs the logged-in wallet
into wagmi, and all on-chain writes are signed client-side by the connected
wallet.

**Reverting to RainbowKit (fallback):** swap the `layout.tsx` import back to
`./providers` and restore the RainbowKit `ConnectButton`. Kept only as an
escape hatch; Dynamic is the intended path.

**Signing note:** email login creates a Dynamic **embedded (MPC) wallet**. On a
Sandbox environment the MPC signer is rate-limited — if signatures stall, the
write path now times out with an actionable error (see `withWalletTimeout` in
`lib/tx.ts`); connecting an external wallet (e.g. MetaMask) bypasses MPC.

## Claude Code MCP

`.mcp.json` is project-scoped, so Claude Code in this repo will offer to enable
the `dynamic` docs server on first run (approve it). To register it manually:

```bash
claude mcp add --transport http dynamic https://www.dynamic.xyz/docs/mcp
```

Optional dashboard-as-code CLI:

```bash
npm install -g @dynamic-labs/dynamic-console-cli
dyn auth login
```

## Useful references

- ETHGlobal NY 2026 hub: <https://www.dynamic.xyz/docs/overview/ethglobal-new-york-2026>
- React + wagmi: <https://www.dynamic.xyz/docs/react/reference/using-wagmi>
- Custom EVM networks: <https://www.dynamic.xyz/docs/react/chains/adding-custom-networks>
- React via JS SDK example: <https://github.com/dynamic-labs-oss/react-via-js-example-app>
