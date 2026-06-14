"use client";

/**
 * Cumulant protected-note (PPN) and tranche client (Circle Arc / EVM).
 *
 * Backend portfolio/RFQ reads provide durable rows and market-maker style quote
 * previews. Writes follow the Arc rail:
 *
 *   POST /api/ppn/onchain/<verb>/prepare -> backend returns the on-chain target
 *   { note_id | tranche_id, vault, tranche_kind?, amount_usdc6dp } -> the wallet
 *   signs CLIENT-SIDE via `useCumulant()` (depositNote/redeemNote, or
 *   depositTranche/redeemTranche for tranche-kind sleeves) -> POST /confirm
 *   { signature: <txHash> }.
 *
 * `signature` in the returned shapes is an EVM tx hash; explorer URLs point at
 * Arcscan. Because the actual signing lives in the `useCumulant()` React hook,
 * the lifecycle functions accept an OPTIONAL `signNote` callback (a
 * {@link PpnSigner}, produced by {@link usePpnSigner}); the calling page wires it
 * from hook context.
 */

import { useCallback } from "react";
import { parseUnits, type Address } from "viem";
import { useConfig } from "@/lib/hooks";
import { useCumulant } from "@/lib/tx";
import { BACKEND_URL } from "./tokens";
import { unwrap } from "./http";
import type { WalletSigner } from "./wallet-bridge";

export type { WalletSigner };

function normalizeName(name: string): string {
  return name;
}

type BundleSummary = {
  id: string;
  name: string;
};

let _bundleMap: Promise<Map<string, BundleSummary>> | null = null;

function loadBundleMap(force = false): Promise<Map<string, BundleSummary>> {
  if (force) _bundleMap = null;
  if (_bundleMap) return _bundleMap;
  _bundleMap = (async () => {
    const res = await fetch(`${BACKEND_URL}/api/bundles`);
    if (!res.ok) {
      _bundleMap = null;
      throw new PpnError(`Failed to load /api/bundles (HTTP ${res.status})`, res.status);
    }
    const rows = (await res.json()) as BundleSummary[];
    const map = new Map<string, BundleSummary>();
    for (const row of rows) map.set(row.name, row);
    return map;
  })();
  return _bundleMap;
}

function tierFromName(name: string): 90 | 70 | 50 | null {
  const upper = name.toUpperCase();
  if (/\b(HIGH|-90-)/.test(upper)) return 90;
  if (/\b(MID|-70-)/.test(upper)) return 70;
  if (/\b(LOW|-50-)/.test(upper)) return 50;
  return null;
}

function pickFallbackBundle(
  map: Map<string, BundleSummary>,
  uiBundleId: string,
): BundleSummary | null {
  const bundles = Array.from(map.values());
  if (bundles.length === 0) return null;
  const tier = tierFromName(uiBundleId);
  if (tier !== null) {
    const tierMatch = bundles.find((b) => tierFromName(b.name) === tier);
    if (tierMatch) return tierMatch;
  }
  return bundles[0];
}

async function resolveBundleUuidForPpn(uiBundleId: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uiBundleId)) {
    return uiBundleId;
  }
  const dbName = normalizeName(uiBundleId);
  const map = await loadBundleMap();
  const exact = map.get(dbName);
  if (exact) return exact.id;

  const fallback = pickFallbackBundle(map, uiBundleId);
  if (fallback) {
    if (typeof window !== "undefined") {
      console.warn(
        `[ppn-client] Basket "${uiBundleId}" not in backend; routing to "${fallback.name}" (${fallback.id}).`,
      );
    }
    return fallback.id;
  }

  throw new PpnError(
    `Bundle "${dbName}" not found. Known bundles: ${Array.from(map.keys()).join(", ") || "(none)"}`,
    404,
  );
}

export class PpnError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: unknown = undefined;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    const msg =
      (payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : null) ?? `HTTP ${res.status}`;
    throw new PpnError(msg, res.status, payload);
  }
  return unwrap<T>(payload);
}

// ---- Capital deployment plan (floor sleeve + multi-product risk sleeve) ----

