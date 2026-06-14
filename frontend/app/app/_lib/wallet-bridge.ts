"use client";

/**
 * Wallet bridge for the Cumulant app (Circle Arc / EVM via wagmi + Dynamic).
 *
 * User actions are signed CLIENT-SIDE against the deployed contracts via
 * `useCumulant()` (`@/lib/tx`) — there are no backend-built transactions. This
 * module preserves a small exported surface (`useActiveWalletAddress`,
 * `useUsdcBalance`, `explorerTxUrl`, `useWalletSigner`) so call sites compile.
 *
 * Address resolution: prefer wagmi's `useAccount()`, but fall back to Dynamic's
 * `primaryWallet.address`. With an external/injected wallet (e.g. MetaMask) the
 * Dynamic→wagmi bridge can lag or not populate `useAccount()` even though the
 * wallet is fully connected in Dynamic — which would make every balance/position
 * read resolve to an empty account and render $0 despite real on-chain funds.
 * The fallback keeps reads bound to the address the user actually sees + funds.
 */
import { useCallback, useEffect } from "react";
import { useAccount, useReadContract } from "wagmi";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { formatUnits, type Address } from "viem";
import { useConfig } from "@/lib/hooks";
import { erc20Abi } from "@/lib/abi/erc20";
import { arcTestnet } from "@/lib/chains";
import { explorerTx } from "@/lib/chains";

/**
 * The active wallet address, preferring wagmi but falling back to Dynamic's
 * primaryWallet so an injected wallet that hasn't synced into wagmi still reads.
 */
function useResolvedAddress(): Address | undefined {
  const { address } = useAccount();
  const { primaryWallet } = useDynamicContext();
  const dynAddr = primaryWallet?.address as string | undefined;
  return ((address ?? dynAddr) as Address | undefined) || undefined;
}

export interface WalletSigner {
  connected: boolean;
  address: string | null;
  /**
   * Kept for compatibility. On Arc, actions are signed
   * directly via `useCumulant()` — call those instead. Throws if invoked.
   */
  signPreparedTx: (preparedTx: string) => Promise<string>;
}

export function useWalletSigner(): WalletSigner {
  const address = useResolvedAddress();
  const signPreparedTx = useCallback(async (_preparedTx: string): Promise<string> => {
    throw new Error(
      "backend-built transactions are not used on Arc — call useCumulant() actions directly",
    );
  }, []);
  return { connected: Boolean(address), address: address ?? null, signPreparedTx };
}

/**
 * The wallet address read flows (portfolio, positions, history) key off. Empty
 * string when disconnected, on purpose: every read flow guards on a falsy
 * address and renders a "connect your wallet" empty state.
 */
export function useActiveWalletAddress(): string {
  return useResolvedAddress() ?? "";
}

/**
 * Live USDC balance of the connected wallet, read straight from chain (6dp).
 * Matches the original no-arg surface and `{ uiAmount, loading, error, refresh }`
 * return shape; resolves the USDC address from `/api/config`. The read is pinned
 * to Arc's chainId so it works via the configured RPC even if the wallet reports
 * a different active chain, and uses the Dynamic-fallback address (above).
 */
export function useUsdcBalance() {
  const { data: cfg } = useConfig();
  const address = useResolvedAddress();
  const usdc = (cfg?.usdc ?? null) as Address | null;
  const { data, refetch } = useReadContract({
    address: usdc ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: Boolean(usdc && address), refetchInterval: 10_000 },
  });
  const raw = (data as bigint | undefined) ?? 0n;
  const usd = Number(formatUnits(raw, 6));
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  // Re-check when the user returns to the tab (e.g. after signing in-wallet) or
  // right after a faucet mint (the global "cumulant:minted" event), mirroring the
  // upstream balance resilience. The underlying wagmi read keeps the last-known
  // value on a transient RPC blip, so it never flashes $0.
  useEffect(() => {
    const onRefresh = () => void refresh();
    window.addEventListener("focus", onRefresh);
    window.addEventListener("cumulant:minted", onRefresh);
    return () => {
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("cumulant:minted", onRefresh);
    };
  }, [refresh]);
  return { uiAmount: Number.isFinite(usd) ? usd : 0, loading: false, error: null as string | null, refresh };
}

export function explorerTxUrl(hash: string): string {
  return explorerTx(hash);
}
