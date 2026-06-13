/**
 * Shared API helpers for talking to the Cumulant Express backend.
 *
 * Usage: set BACKEND_URL in the frontend env (or fall back to http://localhost:13201).
 * Safe for both server and client components  -  nothing browser-specific here.
 */

import { unwrap } from "../app/_lib/http";

export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? process.env.BACKEND_URL ?? 'http://localhost:13201';

async function safeJson<T>(path: string, init?: RequestInit, timeoutMs = 8000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      signal: controller.signal,
      // Always fetch fresh data for live dashboards.
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return unwrap<T>(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Types ----------

export interface HealthService {
  status: 'ok' | 'error';
  latency_ms: number;
  error?: string;
}
export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime_seconds: number;
  memory_mb: number;
  services: { supabase: HealthService; polymarket: HealthService };
}

export interface PolymarketMarket {
  id: string;
  question: string;
  condition_id: string;
  outcomePrices?: string;
  volume?: string;
  active?: boolean;
  closed?: boolean;
  end_date_iso?: string;
}
export interface MarketsResponse {
  count: number;
  markets: PolymarketMarket[];
}

// ---------- Fetchers ----------

export function fetchHealth() {
  return safeJson<HealthResponse>('/api/health', undefined, 15_000);
}
export function fetchMarkets(limit = 6) {
  return safeJson<MarketsResponse>(`/api/markets?limit=${limit}`);
}

export interface VaultPriceResponse {
  bundle_id: string;
  bundle_name: string;
  /** Vault's fixed issue price in USD (issuePriceBps / 10_000). */
  issue_price: number | null;
  fee_bps: number | null;
  /** "active" | "finalized" | "closed" — active supports early exit; finalized uses redeem payout. */
  vault_state?: string | null;
}
export interface VaultPricesResponse {
  count: number;
  prices: VaultPriceResponse[];
}
export function fetchVaultPrice(bundleId: string) {
  return safeJson<VaultPriceResponse>(`/api/deposit/vault-price/${bundleId}`, undefined, 10_000);
}
export function fetchAllVaultPrices() {
  return safeJson<VaultPricesResponse>('/api/deposit/vault-prices', undefined, 15_000);
}