export interface NoteSleeveLeg {
  product: "basket" | "tranche" | "distribution";
  kind?: "senior" | "mezzanine" | "junior";
  pct: number;
  usdc: number;
  label: string;
}

export interface NoteExitLeg {
  product: "basket" | "tranche" | "distribution" | "floor";
  label: string;
  weight: number;
  fee_bps: number;
  fee_usdc: number;
}

export interface NoteExitPlan {
  blended_fee_bps: number;
  est_fee_usdc: number;
  legs: NoteExitLeg[];
}

export interface NoteAllocation {
  profile: string;
  deposit_usdc: number;
  apy: number;
  maturity_days: number;
  floor: { pct: number; usdc: number; at_maturity_usdc: number };
  risk_sleeve: { pct: number; usdc: number; legs: NoteSleeveLeg[] };
  exit: NoteExitPlan;
}

/** Ask the backend allocator how a note's capital deploys across products. */
export function fetchNoteAllocation(args: {
  profile: string;
  amountUsdc: number;
  apy: number;
  days: number;
  basketLabel?: string;
  distributionLabel?: string;
  baskets?: string[];
  distributions?: string[];
}): Promise<NoteAllocation> {
  return postJson<NoteAllocation>("/api/ppn/allocate", {
    profile: args.profile,
    amount_usdc: args.amountUsdc,
    apy: args.apy,
    days: args.days,
    basket_label: args.basketLabel,
    distribution_label: args.distributionLabel,
    baskets: args.baskets,
    distributions: args.distributions,
  });
}

export interface PpnPrepareResponse {
  kind: "prepared";
  vault_id: string | null;
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
  fee_usdc?: number;
  net_deposit_usdc?: number;
  deposit_fee_bps?: number;
  expected_shares?: number;
  share_price?: number;
  management_fee_bps?: number;
  management_fee_usdc?: number;
  strategy_fee_bps?: number;
  strategy_fee_usdc?: number;
  total_open_fee_usdc?: number;
  estimated_apy?: number;
  maturity_date: string;
  maturity_ts: number;
  position_id: string;
  tx_hash?: string;
  prepared_tx?: string;
  sender?: string;
  dry_run?: { ok: boolean; status: string; gas_used?: string; error?: string };
  // ── Arc on-chain resolution (added by the EVM backend) ──────────────────────
  /** On-chain protected-note position id for `useCumulant().depositNote`. */
  note_id?: number | string | null;
  /** On-chain tranche position id for `useCumulant().depositTranche`. */
  tranche_id?: number | string | null;
  /** Contract that receives the deposit (ProtectedNote or TrancheVault address). */
  vault?: Address | string | null;
  /** Tranche kind when the sleeve rides the tranche rail. */
  tranche_kind?: "senior" | "mezzanine" | "junior" | null;
  /** Net deposit in 6-decimal base units, string for bigint safety. */
  amount_usdc6dp?: string | number | null;
}

export interface PpnConfirmResponse {
  confirmed?: boolean;
  vault_id?: string | null;
  bundle_id?: string;
  wallet_address?: string;
  principal_usdc?: number;
  signature?: string;
  tx_hash?: string;
  explorer_url?: string;
  transaction_id?: string | null;
}

export interface PpnRedeemPrepareResponse {
  kind: "prepared";
  vault_id?: string | null;
  bundle_id?: string | null;
  wallet_address: string;
  principal_usdc: number;
  strategy_fee_bps?: number;
  strategy_fee_usdc?: number;
  expected_proceeds_usdc: number;
  position_id?: string;
  share_id?: string;
  tx_hash?: string;
  prepared_tx?: string;
  sender?: string;
  dry_run?: { ok: boolean; status: string; gas_used?: string; error?: string };
  // ── Arc on-chain resolution (added by the EVM backend) ──────────────────────
  /** On-chain protected-note position id for `useCumulant().redeemNote`. */
  note_id?: number | string | null;
  /** On-chain tranche position id for `useCumulant().redeemTranche`. */
  tranche_id?: number | string | null;
  /** Contract that holds the position (ProtectedNote or TrancheVault address). */
  vault?: Address | string | null;
  /** Tranche kind when the position rides the tranche rail. */
  tranche_kind?: "senior" | "mezzanine" | "junior" | null;
  /** Shares to redeem for tranche-rail positions, string for bigint safety. */
  shares?: string | number | null;
}

