// Curated market book — the Cumulant pattern. Pulls live markets from the Polymarket Gamma API,
// runs them through the NLP + quality filter pipeline, and caches the result (refreshed on a
// timer). This replaces seeding hundreds of markets on-chain: the book is real and abundant.

import { getHighLiquidityMarkets } from "./polymarket.js";
import { filterMarkets, type FilteredMarket } from "./market-filter.js";
import { metrics } from "./metrics.js";

export interface CuratedMarket {
  id: number;
  conditionId: string;
  question: string;
  category: string;
  categoryConfidence: number;
  impliedYesProbability: number;
  volumeUsd: number;
  closeTime: number; // unix seconds; 0 if unknown
  daysToResolution: number | null;
  slug: string | null;
  url: string | null;
  oneDayChange: number | null;
  resolved: boolean;
}

let cache: { markets: CuratedMarket[]; funnel: unknown; at: number } | null = null;
let inflight: Promise<void> | null = null;
const TTL_MS = 120_000;

function mapMarket(fm: FilteredMarket, idx: number): CuratedMarket {
  const m = fm.market;
  const closeTime = m.end_date_iso ? Math.floor(new Date(m.end_date_iso).getTime() / 1000) : 0;
  const slug = m.event_slug ?? m.slug ?? null;
  return {
    id: idx,
    conditionId: m.condition_id,
    question: m.question,
    category: fm.category,
    categoryConfidence: fm.categoryConfidence,
    impliedYesProbability: fm.yesProbability ?? 0.5,
    volumeUsd: fm.volumeUsd,
    closeTime,
    daysToResolution: fm.daysToResolution,
    slug,
    url: slug ? `https://polymarket.com/event/${slug}` : null,
    oneDayChange: m.one_day_price_change ?? null,
    resolved: m.closed,
  };
}

export async function refreshCurated(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // Only ~50 Polymarket markets clear $5k volume at any moment; lower the floor and widen the
      // resolution window so the book is hundreds deep while the NLP/quality/category gates still
      // drop troll + unanswerable markets.
      const raw = await getHighLiquidityMarkets(500, 1_200);
      const result = filterMarkets(raw, { minVolumeUsd: 500, maxDaysToResolution: 400 });
      // Record the funnel into the lifetime monitor counters. Previously this only
      // ran in the (shadowed, unreachable) markets.ts /curated handler, so the live
      // curated path left filterRunsTotal / markets-seen-kept-rejected at zero.
      metrics.recordFilterRun({
        timestamp: Date.now(),
        source: "curated_list",
        input_count: result.funnel.input_count,
        kept_count: result.funnel.kept_count,
        rejected_count: result.funnel.rejected_count,
        per_stage: {
          liquidity_floor: { entered: result.funnel.per_stage.liquidity_floor.entered, rejected: result.funnel.per_stage.liquidity_floor.rejected },
          quality_nlp: { entered: result.funnel.per_stage.quality_nlp.entered, rejected: result.funnel.per_stage.quality_nlp.rejected },
          time_window: { entered: result.funnel.per_stage.time_window.entered, rejected: result.funnel.per_stage.time_window.rejected },
          category_classify: { entered: result.funnel.per_stage.category_classify.entered, rejected: result.funnel.per_stage.category_classify.rejected },
          diversity_prefilter: { entered: result.funnel.per_stage.diversity_prefilter.entered, rejected: result.funnel.per_stage.diversity_prefilter.rejected },
        },
      });
      // Never overwrite a good cache with an empty result (transient Gamma rate-limit).
      if (result.kept.length > 0 || !cache) {
        cache = { markets: result.kept.map(mapMarket), funnel: result.funnel, at: Date.now() };
      }
      console.log(`[curated] refreshed: ${result.kept.length} kept / ${raw.length} fetched`);
    } catch (e) {
      console.error("[curated] refresh failed:", e instanceof Error ? e.message : e);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getCuratedMarkets(): Promise<CuratedMarket[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) await refreshCurated();
  return cache?.markets ?? [];
}

export function getCuratedFunnel(): unknown {
  return cache?.funnel ?? null;
}
