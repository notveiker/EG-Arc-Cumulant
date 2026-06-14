"use client";
/**
 * Portfolio client (Cumulant / Circle Arc, EVM) — reads on-chain basket unit
 * balances for every initialized bundle so the UI can display "you hold N CMLT
 * units of bundle X" straight from the chain rather than from sandbox state.
 *
 * On Arc, basket units are ERC-style shares tracked by the on-chain
 * `BasketVault` (`sharesOf(basketId, user)`). The connected wallet's holdings
 * are read through the backend portfolio aggregator (GET /api/portfolio/:address
 * → `Portfolio.basketHoldings`, which the backend sources from the same
 * `sharesOf` calls), with the basket catalog (`useBaskets()`) supplying NAV +
 * status metadata. The list of bundles + on-chain identifiers still comes from
 * the backend `/api/bundles` endpoint.
 *
 * This module reads positions on-chain; it
 * EVM port preserves the exported surface (`listBundlesOnchain`,
 * `usePbuBalances`, `fetchTransactionHistory`, `fetchBasketPortfolio` + their
 * interfaces) 1:1 so the ported portfolio + basket pages compile unchanged.
 */

import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { BACKEND_URL } from "./tokens";
import { unwrap } from "./http";
import { useActiveWalletAddress } from "./wallet-bridge";
import { usePortfolio, useBaskets } from "@/lib/hooks";
import type { Basket, UsdcAmount } from "@/lib/api";

// ---------- Bundle list ----------

export interface BundleOnchainRow {
  id: string;
  name: string;
  risk_tier: 90 | 70 | 50;
  status: "active" | "resolved" | "cancelled";
  issue_price: number;
  nav: number;
  num_legs: number;
  resolved_legs: number;
  onchain_tx_signature: string | null;
}

let _bundleList: Promise<BundleOnchainRow[]> | null = null;

/**
 * Fetch /api/bundles (cached for the session). Pass `force=true` to
 * invalidate, e.g. after an admin init-onchain call runs.
 */
export function listBundlesOnchain(
  force: boolean = false,
): Promise<BundleOnchainRow[]> {
  if (force) _bundleList = null;
  if (_bundleList) return _bundleList;
  _bundleList = (async () => {
    const res = await fetch(`${BACKEND_URL}/api/bundles`);
    if (!res.ok) {
      _bundleList = null;
      throw new Error(`Failed to load /api/bundles (HTTP ${res.status})`);
    }
    return unwrap(await res.json()) as BundleOnchainRow[];
  })();
  return _bundleList;
}

// ---------- CMLT balance hook ----------

export interface PbuBalanceEntry {
  bundleId: string;
  /** UI bundle name, e.g. "CMLT-HIGH-SHORT". */
  bundleName: string;
  /** UI units of CMLT held by the user. */
  uiAmount: number;
  /** Raw base units (6-decimals). */
  amountRaw: bigint;
  /** Notional value at the bundle's current NAV. */
  valueAtNavUsd: number;
  nav: number;
  status: BundleOnchainRow["status"];
}

/** USDC 6-decimal `{ raw, usd }` → UI float. */
function usdcToNumber(v: UsdcAmount | undefined | null): number {
  if (!v) return 0;
  const fromUsd = Number(v.usd);
  if (Number.isFinite(fromUsd)) return fromUsd;
  try {
    return Number(formatUnits(BigInt(v.raw), 6));
  } catch {
    return 0;
  }
}

/** Per-share NAV of a basket = mark-to-win / total shares (with a $1 fallback). */
function basketNav(cat: Basket | undefined): number {
  if (!cat) return 0;
  const totalShares = usdcToNumber(cat.totalShares);
  const markToWin = usdcToNumber(cat.markToWin);
  return totalShares > 0 ? markToWin / totalShares : 1;
}

/**
 * On-chain CMLT bundle balances for the connected wallet.
 *
 * - Every initialized bundle from `/api/bundles` is included so the UI can
 *   render catalog rows even before the wallet holds anything; bundles the
 *   wallet has no position in carry `uiAmount: 0`.
 * - Live holdings are read from the on-chain basket vault via the backend
 *   portfolio aggregator (`usePortfolio(address).basketHoldings`, which mirrors
 *   `BasketVault.sharesOf(basketId, user)`); the on-chain basketId is matched
 *   to a `/api/bundles` row by id, and value is marked at the basket catalog's
 *   current NAV.
 * - Call `refresh()` to force an immediate re-fetch after a write.
 */