export interface PpnRedeemConfirmResponse {
  confirmed?: boolean;
  vault_id?: string | null;
  bundle_id?: string;
  wallet_address?: string;
  principal_returned?: number;
  signature?: string;
  tx_hash?: string;
  explorer_url?: string;
  transaction_id?: string | null;
}

export interface PpnDivestPrepareResponse {
  kind: "prepared";
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  strategy_fee_bps: number;
  estimated_strategy_fee_usdc: number;
  position_id: string;
  tx_hash: string;
}

export interface PpnDivestConfirmResponse {
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  signature: string;
  status: "active";
}

export interface PpnClosePrepareResponse {
  kind: "prepared";
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  principal_usdc: number;
  strategy_fee_bps: number;
  estimated_strategy_fee_usdc: number;
  estimated_net_usdc: number;
  position_id: string;
  tx_hash: string;
}

export interface PpnCloseConfirmResponse {
  vault_id: string;
  bundle_id: string;
  wallet_address: string;
  principal_returned: number;
  signature: string;
  transaction_id: string | null;
  status: "withdrawn";
}

export interface TrancheSellRfqQuote {
  vault_id: string;
  bundle_id?: string;
  tranche_kind?: "senior" | "mezzanine" | "junior" | null;
  status: "can_execute_onchain" | "rfq_only" | "missing";
  matured?: boolean;
  maturity_ts?: number;
  seconds_remaining?: number;
  entry_price_per_token?: number;
  indicative_price_per_token?: number;
  indicative_price_pct?: number;
  indicative_usdc?: number;
  mm_spread_bps?: number;
  slippage_bps?: number;
  underwriting_bps?: number;
  total_haircut_bps?: number;
  onchain_expected_usdc?: number;
  onchain_gross_usdc?: number;
  onchain_basket_exit_fee_bps?: number;
  onchain_strategy_fee_bps?: number;
  error?: string;
}

export interface TrancheSellRfqResponse {
  kind: "rfq";
  quotes: TrancheSellRfqQuote[];
  executable_count: number;
}

export interface TrancheOverlay {
  kind: "senior" | "mezzanine" | "junior";
  attach: number;
  detach: number;
  pricePerToken: number;
}

export async function fetchTrancheSellRfq(args: {
  vaultIds: string[];
  walletAddress: string;
}): Promise<TrancheSellRfqResponse> {
  return postJson<TrancheSellRfqResponse>("/api/ppn/tranche/sell/rfq", {
    vault_ids: args.vaultIds,
    wallet_address: args.walletAddress,
  });
}

export interface PpnPortfolioEntry {
  vault_id: string;
  bundle_id: string;
  bundle_name: string;
  bundle_status: string;
  principal_usdc: number;
  yield_deployed_usdc: number;
  accrued_yield: number;
  projected_total_yield: number;
  estimated_apy: number;
  status: "active" | "matured" | "withdrawn";
  days_elapsed: number;
  days_remaining: number;
  maturity_date: string;
  created_at: string;
  total_value: number;
  tranche_kind: "senior" | "mezzanine" | "junior" | null;
  tranche_attach: number | null;
  tranche_detach: number | null;
  price_per_token: number | null;
  /**
   * True only when the row is backed by a REAL position on the CURRENT on-chain
   * protectedNote/trancheVault with a positive balance. Stale rows from an old
   * deployment (wrong vault / zero on-chain balance) are tagged false (or omitted
   * by the backend). The merge helpers drop any row that isn't backed so a stale
   * position can't render as live or expose an un-quotable Sell. Optional so an
   * older backend that omits the flag is treated as backed (no regression).
   */
  is_onchain_backed?: boolean;
}

export interface PpnPortfolio {
  wallet_address: string;
  vaults: PpnPortfolioEntry[];
  summary: {
    total_vaults: number;
    total_principal: number;
    total_accrued_yield: number;
    total_value: number;
    principal_protected: boolean;
  };
}

