"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import { api } from "./api";
import { erc20Abi } from "./abi/erc20";

export function useConfig() {
  // Short staleTime + refetch-on-focus so a local redeploy (which changes contract
  // addresses) is picked up when the tab regains focus — no hard refresh needed.
  return useQuery({
    queryKey: ["config"],
    queryFn: api.config,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

export function useMarkets() {
  return useQuery({ queryKey: ["markets"], queryFn: api.markets, refetchInterval: 8_000 });
}

export function useMarket(id?: number) {
  return useQuery({
    queryKey: ["market", id],
    queryFn: () => api.market(id!),
    enabled: id != null && id >= 0,
    refetchInterval: 8_000,
  });
}

export function useBaskets() {
  return useQuery({ queryKey: ["baskets"], queryFn: api.baskets, refetchInterval: 8_000 });
}

export function useTranches() {
  return useQuery({ queryKey: ["tranches"], queryFn: api.tranches, refetchInterval: 8_000 });
}

export function useNotes() {
  return useQuery({ queryKey: ["notes"], queryFn: api.notes, refetchInterval: 8_000 });
}

export function usePortfolio(address?: string) {
  return useQuery({
    queryKey: ["portfolio", address],
    queryFn: () => api.portfolio(address!),
    enabled: Boolean(address),
    refetchInterval: 8_000,
  });
}

/** Live USDC balance of the connected wallet, read straight from chain (6-decimal). */
export function useUsdcBalance(usdc?: Address | null) {
  const { address } = useAccount();
  const { data, refetch } = useReadContract({
    address: usdc ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(usdc && address), refetchInterval: 10_000 },
  });
  const raw = (data as bigint | undefined) ?? 0n;
  return { raw, usd: Number(formatUnits(raw, 6)), refetch };
}

/** Invalidate all on-chain-derived data after a successful transaction. */
export function useRefreshAll() {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: ["markets"] });
    qc.invalidateQueries({ queryKey: ["market"] });
    qc.invalidateQueries({ queryKey: ["baskets"] });
    qc.invalidateQueries({ queryKey: ["tranches"] });
    qc.invalidateQueries({ queryKey: ["notes"] });
    qc.invalidateQueries({ queryKey: ["portfolio"] });
  }, [qc]);
}