export function usePbuBalances(): {
  loading: boolean;
  error: string | null;
  balances: PbuBalanceEntry[];
  /** Convenience: total USD value across all bundles (at current NAV). */
  totalValueUsd: number;
  refresh: () => Promise<void>;
} {
  const walletAddress = useActiveWalletAddress();
  const portfolioQ = usePortfolio(walletAddress || undefined);
  const basketsQ = useBaskets();

  const [bundles, setBundles] = useState<BundleOnchainRow[] | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // Load the bundle list (cached). Re-runs when `refreshToken` bumps so a
  // post-write refresh can pick up a freshly initialized bundle.
  useEffect(() => {
    let cancelled = false;
    listBundlesOnchain()
      .then((rows) => {
        if (!cancelled) {
          setBundles(rows);
          setBundleError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBundleError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // Index the on-chain basket catalog (id → NAV/status metadata).
  const basketCatalog = useMemo(() => {
    const m = new Map<number, Basket>();
    for (const b of basketsQ.data ?? []) m.set(b.id, b);
    return m;
  }, [basketsQ.data]);

  // Index the wallet's on-chain shares per basketId (6dp raw + UI float).
  const holdingsByBasket = useMemo(() => {
    const m = new Map<string, { raw: bigint; ui: number }>();
    for (const h of portfolioQ.data?.basketHoldings ?? []) {
      let raw = 0n;
      try {
        raw = BigInt(h.shares.raw);
      } catch {
        raw = 0n;
      }
      m.set(String(h.basketId), { raw, ui: usdcToNumber(h.shares) });
    }
    return m;
  }, [portfolioQ.data?.basketHoldings]);

  // Build one entry per initialized bundle, overlaying the wallet's holdings.
  const balances = useMemo<PbuBalanceEntry[]>(() => {
    if (!bundles) return [];
    // A bundle's on-chain basketId is its CANONICAL INDEX (mod the live basket
    // count) — the exact map the backend uses (`bundleIndex(id) % basketCount`).
    // `/api/bundles` is returned in canonical order, so the array index IS the
    // bundle index. The on-chain `basketHoldings`/catalog are keyed by that
    // numeric id (0,1,2,…), NOT by the string bundle name "CMLT-HIGH-SHORT" —
    // matching on `b.id` (the name) always missed, so every basket read 0.
    const basketCount = basketCatalog.size;
    return bundles.map((b, i) => {
      const onchainId = basketCount > 0 ? i % basketCount : i;
      const held = holdingsByBasket.get(String(onchainId));
      const cat = basketCatalog.get(onchainId);
      // Prefer the live catalog NAV; fall back to the bundle row's NAV.
      const nav = cat ? basketNav(cat) : b.nav;
      const uiAmount = held?.ui ?? 0;
      return {
        bundleId: b.id,
        bundleName: b.name,
        uiAmount,
        amountRaw: held?.raw ?? 0n,
        valueAtNavUsd: uiAmount * nav,
        nav,
        status: b.status,
      };
    });
  }, [bundles, holdingsByBasket, basketCatalog]);

  const totalValueUsd = balances.reduce((s, b) => s + b.valueAtNavUsd, 0);

  const refresh = useMemo(
    () =>
      async (): Promise<void> => {
        // Invalidate the module-level cache + bump the token so the bundle
        // effect re-runs, and re-poll the on-chain sources.
        await listBundlesOnchain(true)
          .then((rows) => setBundles(rows))
          .catch((err: unknown) =>
            setBundleError(err instanceof Error ? err.message : String(err)),
          );
        setRefreshToken((n) => n + 1);
        await Promise.all([portfolioQ.refetch(), basketsQ.refetch()]);
      },
    [portfolioQ, basketsQ],
  );

  const loading =
    (bundles === null && bundleError === null) ||
    portfolioQ.isLoading ||
    basketsQ.isLoading;

  const error =
    bundleError ??
    (portfolioQ.error instanceof Error ? portfolioQ.error.message : null) ??
    (basketsQ.error instanceof Error ? basketsQ.error.message : null);

  return { loading, error, balances, totalValueUsd, refresh };
}

// ---------- Transaction history passthrough ----------

export interface TransactionRow {
  id: string;
  bundle_id: string;
  bundle_name?: string;
  wallet_address: string;
  type: "deposit" | "redemption" | "transfer";
  amount_usdc: number;
  tokens: number;
  fee_usdc: number;
  tx_signature?: string;
  onchain_tx_signature?: string;
  created_at: string;
}

/**
 * Fetch the server-side transaction history for a wallet. The backend reads
 * from its ledger store; every row with `onchain_tx_signature` is a real
 * on-chain tx (the Arc deposit flow records the EVM tx hash here on /confirm).
 */
export async function fetchTransactionHistory(
  walletAddress: string,
): Promise<TransactionRow[]> {
  const res = await fetch(
    `${BACKEND_URL}/api/deposit/transactions/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch transaction history (HTTP ${res.status})`);
  }
  const data = unwrap(await res.json()) as { transactions?: TransactionRow[] } | TransactionRow[];
  return Array.isArray(data) ? data : (data.transactions ?? []);
}

// ---------- Basket portfolio (backend hydrate) ----------

/** Shape expected by demo-state's `basket/hydrate` action. */
export interface BasketPositionHydrate {
  bundleId: string;
  qty: number;
  avgCost: number;
  tier?: 90 | 70 | 50;
  navHint?: number;
  displayName?: string;
  maturityAt?: number;
  status?: string;
}

interface BackendPositionRow {
  position_id: string;
  bundle_id: string;
  bundle_name: string;
  bundle_status: string;
  risk_tier: number;
  resolution_date: string | null;
  tokens_held: number;
  entry_price: number;
  deposited_usdc: number;
  current_nav: number;
  current_value: number;
  unrealized_pnl: number;
  pnl_percent: number;
  created_at: string;
}

function normalizeTier(raw: number): 90 | 70 | 50 | undefined {
  if (raw === 90 || raw === 70 || raw === 50) return raw;
  return undefined;
}

/**
 * Fetch the wallet's basket positions from the backend
 * (`/api/deposit/portfolio/:wallet`) and map each row into the `BasketPosition`
 * shape the demo-state reducer expects. The portfolio page dispatches the
 * result as `{ type: "basket/hydrate", positions }` so the in-memory state
 * reflects the latest backend truth whenever the wallet reconnects.
 *
 * - `qty` is tokens_held (CMLT) — not USDC.
 * - `avgCost` is entry_price (USDC per token) — the deposit-time NAV.
 * - `navHint` is the backend's current NAV for display; real pricing still
 *   comes from the live feed when the portfolio row is rendered.
 */
export async function fetchBasketPortfolio(
  walletAddress: string,
): Promise<BasketPositionHydrate[]> {
  const res = await fetch(
    `${BACKEND_URL}/api/deposit/portfolio/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch basket portfolio (HTTP ${res.status})`);
  }
  const data = unwrap(await res.json()) as { positions?: BackendPositionRow[] };
  const rows = data.positions ?? [];
  // Aggregate by bundle_id. The backend stores one row per deposit (so a
  // bundle the user bought into three times has three rows), but the
  // reducer's `basketPositions` is keyed on bundleId — and downstream
  // consumers (`onchainBasketValue`, `onchainBasketPnl`, card render) do
  // `.find(p => p.bundleId === ...)` which only picks the first match.
  // Without merging, subsequent deposits silently disappear from the
  // portfolio value once hydrate overwrites the reducer.
  //
  // Aggregation math (dollar-weighted avg cost):
  //   total_qty    = Σ tokens_held
  //   total_spend  = Σ deposited_usdc (backend pro-rates this on
  //                  partial redeems, so it stays the true remaining
  //                  cost basis across a row's history)
  //   avgCost      = total_spend / total_qty    ← \$/token paid
  type Agg = {
    bundleId: string;
    qty: number;
    spend: number;
    navHint?: number;
    tier?: 90 | 70 | 50;
    displayName?: string;
    maturityAt?: number;
    status?: string;
    // Fallback when no row has deposited_usdc (legacy rows).
    fallbackAvg?: number;
  };
  const byBundle = new Map<string, Agg>();
  for (const p of rows) {
    if (p.tokens_held <= 1e-9) continue;
    const existing = byBundle.get(p.bundle_id);
    if (existing) {
      existing.qty += p.tokens_held;
      existing.spend += p.deposited_usdc;
      // Latest row wins for display metadata (nav/maturity/status).
      existing.navHint = p.current_nav;
      existing.status = p.bundle_status;
      existing.maturityAt = p.resolution_date
        ? Date.parse(p.resolution_date)
        : existing.maturityAt;
      if (existing.fallbackAvg === undefined) existing.fallbackAvg = p.entry_price;
    } else {
      byBundle.set(p.bundle_id, {
        bundleId: p.bundle_id,
        qty: p.tokens_held,
        spend: p.deposited_usdc,
        tier: normalizeTier(p.risk_tier),
        navHint: p.current_nav,
        displayName: p.bundle_name,
        maturityAt: p.resolution_date ? Date.parse(p.resolution_date) : undefined,
        status: p.bundle_status,
        fallbackAvg: p.entry_price,
      });
    }
  }
  return Array.from(byBundle.values()).map<BasketPositionHydrate>((a) => ({
    bundleId: a.bundleId,
    qty: a.qty,
    // `entry_price` in the backend row is the **live Polymarket NAV at
    // deposit time**, not the USDC-per-token the user actually paid.
    // The chain mints at the vault's fixed `issue_price_bps`, so the real
    // cost basis is `deposited_usdc / tokens_held`. Using entry_price
    // made the portfolio's top-line drift up by the NAV-vs-issue spread
    // on every purchase. Fall back to entry_price for legacy rows that
    // were written before deposited_usdc was persisted.
    avgCost:
      a.qty > 1e-9 && a.spend > 0
        ? a.spend / a.qty
        : a.fallbackAvg ?? 0,
    tier: a.tier,
    navHint: a.navHint,
    displayName: a.displayName,
    maturityAt: a.maturityAt,
    status: a.status,
  }));
}