export async function fetchPpnPortfolio(walletAddress: string): Promise<PpnPortfolio> {
  const res = await fetch(
    `${BACKEND_URL}/api/ppn/portfolio/${encodeURIComponent(walletAddress)}`,
  );
  if (!res.ok) {
    throw new PpnError(`Failed to load PPN portfolio (HTTP ${res.status})`, res.status);
  }
  return unwrap<PpnPortfolio>(await res.json());
}

function requireWallet(wallet: WalletSigner): string {
  if (!wallet.connected || !wallet.address) {
    throw new PpnError("Connect an Arc wallet to continue.", 0);
  }
  return wallet.address;
}

// ─── Arc on-chain signer (client-side via useCumulant) ────────────────────────

/**
 * Signs the on-chain leg of a PPN/tranche action and returns the EVM tx hash.
 * Two flavours are passed to the lifecycle functions below:
 *   - a "deposit" signer (resolves the prepare into depositNote/depositTranche)
 *   - a "redeem" signer (resolves the prepare into redeemNote/redeemTranche)
 * The page produces both from {@link usePpnSigner} and threads them in.
 */
export type PpnSigner = (
  prep: PpnPrepareResponse | PpnRedeemPrepareResponse,
) => Promise<string>;

/**
 * Resolved on-chain handle from a prepare response. `vault` is the contract
 * (ProtectedNote or TrancheVault); `id` is its position id; `trancheKind` is set
 * only when the sleeve rides the tranche rail.
 */
interface OnchainTarget {
  vault: Address;
  id: number;
  trancheKind: "senior" | "mezzanine" | "junior" | null;
  shares: bigint | null;
  amount6dp: bigint | null;
}

function toBigintAmount(value: string | number | null | undefined): bigint | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return parseUnits(String(value), 6);
  // String: already-6dp base units. Tolerate a stray decimal/scientific form
  // instead of letting BigInt() throw an opaque SyntaxError.
  const s = value.trim();
  if (/^\d+$/.test(s)) return BigInt(s);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new PpnError(`Invalid base-unit amount: ${value}`, 0);
  return BigInt(Math.round(n));
}

/**
 * The on-chain TrancheVault models a single `bool senior`. Senior is the
 * protected slice; mezzanine and junior both ride the subordinate (first-loss)
 * slice on-chain. The distinct mezzanine economics (its own attach/detach +
 * price) live in the off-chain quote + ledger metadata, so the chain only needs
 * the senior-vs-subordinate flag here.
 */
function trancheSeniorFlag(kind: "senior" | "mezzanine" | "junior"): boolean {
  return kind === "senior";
}

