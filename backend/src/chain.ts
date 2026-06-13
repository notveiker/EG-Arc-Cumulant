import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

/**
 * Arc testnet chain definition. Native currency is USDC (18-decimal native accounting),
 * fee model is bounded/smoothed rather than strict EIP-1559, and finality is sub-second.
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  contracts: {
    // Canonical Multicall3, deployed on Arc testnet. Lets viem batch the
    // portfolio's per-market reads into a few aggregate3 calls instead of
    // hundreds of individual eth_calls that trip the public RPC's rate limit.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  testnet: true,
});

export const chain = config.chain === "local" ? anvil : arcTestnet;

export const publicClient: PublicClient = createPublicClient({
  chain,
  transport: http(config.rpcUrl),
  // When the chain exposes Multicall3 (Arc does), batch concurrent eth_calls
  // through it so the portfolio's many per-market reads collapse into a few
  // aggregate calls instead of hundreds that trip the public RPC's rate limit.
  batch: chain.contracts?.multicall3 ? { multicall: true } : undefined,
});

/**
 * Resolver wallet client — used ONLY for the server-owned resolver role (settling market
 * outcomes). All user actions (buy/deposit/claim/redeem) are signed by the user's own wallet
 * on the frontend; the backend never holds or signs on behalf of users.
 */
export function resolverWallet(): WalletClient | null {
  if (!config.resolverKey) return null;
  const account = privateKeyToAccount(config.resolverKey);
  return createWalletClient({ account, chain, transport: http(config.rpcUrl) });
}

export function resolverAddress(): `0x${string}` | null {
  if (!config.resolverKey) return null;
  return privateKeyToAccount(config.resolverKey).address;
}
