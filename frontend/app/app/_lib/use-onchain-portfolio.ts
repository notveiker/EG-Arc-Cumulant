"use client";
/**
 * On-chain portfolio aggregator (Cumulant / Circle Arc, EVM).
 *
 * Pulls the three position families every /app/portfolio row needs —
 * basket holdings, tranche notes, and plain PPN vaults — directly from
 * chain + backend, with no dependency on the in-memory sandbox reducer.
 * The portfolio page subscribes to this hook and re-renders whenever
 * any of the underlying sources tick.
 *
 * Original (Arc) sources `usePbuBalances()` / `fetchPpnPortfolio()` /
 * `fetchTransactionHistory()` are replaced by the EVM-native, backend-
 * aggregated `usePortfolio(address)` (GET /api/portfolio/:address) plus
 * the live catalog hooks `useBaskets / useTranches / useNotes` for human
 * names + pricing metadata. The exported surface (interfaces + the
 * `useOnchainPortfolio()` return shape) is preserved 1:1 so the ported
 * portfolio page compiles unchanged.
 *
 *   - basket holdings → `Portfolio.basketHoldings` (shares per basketId),
 *     priced via the basket catalog's mark-to-win NAV. `shares === 0`
 *     rows are filtered out so the portfolio only shows real holdings.
 *   - tranche holdings → `Portfolio.trancheHoldings` (senior + junior
 *     principal per trancheId), split into senior/junior rows and tagged
 *     with the tranche catalog's coupon / leg metadata.
 *   - note holdings → `Portfolio.noteHoldings` (principal per noteId),
 *     priced via the note catalog's coupon projection.
 *
 * Refresh semantics: react-query polls each source on its own interval;
 * the consumer can also call `refresh()` right after a deposit or redeem
 * confirms so the UI doesn't wait for the next poll.
 */

import { useCallback, useMemo } from "react";
import { formatUnits } from "viem";
import {
  usePortfolio,
  useBaskets,
  useTranches,
  useNotes,
  useRefreshAll,
} from "@/lib/hooks";
import type { Basket, Tranche, Note, UsdcAmount } from "@/lib/api";
import { useActiveWalletAddress } from "./wallet-bridge";

// ---------- Derived position types ----------

export interface BasketPositionOnchain {
  /** On-chain basket id (stringified). Matches the basket-holdings key. */
  bundleId: string;
  /** UI-visible bundle label, e.g. "PBU-HIGH-SHORT". */
  bundleName: string;
  /** Basket shares held (UI units). */
  qty: number;
  /** Current basket NAV (per-share mark) — used for the current mark. */
  nav: number;
  /**
   * Weighted avg entry cost per share. Null when no cost basis is
   * available from chain/backend (Arc has no per-deposit ledger here),
   * which the consumer renders as "—".
   */
  avgCost: number | null;
  /** Current mark-to-NAV value (qty × nav). */
  valueUsd: number;
  /** Tier tag (90 / 70 / 50) parsed from the bundle name. */
  tier: 90 | 70 | 50 | null;
  /** Passed through so the UI can dim resolved / settled baskets. */
  status: "active" | "resolved" | "cancelled";
}

export interface TranchePositionOnchain {
  /** On-chain tranche id (stringified). Used for redeem. */
  vaultId: string;
  /** On-chain tranche id the position sits on. */
  bundleId: string;
  /** UI-visible bundle label. */
  bundleName: string;
  /** 'senior' / 'mezzanine' / 'junior'. */
  kind: "senior" | "mezzanine" | "junior";
  /** Attach / detach fractions, 0-1. */
  attach: number;
  detach: number;
  /** Principal locked in the note — face value of the tranche. */
  principalUsdc: number;
  /** Yield accrued on this tranche since inception. */
  accruedYield: number;
  /** Current value = principal + accrued yield. */
  totalValue: number;
  /** Note APY the tranche was issued at. */
  apy: number;
  maturityDays: number;
  daysElapsed: number;
  daysRemaining: number;
  status: "active" | "matured" | "withdrawn";
  createdAt: string;
}

