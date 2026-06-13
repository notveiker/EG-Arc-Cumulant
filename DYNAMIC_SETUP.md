# Dynamic setup (ETHGlobal NY 2026)

Everything needed to integrate [Dynamic](https://www.dynamic.xyz/docs/overview/ethglobal-new-york-2026)
(login + embedded wallets + signing) is pre-wired so you can start building
immediately. The setup is **non-breaking** — the app still boots through the
existing RainbowKit provider until you flip the switch.

## What's already done

- **SDK packages** installed in `frontend/`: `@dynamic-labs/sdk-react-core`,
  `@dynamic-labs/ethereum`, `@dynamic-labs/wagmi-connector` (all v4.88.6).
- **Env vars**: `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` added to
  `frontend/.env.local` (placeholder), `frontend/.env.example`, and the root
  `.env.example`.
- **Config module**: `frontend/lib/dynamic.ts` — environment id, Arc-testnet +
  Anvil custom EVM networks, and a wagmi config for the Dynamic path.
- **Provider scaffold**: `frontend/app/providers.dynamic.tsx` — a drop-in
  alternative to `app/providers.tsx`, ordered `DynamicContextProvider →
  WagmiProvider → QueryClientProvider → DynamicWagmiConnector`.
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

## Flip the app over to Dynamic (when ready)

In `frontend/app/layout.tsx`, swap the provider import:

```diff
- import { Providers } from "./providers";
+ import { Providers } from "./providers.dynamic";
```

Then render Dynamic's UI where the wallet button lives (replace the RainbowKit
`ConnectButton`):

```tsx
import { DynamicWidget } from "@dynamic-labs/sdk-react-core";
// ...
<DynamicWidget />
```

Existing wagmi hooks (`useAccount`, `useWalletClient`, the helpers in
`lib/tx.ts`) keep working — `DynamicWagmiConnector` syncs the logged-in wallet
into wagmi.

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
