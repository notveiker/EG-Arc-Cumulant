/**
 * Dynamic (dynamic.xyz) configuration — login + embedded wallets + signing.
 *
 * This is a NON-BREAKING scaffold. The app currently boots through the
 * RainbowKit provider in `app/providers.tsx`. To switch to Dynamic, point
 * `app/layout.tsx` at `./providers.dynamic` instead (see DYNAMIC_SETUP.md).
 *
 * Docs (live, via the Dynamic MCP wired up in ../.mcp.json):
 *   React + wagmi: https://www.dynamic.xyz/docs/react/reference/using-wagmi
 *   Custom EVM networks: https://www.dynamic.xyz/docs/react/chains/adding-custom-networks
 */
import { createConfig } from "wagmi";
import { http } from "viem";
import { arcTestnet, anvil, ACTIVE_CHAIN } from "./chains";

/** Public, client-side environment id from the Dynamic dashboard. */
export const DYNAMIC_ENVIRONMENT_ID =
  process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? "";

/**
 * Custom EVM networks for Dynamic. Arc testnet (and local Anvil) are not in
 * Dynamic's default network list, so we declare them here and pass them via
 * `settings.overrides.evmNetworks` in the provider. Mirror these to your
 * Dashboard → Chains & Networks if you prefer dashboard-driven config.
 */
export const dynamicEvmNetworks = [
  {
    blockExplorerUrls: ["https://testnet.arcscan.app"],
    chainId: arcTestnet.id, // 5042002
    name: "Arc Testnet",
    chainName: "Arc Testnet",
    vanityName: "Arc Testnet",
    iconUrls: ["https://app.dynamic.xyz/assets/networks/eth.svg"],
    nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
    networkId: arcTestnet.id,
    rpcUrls: ["https://rpc.testnet.arc.network"],
  },
  {
    blockExplorerUrls: [],
    chainId: anvil.id, // 31337
    name: "Anvil",
    chainName: "Anvil",
    vanityName: "Anvil (local)",
    iconUrls: ["https://app.dynamic.xyz/assets/networks/eth.svg"],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    networkId: anvil.id,
    rpcUrls: ["http://127.0.0.1:8545"],
  },
];

/**
 * Wagmi config for the Dynamic path. Note `multiInjectedProviderDiscovery:
 * false` — Dynamic implements EIP-6963 provider discovery itself. Pass every
 * chain you want wagmi hooks to work against (Dynamic syncs the active wallet
 * into these). Kept separate from `./wagmi.ts` (RainbowKit) so the two paths
 * don't interfere.
 */
export const dynamicWagmiConfig = createConfig({
  chains: ACTIVE_CHAIN.id === anvil.id ? [anvil, arcTestnet] : [arcTestnet, anvil],
  multiInjectedProviderDiscovery: false,
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
    [anvil.id]: http("http://127.0.0.1:8545"),
  },
});
