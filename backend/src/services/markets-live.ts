// Raw live Polymarket market feed — the broad, unfiltered (but volume-floored) set the frontend
// basket assembler buckets client-side into CMLT baskets. Cached so all callers share one pull.

import { getHighLiquidityMarkets } from "./polymarket.js";
import type { PolymarketMarket } from "../types.js";

let cache: { markets: PolymarketMarket[]; at: number } | null = null;
const TTL_MS = 120_000;

export async function getLiveRawMarkets(): Promise<PolymarketMarket[]> {
  if (cache && cache.markets.length > 0 && Date.now() - cache.at < TTL_MS) return cache.markets;
  try {
    // The whole ≥ $500-volume zone (~800 markets) — enough to fill all 9 tier×window baskets.
    const markets = await getHighLiquidityMarkets(500, 1500);
    // Never cache an empty result (a transient Gamma rate-limit would otherwise blank the UI for
    // the full TTL). Keep the last-good set instead.
    if (markets.length > 0) {
      cache = { markets, at: Date.now() };
      console.log(`[live-markets] cached ${markets.length} raw markets`);
      return markets;
    }
    console.warn(`[live-markets] empty fetch — serving ${cache?.markets.length ?? 0} cached`);
    return cache?.markets ?? [];
  } catch (e) {
    console.error("[live-markets] fetch failed:", e instanceof Error ? e.message : e);
    return cache?.markets ?? [];
  }
}
