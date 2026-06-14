import { defineChain } from "viem";

/** Circle Arc testnet — EVM L1 with USDC as the native gas token.
 *  Native gas USDC is 18-decimal on-chain (EVM-standard wei accounting) — distinct
 *  from the 6-decimal USDC/MockUSDC ERC-20 used as product collateral. Declaring 6
 *  here desyncs the embedded (Dynamic/MPC) wallet's gas accounting and can hang the
 *  co-sign, so this MUST match the chain's real 18-dec native. */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
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
