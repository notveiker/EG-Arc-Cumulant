/**
 * Portfolio allocation composer. Given a risk tolerance + capital, builds a
 * structured allocation plan from the live Cumulant primitive surface.
 *
 * The on-chain contracts and Supabase rows are untouched - this is purely an
 * off-chain suggestion endpoint. Allocation is produced by a deterministic
 * heuristic split (no LLM): weights are derived from the risk profile and
 * objective, then validated, renormalised, and risk-scored server-side.
 */
import { snapshot as lendingSnapshot, type PoolSnapshot } from "./lending.js";
import { quoteTranches, type TrancheQuote } from "./tranching.js";
import { filterMarkets, type FilteredMarket } from "./market-filter.js";
import { fetchMarkets } from "./polymarket.js";
import { assessBasketRisk, type LegMetadata } from "./correlation.js";
import { getAllBundles } from "../db/queries.js";

const CAPITAL_CAP_USD = 100_000;
const MAX_MARKETS_IN_PROMPT = 20;

export interface PortfolioRequest {
  risk_pct: number;
  capital_usd: number;
  objective: "income" | "speculation" | "balanced";
  horizon: "short" | "medium" | "long";
  // Optional reference basket supplied by the frontend. When present, the
  // backend uses these values directly instead of querying Supabase, so
  // every recommendation deep-links to a basket the frontend can resolve.
  basket?: {
    id: string;
    name: string;
    risk_tier: number;
    nav: number;
    days: number;
    legs: number;
  };
}

export interface AllocationTrancheDetails {
  basket_id?: string;
  basket_name?: string;
  tier: "senior" | "mezzanine" | "junior";
  expected_yield_pct: number;
  price_per_token: number;
}
export interface AllocationLendingDetails {
  supply_apy_pct: number;
  utilization: number;
}
export interface AllocationMarketDetails {
  market_id: string;
  question: string;
  side: "YES" | "NO";
  implied_prob: number;
  category?: string;
}

export interface Allocation {
  kind: "tranche" | "lending" | "market";
  weight: number;
  usd_amount: number;
  details:
    | AllocationTrancheDetails
    | AllocationLendingDetails
    | AllocationMarketDetails;
  rationale: string;
}

