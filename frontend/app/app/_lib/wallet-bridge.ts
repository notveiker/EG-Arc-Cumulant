"use client";

/**
 * Wallet bridge for the Cumulant app (Circle Arc / EVM via wagmi + Dynamic).
 *
 * User actions are signed CLIENT-SIDE against the deployed contracts via
 * `useCumulant()` (`@/lib/tx`) — there are no backend-built transactions. This
 * module preserves a small exported surface (`useActiveWalletAddress`,
 * `useUsdcBalance`, `explorerTxUrl`, `useWalletSigner`) so call sites compile,
 * while delegating reads to the on-chain wagmi hooks in `@/lib/hooks`.
 */
import { useCallback, useEffect } from "react";
import { useAccount } from "wagmi";
import { useConfig, useUsdcBalance as useChainUsdcBalance } from "@/lib/hooks";
import { explorerTx } from "@/lib/chains";

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
  const { address, isConnected } = useAccount();
  const signPreparedTx = useCallback(async (_preparedTx: string): Promise<string> => {
    throw new Error(
      "backend-built transactions are not used on Arc — call useCumulant() actions directly",
    );
  }, []);
  return { connected: isConnected, address: address ?? null, signPreparedTx };
}

/**
 * The wallet address read flows (portfolio, positions, history) key off. Empty
 * string when disconnected, on purpose: every read flow guards on a falsy
 * address and renders a "connect your wallet" empty state.
 */
export function useActiveWalletAddress(): string {
  const { address } = useAccount();
  return address ?? "";
}

/**
 * Live USDC balance of the connected wallet, read straight from chain (6dp).
 * Matches the original no-arg surface and `{ uiAmount, loading, error, refresh }`
 * return shape; resolves the USDC address from `/api/config`.
 */
export function useUsdcBalance() {
  const { data: cfg } = useConfig();
  const { usd, refetch } = useChainUsdcBalance(cfg?.usdc ?? null);
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
