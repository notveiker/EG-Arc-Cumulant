/**
 * Cumulant shared domain types.
 *
 * Shared domain types; the only change
 * is the on-chain layer — on Arc the on-chain identifiers are EVM addresses / tx
 * hashes (0x…, 66 chars). All financial fields are identical. USDC is
 * 6-decimals on-chain; the off-chain rows here store human USD numbers.
 *
 * Polymarket Gamma types live in `../types.js` and are re-exported below so a
 * single import (`../types/index.js`) gives callers the full surface.
 */

// Re-export the Polymarket types kept in the existing flat module.
export type {
  PolymarketToken,
  PolymarketMarket,
  PolymarketEvent,
} from "../types.js";

// === Database types (mirror the Supabase schema) ===

export interface Bundle {
  id: string;
  name: string; // e.g. "CBU-HIGH-SHORT"
  risk_tier: 90 | 70 | 50;
  resolution_date: string; // ISO date
  issue_price: number; // e.g. 0.90
  status: "active" | "resolved" | "cancelled";
  created_at: string;
  description?: string;
  theme?: string; // e.g. "Mixed Q2 2026"
}

export interface Leg {
  id: string;
  bundle_id: string;
  market_id: string; // Polymarket condition_id or token_id
  question: string; // e.g. "Will BTC hit $100k by April 30?"
  probability: number; // current probability 0-1
  weight: number; // weight in bundle (equal weight = 1/num_legs)
  status: "active" | "won" | "lost";
  resolution_value?: number; // 1.0 if won, 0.0 if lost
  polymarket_url?: string;
  created_at: string;
}

export interface Position {
  id: string;
  bundle_id: string;
  wallet_address: string; // EVM address
  tokens_held: number;
  entry_price: number; // price at time of purchase
  deposited_usdc: number;
  created_at: string;
}

export interface Transaction {
  id: string;
  bundle_id: string;
  wallet_address: string; // EVM address
  type: "deposit" | "redemption" | "divest" | "transfer";
  amount_usdc: number;
  tokens: number;
  fee_usdc: number; // structuring fee
  tx_hash?: string; // client-provided Arc EVM tx hash (0x…, 66 chars)
  created_at: string;
}

// === Aggregated API response types ===

export interface BundleWithLegs extends Bundle {
  legs: Leg[];
  nav: number; // current NAV
  num_legs: number;
  resolved_legs: number;
}

export interface LegNAVContribution {
  leg_id: string;
  question: string;
  status: "active" | "won" | "lost";
  probability: number;
  weight: number;
  contribution: number; // weight * (probability or resolution_value)
}

export interface NAVResult {
  bundle_id: string;
  nav: number;
  legs: LegNAVContribution[];
  timestamp: string;
}

export interface NavSnapshot {
  id: string;
  bundle_id: string;
  nav: number;
  legs_data: LegNAVContribution[];
  created_at: string;
}

// === Deposit / redeem ===

export interface DepositRequest {
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
}

export interface DepositResponse {
  transaction_id: string;
  bundle_id: string;
  tokens_minted: number;
  issue_price: number;
  fee_usdc: number;
  net_usdc: number;
}

// === PPN (Principal Protected Notes) ===

export interface PPNVault {
  id: string;
  bundle_id: string;
  wallet_address: string; // EVM address
  principal_usdc: number; // original protected-note deposit
  yield_deployed_usdc: number; // accumulated yield deployed into bundles
  estimated_apy: number; // current estimated APY from the Arc yield sleeve
  vault_address: string; // Arc ProtectedNote contract address for this note
  status: "active" | "matured" | "withdrawn";
  created_at: string;
  maturity_date: string;
  // On-chain integration columns. All nullable so local rows round-trip.
  note_seed_hex?: string | null;
  onchain_tx_hash?: string | null; // deposit tx hash (was onchain_tx_signature)
  redemption_tx_hash?: string | null; // redeem tx hash
  maturity_ts?: number | null;
  // Tranche overlay. NULL columns = vanilla PPN.
  tranche_kind?: TrancheKind | null;
  tranche_attach?: number | null;
  tranche_detach?: number | null;
  price_per_token?: number | null;
}

export interface PPNDepositRequest {
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
  maturity_days?: number; // default 30
  // Tranche overlay — protected notes are reused for senior/mezz/junior tranches.
  tranche_kind?: TrancheKind;
  tranche_attach?: number;
  tranche_detach?: number;
  price_per_token?: number;
}

export interface PPNDepositResponse {
  vault_id: string;
  bundle_id: string;
  principal_usdc: number;
  estimated_apy: number;
  estimated_yield_at_maturity: number;
  maturity_date: string;
  message: string;
}

// === Tranches (pricing) ===

export type TrancheKind = "senior" | "mezzanine" | "junior";

export interface TrancheSpec {
  kind: TrancheKind;
  attach: number;
  detach: number;
}

export interface TrancheQuote {
  kind: TrancheKind;
  attach: number;
  detach: number;
  /** Issue / ask price as a fraction of $1 face. */
  pricePerToken: number;
  /** Risk-neutral expected payoff per $1 face. */
  fairPrice: number;
  /** Annualised simple return at fair payout (percent). */
  expectedYieldPct: number;
  attachProbability: number;
  fullPayProbability: number;
  /** Always $1 per token. */
  faceValue: number;
  /** Same as expectedYieldPct; kept so callers still compile. */
  recommendedApr: number;
  mmSpreadBps: number;
  underwritingBps: number;
  protocolFeeBps: number;
  delta: number;
  gamma: number;
  capitalAtRisk: number;
  cvar95: number;
  maxOrderUsdc: number;
}

// === Note allocator (deterministic heuristic split) ===

export type SleeveProduct = "basket" | "tranche" | "distribution";

export interface SleeveLeg {
  product: SleeveProduct;
  kind?: TrancheKind;
  pct: number; // share of the risk sleeve
  usdc: number;
  label: string;
}

export interface NoteAllocation {
  profile: string;
  deposit_usdc: number;
  apy: number;
  maturity_days: number;
  floor: { pct: number; usdc: number; at_maturity_usdc: number };
  risk_sleeve: { pct: number; usdc: number; legs: SleeveLeg[] };
}

// === Portfolio composer (deterministic, non-AI) ===

export interface PortfolioRequest {
  risk_pct: number;
  capital_usd: number;
  objective: "income" | "speculation" | "balanced";
  horizon: "short" | "medium" | "long";
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
  tier: TrancheKind;
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
}

// === Alerts ===

export interface PriceAlert {
  id: string;
  bundle_id: string;
  wallet_address: string;
  alert_type: "above" | "below" | "change_percent";
  threshold: number; // above/below: NAV threshold. change_percent: % change.
  triggered: boolean;
  triggered_at?: string;
  triggered_nav?: number;
  created_at: string;
}

// === Receipts / evidence ===

export interface ReceiptMeta {
  id: string;
  wallet_address: string | null; // EVM address
  context_type: string | null; // basket | tranche | ppn | distribution | deposit
  context_id: string | null; // bundle / position id the evidence supports
  tx_hash: string | null; // optional on-chain tx hash
  filename: string;
  mime: string;
  size: number;
  memo: string | null;
  created_at: string; // ISO 8601
}
