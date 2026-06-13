import { defineChain } from "viem";

/** Circle Arc testnet — EVM L1 with USDC as the native gas token. */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const ACTIVE_CHAIN =
  (process.env.NEXT_PUBLIC_CHAIN ?? "arc") === "local" ? anvil : arcTestnet;

export function explorerTx(hash: string): string {
  const base = ACTIVE_CHAIN.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : "#";
}