export interface PpnVaultOnchain {
  vaultId: string;
  bundleId: string;
  bundleName: string;
  principalUsdc: number;
  accruedYield: number;
  totalValue: number;
  apy: number;
  maturityDays: number;
  daysElapsed: number;
  daysRemaining: number;
  status: "active" | "matured" | "withdrawn";
  createdAt: string;
}

export interface OnchainPortfolioTotals {
  basketValue: number;
  trancheValue: number;
  ppnValue: number;
  totalValue: number;
  unrealizedPnl: number;
}

export interface OnchainPortfolio {
  loading: boolean;
  error: string | null;
  baskets: BasketPositionOnchain[];
  tranches: TranchePositionOnchain[];
  ppns: PpnVaultOnchain[];
  totals: OnchainPortfolioTotals;
  /** Force-refresh all sources. Call after a tx confirms. */
  refresh: () => Promise<void>;
}

// ---------- Helpers ----------

/** USDC 6-decimal → UI float. Accepts the backend `{ raw, usd }` shape. */
function usdcToNumber(v: UsdcAmount | undefined | null): number {
  if (!v) return 0;
  // Prefer the pre-formatted `usd` string; fall back to raw 6dp units.
  const fromUsd = Number(v.usd);
  if (Number.isFinite(fromUsd)) return fromUsd;
  try {
    return Number(formatUnits(BigInt(v.raw), 6));
  } catch {
    return 0;
  }
}

function tierFromName(name: string): 90 | 70 | 50 | null {
  const upper = name.toUpperCase();
  if (/-90-|HIGH/.test(upper)) return 90;
  if (/-70-|MID/.test(upper)) return 70;
  if (/-50-|LOW/.test(upper)) return 50;
  return null;
}

// ---------- Hook ----------

