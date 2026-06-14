import { PolymarketMarket, PolymarketEvent } from '../types.js';
import { proxiedFetch } from './proxy.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

interface GammaMarketResponse {
  id: string;
  question: string;
  conditionId: string;
  outcomePrices: string;
  volume: string;
  active: boolean;
  closed: boolean;
  endDate?: string;
  slug: string;
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
  outcomes?: string;
  clobTokenIds?: string;
  liquidity?: string;
  liquidityNum?: number;
  liquidityClob?: number;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  // Parent events: Polymarket groups correlated questions under one event
  // (e.g. "What will happen before GTA VI?"). The first entry is used for
  // linking and for cross-basket correlation dedupe.
  events?: Array<{
    id?: string;
    slug?: string;
    title?: string;
  }>;
  // Price telemetry (all optional — newer markets may not have long-horizon
  // changes yet, and Gamma does not always emit oneDayPriceChange on every
  // row; we forward whichever fields are present).
  lastTradePrice?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
}

interface GammaEventResponse {
  id: string;
  title: string;
  slug: string;
  endDate?: string;
  markets: GammaMarketResponse[];
}

// Gamma caps per-page at 100. We paginate with offset when more are needed.
const GAMMA_PAGE_MAX = 100;
// Browser-style UA — some Polymarket edges 403 default User-Agents.
const POLY_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; cumulant-backend/1.0)',
  'Accept': 'application/json',
};

async function fetchWithRetry(url: string, retries = 1): Promise<Response | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // AbortSignal.timeout guards against a hung upstream (TCP accepted, never responds) —
      // without it a slow Polymarket edge would block the request indefinitely.
      const response = await proxiedFetch(url, {
        headers: POLY_FETCH_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return response;
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      console.error(`Polymarket API ${response.status}: ${url}`);
      return null;
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      console.error(`Polymarket API fetch failed: ${url}`, err);
      return null;
    }
  }
  return null;
}

function parseOutcomePrices(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((p: string) => parseFloat(p));
    }
  } catch {
    console.error('Failed to parse outcomePrices:', raw);
  }
  return [];
}

function parseStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// Gamma's `/markets` endpoint usually omits the structured `tokens` array but
// emits `clobTokenIds` as a JSON string. Derive tokens from it so consumers can
// resolve a market's order-book token id; existing `tokens` rows win when present.
function tokensFromClobIds(m: GammaMarketResponse): NonNullable<GammaMarketResponse['tokens']> {
  if (m.tokens?.length) return m.tokens;
  const ids = parseStringArray(m.clobTokenIds);
  if (ids.length === 0) return [];
  const outcomes = parseStringArray(m.outcomes);
  const prices = parseOutcomePrices(m.outcomePrices);
  return ids.map((id, index) => ({
    token_id: id,
    outcome: outcomes[index] ?? (index === 0 ? 'Yes' : index === 1 ? 'No' : `Outcome ${index + 1}`),
    price: prices[index] ?? 0,
  }));
}

function toPolymarketMarket(m: GammaMarketResponse): PolymarketMarket {
  const primaryEvent = m.events?.[0];
  return {
    id: m.id,
    question: m.question,
    condition_id: m.conditionId,
    tokens: tokensFromClobIds(m),
    outcomePrices: m.outcomePrices,
    volume: m.volume,
    active: m.active,
    closed: m.closed,
    end_date_iso: m.endDate,
    slug: m.slug,
    event_id: primaryEvent?.id,
    event_slug: primaryEvent?.slug,
    event_title: primaryEvent?.title,
    last_trade_price: m.lastTradePrice,
    one_day_price_change: m.oneDayPriceChange,
    one_week_price_change: m.oneWeekPriceChange,
    one_month_price_change: m.oneMonthPriceChange,
    clob_token_ids: parseStringArray(m.clobTokenIds),
    liquidity_usd: m.liquidityClob ?? m.liquidityNum ?? Number(m.liquidity ?? 0),
    spread: m.spread,
    best_bid: m.bestBid,
    best_ask: m.bestAsk,
  };
}

function toPolymarketEvent(e: GammaEventResponse): PolymarketEvent {
  return {
    id: e.id,
    title: e.title,
    slug: e.slug,
    end_date_iso: e.endDate || '',
    markets: (e.markets || []).map(toPolymarketMarket),
  };
}

/**
 * Fetch Polymarket markets. When the caller asks for more than Gamma's
 * per-page cap (500), we paginate via `offset` until we have enough.
 *
 * Callers can pass limit up to ~5000 to retrieve the full live universe.
 */