export interface PortfolioResponse {
  allocations: Allocation[];
  summary: string;
  expected_apy_low: number;
  expected_apy_high: number;
  risk_score: number;
  generated_at: string;
  cache: {
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    input_tokens: number;
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Primitive fetching
// ---------------------------------------------------------------------------

interface Primitives {
  lending: PoolSnapshot;
  markets: FilteredMarket[];
  tranches: TrancheQuote[];
  refBundle: {
    id: string;
    name: string;
    risk_tier: number;
    nav: number;
    days: number;
    legs: number;
  };
}

async function fetchPrimitives(clientBasket?: PortfolioRequest["basket"]): Promise<Primitives> {
  const lending = lendingSnapshot();

  // Curated markets via the existing filter pipeline.
  const raw = await fetchMarkets({ limit: 80, active: true, closed: false });
  const filtered = filterMarkets(raw, {});
  const markets = [...filtered.kept]
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, MAX_MARKETS_IN_PROMPT);

  // Reference basket resolution priority:
  //   1. client-supplied basket (frontend's real universe — the only ids
  //      the /app/tranche/[id] route can actually resolve)
  //   2. Supabase active bundle (legacy path, kept for backwards compat)
  //   3. mock fallback (pre-seed demo)
  let refBundle: Primitives["refBundle"];
  if (clientBasket) {
    refBundle = { ...clientBasket };
    const tranches = quoteTranches({
      bundleNav: refBundle.nav,
      totalLegs: refBundle.legs,
      horizonDays: refBundle.days,
    });
    return { lending, markets, tranches, refBundle };
  }

  // Tranche quotes: pick the first active bundle if Supabase has one,
  // otherwise fall back to a mock so the endpoint still works pre-seed.
  // getAllBundles() is a safe no-op (returns []) when Supabase is unconfigured.
  const bundles = await getAllBundles();
  if (bundles.length > 0) {
    const b = bundles[0];
    const days = Math.max(
      1,
      Math.ceil(
        (new Date(b.resolution_date).getTime() - Date.now()) / 86_400_000,
      ),
    );
    const nav = Math.max(0.05, Math.min(0.95, b.issue_price ?? 0.5));
    refBundle = {
      id: b.id,
      name: b.name,
      risk_tier: b.risk_tier,
      nav,
      days,
      legs: 11,
    };
  } else {
    refBundle = {
      id: "mock",
      name: "Demo Basket (mock)",
      risk_tier: 70,
      nav: 0.5,
      days: 30,
      legs: 11,
    };
  }
  const tranches = quoteTranches({
    bundleNav: refBundle.nav,
    totalLegs: refBundle.legs,
    horizonDays: refBundle.days,
  });

  return { lending, markets, tranches, refBundle };
}

// ---------------------------------------------------------------------------
// Deterministic heuristic plan
//
// The allocation is built entirely from the risk profile + objective. We pick
// a default per-tier weight vector, drop any tier with no live quote, then
// renormalise so the surviving weights sum to 1.0. Yields and prices come
// straight from the tranche quotes (never invented).
// ---------------------------------------------------------------------------

function deterministicPlan(req: PortfolioRequest, prims: Primitives): {
  allocations: Allocation[];
  summary: string;
  expected_apy_low: number;
  expected_apy_high: number;
} {
  const quoteByTier = new Map(prims.tranches.map((t) => [t.kind, t]));
  const desired: Array<{ tier: "senior" | "mezzanine" | "junior"; weight: number }> =
    req.risk_pct >= 70 || req.objective === "speculation"
      ? [
          { tier: "senior", weight: 0.2 },
          { tier: "mezzanine", weight: 0.45 },
          { tier: "junior", weight: 0.35 },
        ]
      : req.risk_pct <= 30 || req.objective === "income"
        ? [
            { tier: "senior", weight: 0.8 },
            { tier: "mezzanine", weight: 0.2 },
          ]
        : [
            { tier: "senior", weight: 0.55 },
            { tier: "mezzanine", weight: 0.35 },
            { tier: "junior", weight: 0.1 },
          ];

  const available = desired.filter((row) => quoteByTier.has(row.tier));
  const weightSum = available.reduce((sum, row) => sum + row.weight, 0) || 1;
  const allocations: Allocation[] = available.map((row) => {
    const quote = quoteByTier.get(row.tier)!;
    const weight = row.weight / weightSum;
    return {
      kind: "tranche",
      weight: +weight.toFixed(4),
      usd_amount: +(weight * req.capital_usd).toFixed(2),
      details: {
        basket_id: prims.refBundle.id,
        basket_name: prims.refBundle.name,
        tier: quote.kind,
        expected_yield_pct: quote.expectedYieldPct,
        price_per_token: quote.pricePerToken,
      },
      rationale:
        quote.kind === "senior"
          ? "Core capital protection sleeve with first-loss subordination beneath it."
          : quote.kind === "mezzanine"
            ? "Middle-risk sleeve that adds yield without taking the full tail."
            : "Upside sleeve for higher dispersion when the basket pays strongly.",
    };
  });

  const weightedApy = allocations.reduce((sum, a) => {
    const details = a.details as AllocationTrancheDetails;
    return sum + a.weight * details.expected_yield_pct;
  }, 0);
  const bias =
    req.objective === "income"
      ? "income-focused"
      : req.objective === "speculation"
        ? "upside-focused"
        : "balanced";

  return {
    allocations,
    summary: `A ${bias} allocation across ${prims.refBundle.name}, using live tranche quotes and keeping weights normalized to the requested capital. The split favors ${allocations[0]?.details && (allocations[0].details as AllocationTrancheDetails).tier} exposure first, with additional risk added only where the selected objective supports it.`,
    expected_apy_low: Math.max(0, +(weightedApy * 0.85).toFixed(2)),
    expected_apy_high: +(weightedApy * 1.15).toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Validation, renormalisation, risk scoring
// ---------------------------------------------------------------------------

function validateAndRenormalize(
  parsed: any,
  capital_usd: number,
): {
  allocations: Allocation[];
  summary: string;
  expected_apy_low: number;
  expected_apy_high: number;
} {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("plan is not an object");
  }
  if (!Array.isArray(parsed.allocations) || parsed.allocations.length === 0) {
    throw new Error("allocations must be a non-empty array");
  }
  if (typeof parsed.summary !== "string") throw new Error("summary missing");
  if (
    typeof parsed.expected_apy_low !== "number" ||
    typeof parsed.expected_apy_high !== "number"
  ) {
    throw new Error("expected_apy_low / expected_apy_high must be numbers");
  }

  let sum = 0;
  for (const a of parsed.allocations) {
    if (typeof a.weight !== "number" || !Number.isFinite(a.weight)) {
      throw new Error("non-numeric weight");
    }
    if (a.weight < 0 || a.weight > 1) {
      throw new Error(`weight ${a.weight} out of [0, 1]`);
    }
    // Only tranche allocations are valid. Reject any stale allocation that
    // slipped through (lending, market, etc.).
    if (a.kind !== "tranche") {
      throw new Error(`invalid allocation kind "${a.kind}" - only "tranche" is allowed`);
    }
    sum += a.weight;
  }
  if (Math.abs(sum - 1) > 0.01) {
    throw new Error(
      `weights sum to ${sum.toFixed(4)}, outside tolerance of 0.01`,
    );
  }

  // Renormalise to exactly 1.0 and compute usd_amount.
  const allocations: Allocation[] = parsed.allocations.map((a: any) => {
    const w = a.weight / sum;
    return {
      kind: a.kind,
      weight: +w.toFixed(4),
      usd_amount: +(w * capital_usd).toFixed(2),
      details: a.details ?? {},
      rationale: typeof a.rationale === "string" ? a.rationale : "",
    };
  });

  return {
    allocations,
    summary: parsed.summary,
    expected_apy_low: +parsed.expected_apy_low.toFixed(2),
    expected_apy_high: +parsed.expected_apy_high.toFixed(2),
  };
}

/**
 * Risk score 0-100. Lending contributes almost nothing (~2 per weight unit),
 * tranches contribute per-tier (senior 10, mezz 40, junior 75), and markets
 * go through `assessBasketRisk` - only the market legs are treated as a
 * basket, using normalised weights across the market allocations only.
 */
function computeRiskScore(allocations: Allocation[]): number {
  let trancheRisk = 0;
  let lendingRisk = 0;
  const marketAllocs: Allocation[] = [];

  for (const a of allocations) {
    if (a.kind === "tranche") {
      const tier = (a.details as AllocationTrancheDetails).tier;
      const factor =
        tier === "senior" ? 0.1 : tier === "mezzanine" ? 0.4 : 0.75;
      trancheRisk += a.weight * factor;
    } else if (a.kind === "lending") {
      lendingRisk += a.weight * 0.02;
    } else if (a.kind === "market") {
      marketAllocs.push(a);
    }
  }

  let marketRisk = 0;
  if (marketAllocs.length > 0) {
    const marketWeightSum = marketAllocs.reduce((s, a) => s + a.weight, 0);
    const legs: LegMetadata[] = marketAllocs.map((a, i) => {
      const d = a.details as AllocationMarketDetails;
      return {
        id: d.market_id || `leg-${i}`,
        question: d.question || "",
        probability: d.implied_prob,
        tags: d.category ? [d.category] : [],
      };
    });
    const normalizedWeights = marketAllocs.map(
      (a) => a.weight / marketWeightSum,
    );
    try {
      const risk = assessBasketRisk(legs, normalizedWeights);
      marketRisk = Math.min(1, risk.cvar_99_projected * 4) * marketWeightSum;
    } catch {
      marketRisk = marketWeightSum * 0.8;
    }
  }

  const combined = marketRisk + trancheRisk + lendingRisk;
  return Math.round(Math.max(0, Math.min(100, combined * 100)));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function constructPortfolio(
  req: PortfolioRequest,
): Promise<PortfolioResponse> {
  if (req.risk_pct < 0 || req.risk_pct > 100) {
    throw new Error("risk_pct must be in [0, 100]");
  }
  if (req.capital_usd <= 0 || req.capital_usd > CAPITAL_CAP_USD) {
    throw new Error(
      `capital_usd must be in (0, ${CAPITAL_CAP_USD}] for demo safety`,
    );
  }

  const prims = await fetchPrimitives(req.basket);
  // Deterministic heuristic split — no LLM. The plan already cites the live
  // tranche quotes verbatim, so it goes through the same validation path the
  // legacy model output did.
  const plan = deterministicPlan(req, prims);
  const validated = validateAndRenormalize(plan, req.capital_usd);
  // Inject the reference basket id into each tranche allocation's details
  // so the frontend can deep-link the card to /app/tranche/[basket_id].
  // We cast through `Allocation` because the spread preserves the
  // original details shape (AllocationTrancheDetails) and only appends
  // an optional `basket_id` field — the AllocationTrancheDetails interface
  // already accommodates extra string keys via its index signature.
  const withBasketId: Allocation[] = validated.allocations.map((a) => {
    if (a.kind !== "tranche") return a;
    return {
      ...a,
      details: {
        ...(a.details as AllocationTrancheDetails),
        basket_id: prims.refBundle.id,
      },
    } as Allocation;
  });
  const risk_score = computeRiskScore(withBasketId);

  return {
    allocations: withBasketId,
    summary: validated.summary,
    expected_apy_low: validated.expected_apy_low,
    expected_apy_high: validated.expected_apy_high,
    risk_score,
    generated_at: new Date().toISOString(),
    // Anthropic/Claude removed — there are no LLM token costs on Arc. The
    // cache block is retained at zeros so existing callers (and the ported
    // frontend) compile and render unchanged.
    cache: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}
