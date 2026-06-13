"use client";

/**
 * Dynamic (dynamic.xyz) provider tree — login (email / social / passkey) + embedded
 * wallets + signing, bridged into wagmi so all existing wagmi-based trading keeps working.
 *
 * LIVE: app/layout.tsx boots this provider. RainbowKit (./providers.tsx) is kept only as a
 * reversible fallback — flip the layout import back to "./providers" to restore it.
 *
 * Provider order: DynamicContextProvider → WagmiProvider → QueryClientProvider →
 * DynamicWagmiConnector. Ref: https://www.dynamic.xyz/docs/react/reference/using-wagmi
 *
 * Client-only mount: Dynamic injects styles/DOM during render that differ between the SSR
 * pass and the client, which trips React's hydration check ("Text content did not match").
 * We render an SSR-stable placeholder until mount, then mount the Dynamic→wagmi tree on the
 * client only — eliminating the hydration mismatch / dev error overlay.
 */
import { useEffect, useMemo, useState } from "react";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { useTheme } from "@/lib/theme";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DYNAMIC_ENVIRONMENT_ID,
  dynamicEvmNetworks,
  dynamicWagmiConfig,
} from "@/lib/dynamic";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Follow the app's light/dark toggle so Dynamic's widget + modal match the chrome.
  const { theme } = useTheme();

  // STABLE settings identity. Everything here is a module constant, so memoise with
  // empty deps: passing a fresh `settings` object (and a fresh connectors array) on
  // every render makes the Dynamic SDK re-initialise its connectors — including the
  // embedded MPC websocket — which spams reconnects and gets the signer rate-limited
  // (HTTP 429), so wallet-signed writes hang waiting for an MPC co-sign that never
  // returns. A constant reference keeps the SDK initialised exactly once.
  const settings = useMemo(
    () => ({
      environmentId: DYNAMIC_ENVIRONMENT_ID,
      walletConnectors: [EthereumWalletConnectors],
      // Arc testnet + Anvil aren't in Dynamic's default list — declare them here.
      overrides: { evmNetworks: dynamicEvmNetworks },
    }),
    [],
  );

  // SSR and the first client render both produce this identical static shell (no Dynamic),
  // so there is nothing for React to mismatch. Dynamic mounts on the client after hydration.
  if (!mounted) {
    return <div suppressHydrationWarning style={{ minHeight: "100vh", background: "var(--c-bg)" }} />;
  }

  return (
    <DynamicContextProvider
      theme={theme}
      settings={settings}
    >
      <WagmiProvider config={dynamicWagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  );
}
