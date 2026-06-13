"use client";

/**
 * Dynamic (dynamic.xyz) provider tree — login + embedded wallets + signing,
 * bridged into wagmi so all the existing wagmi-based trading code keeps working.
 *
 * This is a DROP-IN ALTERNATIVE to ./providers.tsx (RainbowKit). It is NOT wired
 * in yet. To switch the app over, edit app/layout.tsx:
 *
 *     - import { Providers } from "./providers";
 *     + import { Providers } from "./providers.dynamic";
 *
 * and replace <ConnectButton/> usages with Dynamic's <DynamicWidget/> (or use the
 * `useDynamicContext()` hook). Then set NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID in
 * .env.local. See DYNAMIC_SETUP.md and the Dynamic docs MCP (../.mcp.json).
 *
 * Provider order matters: DynamicContextProvider → WagmiProvider →
 * QueryClientProvider → DynamicWagmiConnector.
 * Ref: https://www.dynamic.xyz/docs/react/reference/using-wagmi
 */
import { useState } from "react";
import {
  DynamicContextProvider,
} from "@dynamic-labs/sdk-react-core";
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

  return (
    <DynamicContextProvider
      settings={{
        environmentId: DYNAMIC_ENVIRONMENT_ID,
        walletConnectors: [EthereumWalletConnectors],
        // Arc testnet + Anvil aren't in Dynamic's default list — declare them here.
        overrides: { evmNetworks: dynamicEvmNetworks },
      }}
    >
      <WagmiProvider config={dynamicWagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  );
}
