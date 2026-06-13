import type { Address } from "viem";

const BASE = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:13201";

export interface UsdcAmount {
  raw: string;
  usd: string;
}
export interface ChainConfig {
  chain: string;
  chainId: number;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  usdc: Address;
  predictionMarket: Address | null;
  basketVault: Address | null;
  trancheVault: Address | null;
  protectedNote: Address | null;
  resolver: Address | null;
  deployed: boolean;
}
export interface Market {
  id: number;
  question: string;
  closeTime: number;
  resolvedAt: number;
  outcome: "NONE" | "YES" | "NO";
  resolved: boolean;
  voided: boolean;
  creator: Address;
  yesStake: UsdcAmount;
  noStake: UsdcAmount;
  totalStake: UsdcAmount;
  impliedYesProbability: number;
}
export interface BasketLeg {
  marketId: number;
  side: "YES" | "NO" | "NONE";
  weightBps: number;
  weightPct: number;
}
export interface Basket {
  id: number;
  name: string;
  totalShares: UsdcAmount;
  recovered: UsdcAmount;
  settled: boolean;
  creator: Address;
  markToWin: UsdcAmount;
  legs: BasketLeg[];
}
export interface Tranche {
  id: number;
  name: string;
  seniorCouponBps: number;
  seniorCouponPct: number;
  seniorPrincipal: UsdcAmount;
  juniorPrincipal: UsdcAmount;
  settled: boolean;
  recovered: UsdcAmount;
  seniorPot: UsdcAmount;
  juniorPot: UsdcAmount;
  creator: Address;
  legs: BasketLeg[];
}
export interface Note {
  id: number;
  name: string;
  marketId: number;
  side: "YES" | "NO" | "NONE";
  issuerUpside: UsdcAmount;
  principal: UsdcAmount;
  coupon: UsdcAmount;
  projectedCoupon: UsdcAmount;
  settled: boolean;
  issuer: Address;
}
export interface Portfolio {
  address: Address;
  usdcBalance: UsdcAmount;
  marketPositions: { marketId: number; yes: UsdcAmount; no: UsdcAmount }[];
  basketHoldings: { basketId: number; shares: UsdcAmount }[];
  trancheHoldings: { trancheId: number; senior: UsdcAmount; junior: UsdcAmount }[];
  noteHoldings: { noteId: number; principal: UsdcAmount }[];
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { cache: "no-store" });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? `request failed: ${path}`);
  return j.data as T;
}

export const api = {
  config: () => get<ChainConfig>("/api/config"),
  markets: () => get<Market[]>("/api/markets/onchain"),
  market: (id: number) => get<Market>(`/api/markets/${id}`),
  baskets: () => get<Basket[]>("/api/baskets"),
  basket: (id: number) => get<Basket>(`/api/baskets/${id}`),
  tranches: () => get<Tranche[]>("/api/tranches"),
  tranche: (id: number) => get<Tranche>(`/api/tranches/${id}`),
  notes: () => get<Note[]>("/api/notes"),
  note: (id: number) => get<Note>(`/api/notes/${id}`),
  portfolio: (addr: string) => get<Portfolio>(`/api/portfolio/${addr}`),
};