export function useOnchainPortfolio(): OnchainPortfolio {
  const walletAddress = useActiveWalletAddress();

  const portfolioQ = usePortfolio(walletAddress || undefined);
  const basketsQ = useBaskets();
  const tranchesQ = useTranches();
  const notesQ = useNotes();
  const refreshAll = useRefreshAll();

  const basketCatalog = useMemo(() => {
    const m = new Map<number, Basket>();
    for (const b of basketsQ.data ?? []) m.set(b.id, b);
    return m;
  }, [basketsQ.data]);

  const trancheCatalog = useMemo(() => {
    const m = new Map<number, Tranche>();
    for (const t of tranchesQ.data ?? []) m.set(t.id, t);
    return m;
  }, [tranchesQ.data]);

  const noteCatalog = useMemo(() => {
    const m = new Map<number, Note>();
    for (const n of notesQ.data ?? []) m.set(n.id, n);
    return m;
  }, [notesQ.data]);

  // --- Derive baskets -----------------------------------------------
  const baskets = useMemo<BasketPositionOnchain[]>(() => {
    const holdings = portfolioQ.data?.basketHoldings ?? [];
    return holdings
      .map<BasketPositionOnchain>((h) => {
        const cat = basketCatalog.get(h.basketId);
        const qty = usdcToNumber(h.shares);
        // NAV per share: mark-to-win value divided by total shares, with a
        // $1 fallback so a freshly-created basket still prices sanely.
        const totalShares = cat ? usdcToNumber(cat.totalShares) : 0;
        const markToWin = cat ? usdcToNumber(cat.markToWin) : 0;
        const nav = totalShares > 0 ? markToWin / totalShares : 1;
        const bundleName = cat?.name ?? `Basket #${h.basketId}`;
        return {
          bundleId: String(h.basketId),
          bundleName,
          qty,
          nav,
          // Arc backend doesn't expose a per-deposit cost-basis ledger here,
          // so avg cost is unknown until/unless the page hydrates it.
          avgCost: null,
          valueUsd: qty * nav,
          tier: tierFromName(bundleName),
          status: cat?.settled ? "resolved" : "active",
        };
      })
      // Only show baskets the wallet actually holds. `qty === 0` covers
      // both "initialized but nothing bought yet" and "fully redeemed".
      .filter((b) => b.qty > 1e-9);
  }, [portfolioQ.data?.basketHoldings, basketCatalog]);

  // --- Derive tranches ----------------------------------------------
  const tranches = useMemo<TranchePositionOnchain[]>(() => {
    const holdings = portfolioQ.data?.trancheHoldings ?? [];
    const out: TranchePositionOnchain[] = [];
    for (const h of holdings) {
      const cat = trancheCatalog.get(h.trancheId);
      const bundleName = cat?.name ?? `Tranche #${h.trancheId}`;
      const senior = usdcToNumber(h.senior);
      const junior = usdcToNumber(h.junior);
      // Coupon (bps→pct) doubles as the issued APY for the senior leg.
      const apy = cat?.seniorCouponPct ?? 0;
      const base = {
        vaultId: String(h.trancheId),
        bundleId: String(h.trancheId),
        bundleName,
        attach: 0,
        detach: 1,
        apy,
        maturityDays: 0,
        daysElapsed: 0,
        daysRemaining: 0,
        status: (cat?.settled ? "matured" : "active") as
          | "active"
          | "matured"
          | "withdrawn",
        createdAt: new Date().toISOString(),
      };
      if (senior > 1e-9) {
        out.push({
          ...base,
          kind: "senior",
          principalUsdc: senior,
          accruedYield: 0,
          totalValue: senior,
        });
      }
      if (junior > 1e-9) {
        out.push({
          ...base,
          kind: "junior",
          principalUsdc: junior,
          accruedYield: 0,
          totalValue: junior,
        });
      }
    }
    return out;
  }, [portfolioQ.data?.trancheHoldings, trancheCatalog]);

  // --- Derive plain PPNs --------------------------------------------
  const ppns = useMemo<PpnVaultOnchain[]>(() => {
    const holdings = portfolioQ.data?.noteHoldings ?? [];
    return holdings
      .map<PpnVaultOnchain>((h) => {
        const cat = noteCatalog.get(h.noteId);
        const principal = usdcToNumber(h.principal);
        const projectedCoupon = cat ? usdcToNumber(cat.projectedCoupon) : 0;
        const apy = principal > 0 ? (projectedCoupon / principal) * 100 : 0;
        return {
          vaultId: String(h.noteId),
          bundleId: String(h.noteId),
          bundleName: cat?.name ?? `Note #${h.noteId}`,
          principalUsdc: principal,
          accruedYield: 0,
          totalValue: principal + projectedCoupon,
          apy,
          maturityDays: 0,
          daysElapsed: 0,
          daysRemaining: 0,
          status: cat?.settled ? "matured" : "active",
          createdAt: new Date().toISOString(),
        };
      })
      .filter((p) => p.principalUsdc > 1e-9);
  }, [portfolioQ.data?.noteHoldings, noteCatalog]);

  // --- Totals --------------------------------------------------------
  const totals = useMemo<OnchainPortfolioTotals>(() => {
    const basketValue = baskets.reduce((s, p) => s + p.valueUsd, 0);
    const trancheValue = tranches.reduce((s, p) => s + p.totalValue, 0);
    const ppnValue = ppns.reduce((s, p) => s + p.totalValue, 0);
    const unrealizedPnl = baskets.reduce((s, p) => {
      if (p.avgCost == null) return s;
      return s + p.qty * (p.nav - p.avgCost);
    }, 0);
    return {
      basketValue,
      trancheValue,
      ppnValue,
      totalValue: basketValue + trancheValue + ppnValue,
      unrealizedPnl,
    };
  }, [baskets, tranches, ppns]);

  // --- Composite refresh --------------------------------------------
  const refresh = useCallback(async () => {
    refreshAll();
    await Promise.all([
      portfolioQ.refetch(),
      basketsQ.refetch(),
      tranchesQ.refetch(),
      notesQ.refetch(),
    ]);
  }, [refreshAll, portfolioQ, basketsQ, tranchesQ, notesQ]);

  const loading =
    portfolioQ.isLoading ||
    basketsQ.isLoading ||
    tranchesQ.isLoading ||
    notesQ.isLoading;

  const error =
    (portfolioQ.error instanceof Error ? portfolioQ.error.message : null) ??
    (basketsQ.error instanceof Error ? basketsQ.error.message : null) ??
    (tranchesQ.error instanceof Error ? tranchesQ.error.message : null) ??
    (notesQ.error instanceof Error ? notesQ.error.message : null);

  return {
    loading,
    error,
    baskets,
    tranches,
    ppns,
    totals,
    refresh,
  };
}