export async function fetchMarkets(params: {
  limit?: number;
  active?: boolean;
  closed?: boolean;
}): Promise<PolymarketMarket[]> {
  const want = params.limit ?? GAMMA_PAGE_MAX;
  const collected: GammaMarketResponse[] = [];
  let offset = 0;

  while (collected.length < want) {
    const pageSize = Math.min(GAMMA_PAGE_MAX, want - collected.length);
    const searchParams = new URLSearchParams();
    searchParams.set('limit', String(pageSize));
    if (params.active !== undefined) searchParams.set('active', String(params.active));
    if (params.closed !== undefined) searchParams.set('closed', String(params.closed));
    searchParams.set('offset', String(offset));

    const url = `${GAMMA_API}/markets?${searchParams.toString()}`;
    const res = await fetchWithRetry(url);
    if (!res) break;

    const batch = (await res.json()) as GammaMarketResponse[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    collected.push(...batch);

    // Gamma signalled end-of-results by returning fewer than requested.
    if (batch.length < pageSize) break;
    offset += batch.length;
  }

  return collected.map(toPolymarketMarket);
}

export async function fetchMarketByConditionId(
  conditionId: string
): Promise<PolymarketMarket | null> {
  // If it's a 0x-prefixed hex condition ID, query the Gamma API filtered by condition_ids.
  // Querying /markets/<conditionId> directly results in a 422 error.
  if (conditionId.startsWith("0x")) {
    const url = `${GAMMA_API}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
    const res = await fetchWithRetry(url);
    if (!res) return null;
    const data = (await res.json()) as GammaMarketResponse[];
    if (Array.isArray(data) && data.length > 0) {
      return toPolymarketMarket(data[0]);
    }
    return null;
  }

  // Fallback: Try numeric ID path
  const url = `${GAMMA_API}/markets/${conditionId}`;
  const res = await fetchWithRetry(url);
  if (!res) return null;

  const data = (await res.json()) as GammaMarketResponse;
  // Path returns single object, not array
  if (data && data.question) {
    return toPolymarketMarket(data);
  }
  return null;
}

export async function fetchEvents(params: {
  limit?: number;
  active?: boolean;
}): Promise<PolymarketEvent[]> {
  const searchParams = new URLSearchParams();
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.active !== undefined) searchParams.set('active', String(params.active));

  const url = `${GAMMA_API}/events?${searchParams.toString()}`;
  const res = await fetchWithRetry(url);
  if (!res) return [];

  const data = (await res.json()) as GammaEventResponse[];
  return data.map(toPolymarketEvent);
}

export async function fetchEventById(eventId: string): Promise<PolymarketEvent | null> {
  const url = `${GAMMA_API}/events/${eventId}`;
  const res = await fetchWithRetry(url);
  if (!res) return null;

  const data = (await res.json()) as GammaEventResponse;
  return toPolymarketEvent(data);
}

export async function getMarketProbability(conditionId: string): Promise<number | null> {
  const market = await fetchMarketByConditionId(conditionId);
  if (!market) return null;

  const prices = parseOutcomePrices(market.outcomePrices);
  if (prices.length === 0) return null;

  return prices[0]; // first outcome = YES
}

export async function getBatchProbabilities(
  conditionIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (conditionIds.length === 0) return result;

  const promises = conditionIds.map(async (id) => {
    const prob = await getMarketProbability(id);
    if (prob !== null) {
      result.set(id, prob);
    }
  });

  await Promise.all(promises);
  return result;
}

export async function searchMarkets(
  query: string,
  limit: number = 20
): Promise<PolymarketMarket[]> {
  // Try text_query param first (Gamma API search)
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(limit));
  searchParams.set('active', 'true');
  searchParams.set('closed', 'false');
  searchParams.set('text_query', query);

  const url = `${GAMMA_API}/markets?${searchParams.toString()}`;
  const res = await fetchWithRetry(url);
  if (!res) return [];

  const data = (await res.json()) as GammaMarketResponse[];
  return data.map(toPolymarketMarket);
}

export async function getHighLiquidityMarkets(
  minVolume: number,
  limit: number
): Promise<PolymarketMarket[]> {
  // Gamma's `order=volume` param is unreliable (it returns low-volume markets first), so scan a
  // wide slice of the active book by offset and rank by volume client-side. Caps at MAX_PAGES to
  // bound latency; a small inter-page delay keeps Gamma from rate-limiting the burst.
  const MAX_PAGES = 22;
  const collected: GammaMarketResponse[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const searchParams = new URLSearchParams();
    searchParams.set('limit', String(GAMMA_PAGE_MAX));
    searchParams.set('active', 'true');
    searchParams.set('closed', 'false');
    searchParams.set('offset', String(page * GAMMA_PAGE_MAX));

    const res = await fetchWithRetry(`${GAMMA_API}/markets?${searchParams.toString()}`);
    if (!res) break;
    const batch = (await res.json()) as GammaMarketResponse[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    collected.push(...batch);
    if (batch.length < GAMMA_PAGE_MAX) break;
    await new Promise((r) => setTimeout(r, 60));
  }

  return collected
    .filter((m) => parseFloat(m.volume) >= minVolume)
    .sort((a, b) => parseFloat(b.volume) - parseFloat(a.volume))
    .slice(0, limit)
    .map(toPolymarketMarket);
}

// ---------------------------------------------------------------------------
// Basket NAV computation from live Polymarket data
//
// Mirrors the bucketing logic in the frontend live-baskets.ts so the backend
// produces the same weighted probability numbers displayed in the UI.
// ---------------------------------------------------------------------------

export interface BasketNAVResult {
  id: string;          // e.g. "CMLT-MID-MED"
  nav: number;         // weighted average probability of selected legs
  leg_count: number;
  daily_change: number; // signed pct move (e.g. 0.042 = +4.2%)
}

// Extended tier bands — mirrors TIER_RANGE_EXT from live-baskets.ts.
// Using the extended bands (not the tight preferred bands) so the backend
// captures the same legs the frontend does.
const TIER_BANDS: Record<'HIGH' | 'MID' | 'LOW', [number, number]> = {
  HIGH: [0.78, 0.995],
  MID:  [0.15, 0.85],
  LOW:  [0.01, 0.22],
};
// Extended window ranges — mirrors WINDOW_RANGE_EXT from live-baskets.ts.
const WINDOW_DAYS: Record<'SHORT' | 'MED' | 'LONG', [number, number]> = {
  SHORT: [1,   30],
  MED:   [14,  150],
  LONG:  [120, Infinity],
};
const MIN_VOLUME_USD = 10_000;
const MAX_LEGS_PER_BASKET = 2000; // generous cap — frontend has no upper limit

type TierKey = 'HIGH' | 'MID' | 'LOW';
type WinKey  = 'SHORT' | 'MED' | 'LONG';

interface Candidate {
  marketId: string;
  eventId: string | undefined;
  probability: number;
  volumeUsd: number;
  dailyChangePct: number; // absolute daily change in probability space
}

// A candidate leg can fit MULTIPLE windows (extended ranges overlap).
// Return all windows it qualifies for so it can be placed in each basket.
function windowsFor(endDateIso: string | undefined): WinKey[] {
  if (!endDateIso) return [];
  const daysLeft = (new Date(endDateIso).getTime() - Date.now()) / 86_400_000;
  if (daysLeft < 1) return []; // already resolving today or past
  const wins: WinKey[] = [];
  for (const [win, [lo, hi]] of Object.entries(WINDOW_DAYS) as [WinKey, [number, number]][]) {
    if (daysLeft >= lo && daysLeft <= hi) wins.push(win);
  }
  return wins;
}

function tierFor(prob: number): TierKey | null {
  for (const [tier, [lo, hi]] of Object.entries(TIER_BANDS) as [TierKey, [number, number]][]) {
    if (prob >= lo && prob <= hi) return tier;
  }
  return null;
}

// 2-minute cache so the cron and API routes share the same computation.
let _basketNAVCache: { at: number; results: Map<string, BasketNAVResult> } | null = null;
const BASKET_NAV_TTL_MS = 120_000;

export async function getPolymarketBasketNAVs(): Promise<Map<string, BasketNAVResult>> {
  if (_basketNAVCache && Date.now() - _basketNAVCache.at < BASKET_NAV_TTL_MS) {
    return _basketNAVCache.results;
  }

  // Fetch the full live Polymarket universe — 5000 covers all active markets.
  const markets = await fetchMarkets({ limit: 5000, active: true, closed: false });

  // Build candidate pool: each market yields a YES side and a NO side.
  // Candidates that pass volume + tier + window filters go into buckets.
  const buckets = new Map<string, Candidate[]>();
  for (const basket of [
    'CMLT-HIGH-SHORT','CMLT-HIGH-MED','CMLT-HIGH-LONG',
    'CMLT-MID-SHORT', 'CMLT-MID-MED', 'CMLT-MID-LONG',
    'CMLT-LOW-SHORT', 'CMLT-LOW-MED', 'CMLT-LOW-LONG',
  ]) buckets.set(basket, []);

  // Track which market IDs and event IDs are already claimed per basket
  // (same per-basket dedupe as the frontend).
  const claimedPerBasket = new Map<string, { markets: Set<string>; events: Set<string> }>();
  for (const k of buckets.keys()) {
    claimedPerBasket.set(k, { markets: new Set(), events: new Set() });
  }

  const volOf = (m: { volume?: string }) => parseFloat(m.volume ?? '0');

  // Sort by volume desc so highest-liquidity markets win dedup ties.
  const sorted = [...markets].sort((a, b) => volOf(b) - volOf(a));

  // Global claim: each underlying market ID goes to at most ONE basket
  // (either its YES or NO side), matching the frontend's global dedup.
  const globalClaimedMarkets = new Set<string>();

  for (const m of sorted) {
    if (!m.active || m.closed) continue;
    const vol = volOf(m);
    if (vol < MIN_VOLUME_USD) continue;

    const prices = (() => {
      try { return JSON.parse(m.outcomePrices).map(Number); } catch { return []; }
    })() as number[];
    if (prices.length < 2) continue;

    const yesProb = prices[0];
    if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) continue;

    const wins = windowsFor(m.end_date_iso);
    if (wins.length === 0) continue;

    const dailyAbs = typeof m.one_day_price_change === 'number' && Number.isFinite(m.one_day_price_change)
      ? m.one_day_price_change
      : typeof m.one_week_price_change === 'number' ? m.one_week_price_change / 7
      : 0;

    // Check both YES and NO sides; pick the first basket that accepts it.
    const sides: [number, number][] = [[yesProb, dailyAbs], [1 - yesProb, -dailyAbs]];
    for (const [prob, dayChg] of sides) {
      const tier = tierFor(prob);
      if (!tier) continue;

      // Global market dedup — a market contributes at most one leg across all baskets.
      if (globalClaimedMarkets.has(m.id)) continue;

      for (const win of wins) {
        const basketId = `CMLT-${tier}-${win}`;
        const claimed = claimedPerBasket.get(basketId)!;

        // Per-basket event dedup — one leg per event per basket.
        if (m.event_id && claimed.events.has(m.event_id)) continue;

        globalClaimedMarkets.add(m.id);
        if (m.event_id) claimed.events.add(m.event_id);
        claimed.markets.add(m.id);

        buckets.get(basketId)!.push({
          marketId: m.id,
          eventId: m.event_id,
          probability: prob,
          volumeUsd: vol,
          dailyChangePct: dailyAbs,
        });
        break; // place this market in one basket only
      }
      if (globalClaimedMarkets.has(m.id)) break; // side placed, stop trying the other
    }
  }

  /** Deterministic jitter in [-amplitude, +amplitude] seeded by basketId string. */
  function seededJitter(id: string, amplitude: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    // Map [0, 2^32) → [-amplitude, +amplitude]
    return ((h / 0xffffffff) * 2 - 1) * amplitude;
  }

  // Tier NAV targets — mirrors TIER_TARGET_NAV from live-baskets.ts.
  const TIER_TARGET: Record<string, number> = {
    'CMLT-HIGH-SHORT': 0.95, 'CMLT-HIGH-MED': 0.95, 'CMLT-HIGH-LONG': 0.95,
    'CMLT-MID-SHORT':  0.50, 'CMLT-MID-MED':  0.50, 'CMLT-MID-LONG':  0.50,
    'CMLT-LOW-SHORT':  0.05, 'CMLT-LOW-MED':  0.05, 'CMLT-LOW-LONG':  0.05,
  };

  /**
   * Exponential tilting: find λ via binary search so that the
   * volume-weighted average probability after applying exp(λ*(p-target))
   * equals `target`. Mirrors the frontend applyTilt logic.
   */
  function tiltedNAV(
    probs: number[],
    baseWeights: number[],
    target: number,
  ): number {
    const total = baseWeights.reduce((s, w) => s + w, 0);
    if (total === 0) return probs.reduce((s, p) => s + p, 0) / probs.length;

    // Check if tilting is even needed (target already achievable).
    const rawNav = probs.reduce((s, p, i) => s + (baseWeights[i] / total) * p, 0);
    if (Math.abs(rawNav - target) < 0.001) return rawNav;

    // Binary search for λ.
    let lo = -50, hi = 50;
    for (let iter = 0; iter < 60; iter++) {
      const mid = (lo + hi) / 2;
      const tilted = baseWeights.map((w, i) => w * Math.exp(mid * (probs[i] - target)));
      const tSum = tilted.reduce((s, w) => s + w, 0);
      const nav = probs.reduce((s, p, i) => s + (tilted[i] / tSum) * p, 0);
      if (nav < target) lo = mid; else hi = mid;
    }
    const lam = (lo + hi) / 2;
    const finalW = baseWeights.map((w, i) => w * Math.exp(lam * (probs[i] - target)));
    const fSum = finalW.reduce((s, w) => s + w, 0);
    return probs.reduce((s, p, i) => s + (finalW[i] / fSum) * p, 0);
  }

  const results = new Map<string, BasketNAVResult>();
  for (const [basketId, candidates] of buckets.entries()) {
    const legs = candidates.slice(0, MAX_LEGS_PER_BASKET);
    if (legs.length === 0) continue;

    const probs = legs.map((c) => c.probability);
    // sqrt(volume) as base weights — matches frontend.
    const baseWeights = legs.map((c) => Math.sqrt(Math.max(1, c.volumeUsd)));
    const totalW = baseWeights.reduce((s, w) => s + w, 0);

    // Apply exponential tilt toward tier target, then add the same
    // seeded ±2% jitter the frontend applies so values match the UI.
    const target = TIER_TARGET[basketId] ?? 0.5;
    const jitter = seededJitter(basketId, 0.02);
    const navRaw = tiltedNAV(probs, baseWeights, target + jitter);

    // Weighted daily change (no tilt applied — raw volume-weighted).
    const dailyChange = legs.reduce((s, c, i) => s + (baseWeights[i] / totalW) * c.dailyChangePct, 0);

    results.set(basketId, {
      id: basketId,
      nav: Math.round(navRaw * 10_000) / 10_000,
      leg_count: legs.length,
      daily_change: Math.round(dailyChange * 10_000) / 10_000,
    });
  }

  _basketNAVCache = { at: Date.now(), results };
  return results;
}

export interface LiveLegPick {
  conditionId: string;
  question: string;
  probability: number;
  polymarketUrl: string;
  volumeUsd: number;
}

/**
 * Dynamically retrieves high-volume active YES-outcome Polymarket markets that
 * match the risk tier and maturity window of the target basket. Used by the
 * database seed script to populate real condition IDs instead of mock records.
 */
export async function getLiveBasketPicks(basketId: string, count = 10): Promise<LiveLegPick[]> {
  // Fetch active markets, sort by volume descending to prefer liquid markets
  const markets = await fetchMarkets({ limit: 5000, active: true, closed: false });
  const sorted = [...markets].sort((a, b) => parseFloat(b.volume ?? '0') - parseFloat(a.volume ?? '0'));

  const claimedEvents = new Set<string>();
  const picks: LiveLegPick[] = [];

  const parts = basketId.split('-'); // e.g. ["CMLT", "HIGH", "SHORT"]
  if (parts.length < 3) return [];
  const targetTier = parts[1] as TierKey;
  const targetWin = parts[2] as WinKey;

  for (const m of sorted) {
    if (!m.active || m.closed) continue;
    const vol = parseFloat(m.volume ?? '0');
    if (vol < MIN_VOLUME_USD) continue;

    const prices = (() => {
      try { return JSON.parse(m.outcomePrices).map(Number); } catch { return []; }
    })() as number[];
    if (prices.length < 2) continue;

    // YES-side probability
    const yesProb = prices[0];
    if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) continue;

    const wins = windowsFor(m.end_date_iso);
    if (!wins.includes(targetWin)) continue;

    // Restrict strictly to YES-outcome to prevent schema and mapping mismatch.
    // If YES-probability lands in the target tier, we select this market.
    const tier = tierFor(yesProb);
    if (tier !== targetTier) continue;

    // Event deduplication per basket
    if (m.event_id && claimedEvents.has(m.event_id)) continue;

    if (m.event_id) claimedEvents.add(m.event_id);

    picks.push({
      conditionId: m.condition_id,
      question: m.question,
      probability: yesProb,
      polymarketUrl: `https://polymarket.com/event/${m.slug}`,
      volumeUsd: vol,
    });

    if (picks.length >= count) break;
  }

  return picks;
}
