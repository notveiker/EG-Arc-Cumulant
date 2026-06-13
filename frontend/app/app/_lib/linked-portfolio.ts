"use client";

/**
 * Cross-wallet Cumulant book — the innovative tie between Dynamic identity and the
 * Cumulant base layer.
 *
 * Dynamic lets one user link several wallets (an email/embedded Arc wallet + an
 * external MetaMask, etc.) under a single identity (`useUserWallets`). This hook reads
 * each linked wallet's on-chain Cumulant positions through the existing backend reader
 * (`GET /api/portfolio/:address`) and merges them, so the portfolio reflects the user's
 * WHOLE structured-product book — not just the active wallet. Pure read aggregation;
 * it changes nothing on-chain and degrades to a single wallet gracefully.
 */
import { useEffect, useState } from "react";
import { useUserWallets } from "@dynamic-labs/sdk-react-core";
import { api, type Portfolio } from "@/lib/api";

export interface WalletBook {
  address: string;
  usdc: number;
  positions: number;
  portfolio: Portfolio | null;
}

export interface LinkedPortfolio {
  wallets: WalletBook[];
  walletCount: number;
  totalUsdc: number;
  totalPositions: number;
  loading: boolean;
}

function countPositions(p: Portfolio): number {
  return (
    p.marketPositions.length +
    p.basketHoldings.length +
    p.trancheHoldings.length +
    p.noteHoldings.length
  );
}

export function useLinkedPortfolio(): LinkedPortfolio {
  const wallets = useUserWallets();
  const addresses = (Array.isArray(wallets) ? wallets : [])
    .map((w) => w?.address)
    .filter((a): a is string => Boolean(a));
  const key = addresses.join(",");

  const [books, setBooks] = useState<WalletBook[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!addresses.length) {
      setBooks([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(
      addresses.map(async (address): Promise<WalletBook> => {
        try {
          const portfolio = await api.portfolio(address);
          return {
            address,
            usdc: Number(portfolio.usdcBalance?.usd ?? 0),
            positions: countPositions(portfolio),
            portfolio,
          };
        } catch {
          return { address, usdc: 0, positions: 0, portfolio: null };
        }
      }),
    ).then((rows) => {
      if (!cancelled) {
        setBooks(rows);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // addresses is derived from `key`; depend on the stable join to avoid refetch loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    wallets: books,
    walletCount: addresses.length,
    totalUsdc: books.reduce((s, w) => s + w.usdc, 0),
    totalPositions: books.reduce((s, w) => s + w.positions, 0),
    loading,
  };
}