function toPositionId(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function resolveOnchainTarget(
  prep: PpnPrepareResponse | PpnRedeemPrepareResponse,
  cfg: { protectedNote?: Address | null; trancheVault?: Address | null } | undefined,
): OnchainTarget {
  const trancheKind = prep.tranche_kind ?? null;
  const isTranche = trancheKind != null || prep.tranche_id != null;

  const id = toPositionId(isTranche ? prep.tranche_id : prep.note_id);
  if (id == null) {
    throw new PpnError(
      "Backend did not return an on-chain note/tranche id for this action.",
      0,
      prep,
    );
  }

  const fallbackVault = isTranche ? cfg?.trancheVault : cfg?.protectedNote;
  const vault = (prep.vault ?? fallbackVault) as Address | undefined;
  if (!vault) {
    throw new PpnError(
      "Backend did not return an on-chain vault address (and none is configured).",
      0,
      prep,
    );
  }

  const shares =
    "shares" in prep ? toBigintAmount((prep as PpnRedeemPrepareResponse).shares) : null;
  const amount6dp =
    "amount_usdc6dp" in prep
      ? toBigintAmount((prep as PpnPrepareResponse).amount_usdc6dp)
      : null;

  return { vault, id, trancheKind, shares, amount6dp };
}

/**
 * Returns the two {@link PpnSigner} callbacks used by the lifecycle functions.
 * Deposits route to `depositNote`/`depositTranche`; redeems to
 * `redeemNote`/`redeemTranche`. Both resolve once the tx is mined and return the
 * tx hash, which the lifecycle functions POST to the matching `/confirm`.
 */
export function usePpnSigner(): { signDeposit: PpnSigner; signRedeem: PpnSigner } {
  const { data: cfg } = useConfig();
  const { depositNote, depositTranche, redeemNote, redeemTranche } = useCumulant();

  const signDeposit = useCallback<PpnSigner>(
    async (prep) => {
      const usdc = cfg?.usdc as Address | undefined;
      if (!usdc) throw new PpnError("USDC token address is not configured.", 0);
      const t = resolveOnchainTarget(prep, cfg);
      const amount =
        t.amount6dp ??
        ("amount_usdc" in prep && prep.amount_usdc != null
          ? parseUnits(String(prep.amount_usdc), 6)
          : null);
      if (amount == null) {
        throw new PpnError("Backend did not return a deposit amount.", 0, prep);
      }
      if (t.trancheKind != null) {
        return depositTranche(t.vault, usdc, t.id, amount, trancheSeniorFlag(t.trancheKind));
      }
      return depositNote(t.vault, usdc, t.id, amount);
    },
    [cfg, depositNote, depositTranche],
  );

  const signRedeem = useCallback<PpnSigner>(
    async (prep) => {
      const t = resolveOnchainTarget(prep, cfg);
      if (t.trancheKind != null) {
        const shares = t.shares ?? 0n;
        return redeemTranche(t.vault, t.id, shares, trancheSeniorFlag(t.trancheKind));
      }
      return redeemNote(t.vault, t.id);
    },
    [cfg, redeemNote, redeemTranche],
  );

  return { signDeposit, signRedeem };
}

/**
 * Signs a prepared deposit: prefers the client-side `signNote` (Arc) and falls
 * back to the wallet.s own signing path only if the backend
 * still returns tx bytes. Returns the EVM tx hash.
 */
async function signPrepared(
  wallet: WalletSigner,
  prep: PpnPrepareResponse | PpnRedeemPrepareResponse,
  signNote: PpnSigner | undefined,
  missingMsg: string,
): Promise<string> {
  if (signNote) {
    return signNote(prep);
  }
  if (prep.prepared_tx) {
    return wallet.signPreparedTx(prep.prepared_tx);
  }
  throw new PpnError(missingMsg, 0, prep);
}

/**
 * Non-custodial protected-note / tranche open. On Arc: backend resolves the
 * on-chain note/tranche id + vault via `/api/ppn/onchain/prepare`, the wallet
 * signs the deposit CLIENT-SIDE via `useCumulant()` (depositNote/depositTranche,
 * passed in as `signNote` from {@link usePpnSigner}), then `/confirm` records the
 * ledger row. `signature` in the result is the EVM tx hash.
 */
export async function ppnDeposit(args: {
  wallet: WalletSigner;
  bundleId: string;
  amountUsdc: number;
  maturityDays?: number;
  confirmationTimeoutMs?: number;
  tranche?: TrancheOverlay;
  signNote?: PpnSigner;
}): Promise<{
  signature: string;
  prepare: PpnPrepareResponse;
  confirm: PpnConfirmResponse;
}> {
  const owner = requireWallet(args.wallet);
  const bundleUuid = await resolveBundleUuidForPpn(args.bundleId).catch(() => args.bundleId);

  const prepare = await postJson<PpnPrepareResponse>("/api/ppn/onchain/prepare", {
    bundle_id: bundleUuid,
    wallet_address: owner,
    amount_usdc: args.amountUsdc,
    maturity_days: args.maturityDays ?? 30,
    ...(args.tranche
      ? {
          tranche_kind: args.tranche.kind,
          tranche_attach: args.tranche.attach,
          tranche_detach: args.tranche.detach,
          price_per_token: args.tranche.pricePerToken,
        }
      : {}),
  });

  const signature = await signPrepared(
    args.wallet,
    prepare,
    args.signNote,
    "Backend did not return a signable on-chain deposit target.",
  );

  const confirm = await postJson<PpnConfirmResponse>("/api/ppn/onchain/confirm", {
    vault_id: prepare.vault_id,
    wallet_address: owner,
    signature,
    // Pass the bundle + amount so the ledger record never depends solely on
    // the backend vault lookup (lets the buy show in Portfolio → History).
    bundle_id: bundleUuid,
    amount_usdc: args.amountUsdc,
  });
  return { signature, prepare, confirm };
}

export async function ppnRedeem(args: {
  wallet: WalletSigner;
  vaultId?: string;
  bundleId?: string;
  trancheKind?: "senior" | "mezzanine" | "junior";
  confirmationTimeoutMs?: number;
  signNote?: PpnSigner;
}): Promise<{
  signature: string;
  prepare: PpnRedeemPrepareResponse;
  confirm: PpnRedeemConfirmResponse;
}> {
  const owner = requireWallet(args.wallet);

  const prepare = await postJson<PpnRedeemPrepareResponse>("/api/ppn/onchain/redeem/prepare", {
    wallet_address: owner,
    ...(args.bundleId ? { bundle_id: args.bundleId } : {}),
    ...(args.vaultId ? { vault_id: args.vaultId } : {}),
    ...(args.trancheKind ? { tranche_kind: args.trancheKind } : {}),
  });

  const signature = await signPrepared(
    args.wallet,
    prepare,
    args.signNote,
    "No redeemable on-chain position for this wallet.",
  );

  const confirm = await postJson<PpnRedeemConfirmResponse>("/api/ppn/onchain/redeem/confirm", {
    vault_id: prepare.vault_id ?? args.vaultId,
    wallet_address: owner,
    signature,
    // Bundle fallback so the sell records even if the vault lookup misses.
    bundle_id: args.bundleId ?? prepare.bundle_id ?? undefined,
  });
  return { signature, prepare, confirm };
}

export async function ppnDivest(args: {
  wallet: WalletSigner;
  vaultId: string;
  confirmationTimeoutMs?: number;
  signNote?: PpnSigner;
}): Promise<{
  signature: string;
  prepare: PpnDivestPrepareResponse;
  confirm: PpnDivestConfirmResponse;
}> {
  const redeemed = await ppnRedeem({
    wallet: args.wallet,
    vaultId: args.vaultId,
    signNote: args.signNote,
  });
  return {
    signature: redeemed.signature,
    prepare: {
      kind: "prepared",
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id ?? "",
      wallet_address: redeemed.prepare.wallet_address ?? "",
      strategy_fee_bps: 5,
      estimated_strategy_fee_usdc: 0,
      position_id: redeemed.prepare.position_id ?? "",
      tx_hash: redeemed.signature,
    },
    confirm: {
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id ?? "",
      wallet_address: redeemed.prepare.wallet_address ?? "",
      signature: redeemed.signature,
      status: "active",
    },
  };
}

export async function ppnCloseEarly(args: {
  wallet: WalletSigner;
  vaultId: string;
  minProceedsUsdc?: number;
  confirmationTimeoutMs?: number;
  signNote?: PpnSigner;
}): Promise<{
  signature: string;
  prepare: PpnClosePrepareResponse;
  confirm: PpnCloseConfirmResponse;
}> {
  const redeemed = await ppnRedeem({
    wallet: args.wallet,
    vaultId: args.vaultId,
    signNote: args.signNote,
  });
  return {
    signature: redeemed.signature,
    prepare: {
      kind: "prepared",
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id ?? "",
      wallet_address: redeemed.prepare.wallet_address ?? "",
      principal_usdc: 0,
      strategy_fee_bps: 5,
      estimated_strategy_fee_usdc: 0,
      estimated_net_usdc: 0,
      position_id: redeemed.prepare.position_id ?? "",
      tx_hash: redeemed.signature,
    },
    confirm: {
      vault_id: args.vaultId,
      bundle_id: redeemed.prepare.bundle_id ?? "",
      wallet_address: redeemed.prepare.wallet_address ?? "",
      principal_returned: 0,
      signature: redeemed.signature,
      transaction_id: redeemed.signature,
      status: "withdrawn",
    },
  };
}
