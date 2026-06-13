/**
 * Cumulant on-chain adapter (Circle Arc / EVM) — reads + resolves product state
 * from the deployed contracts (PredictionMarket, BasketVault, TrancheVault,
 * ProtectedNote) and verifies client-signed transactions.
 *
 * Contract:
 * - There are NO backend-built transactions for user actions. Users custody their
 *   own USDC and sign every deposit/redeem CLIENT-SIDE. The only server-owned key
 *   is the resolver (left to its own route).
 * - A "prepare" call is therefore a thin resolver: it maps a synthetic bundle id
 *   to a real on-chain product id + returns the vault CONTRACT ADDRESS the client
 *   should call. It does NOT build/return tx bytes.
 * - A "confirm" call RECORDS a ledger row given a client-provided EVM tx HASH; it
 *   verifies a receipt actually landed (success) via `publicClient`.
 *
 * Everything here is defensive: any RPC failure or unconfigured contract set
 * degrades to a safe default rather than throwing through to the route, so the
 * backend keeps serving Polymarket + on-chain reads.
 */
import { formatUnits, parseUnits, type Address } from "viem";
import { publicClient } from "../chain.js";
import { config, explorerTx, explorerAddress } from "../config.js";
import { bundleIndex } from "../routes/bundles.js";
import {
  getBasket,
  getBasketCount,
  getTranche,
  getTrancheCount,
  getNote,
  getNoteCount,
} from "../contracts.js";
import { erc20Abi } from "../abi/erc20.js";

const USDC_DECIMALS = 6;

/** Cumulant fee schedule, ported verbatim. */
const VAULT_DEPOSIT_FEE_BPS = 50; // 0.50%
const VAULT_REDEEM_FEE_BPS = 30; // 0.30%
const BPS_DENOM = 10_000;

/** A normalized USDC amount: the on-chain raw value plus a human display number. */
function fromRaw(raw: bigint | string | number): number {
  try {
    return Number(formatUnits(BigInt(raw), USDC_DECIMALS));
  } catch {
    return 0;
  }
}

function toRaw(displayAmount: number): bigint {
  try {
    return parseUnits(String(displayAmount), USDC_DECIMALS);
  } catch {
    return 0n;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Configuration probes (configuration probes)
// ───────────────────────────────────────────────────────────────────────────

/** True once the four core product contracts are configured for this chain. */
export function vaultConfigured(): boolean {
  return Boolean(
    config.basketVault &&
      config.trancheVault &&
      config.protectedNote &&
      config.predictionMarket,
  );
}

/**
 * Static descriptor of the on-chain "vault" surface, analogous to Cumulant's
 * `VAULT`. On EVM the basket vault is the canonical share-issuing product.
 */
export const VAULT = {
  chain: config.chain,
  chainId: config.chainId,
  chainName: config.chainName,
  /** The canonical share-issuing vault address (basket vault). */
  vaultObjectId: (config.basketVault ?? "") as string,
  basketVault: (config.basketVault ?? "") as string,
  trancheVault: (config.trancheVault ?? "") as string,
  protectedNote: (config.protectedNote ?? "") as string,
  usdc: config.usdc as string,
  usdcDecimals: USDC_DECIMALS,
} as const;

/** Surfaces the canonical share-issuing vault address. */
export function shareType(): string {
  return VAULT.basketVault;
}

// ───────────────────────────────────────────────────────────────────────────
// Bundle id -> on-chain product mapping (bundle id mapping)
// ───────────────────────────────────────────────────────────────────────────

/** Stable, deterministic 32-bit hash of a bundle id (FNV-1a). */
function hashBundleId(bundleId: string): number {
  let h = 0x811c9dc5;
  const s = bundleId ?? "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface OnchainObjects {
  /** The Arc vault CONTRACT ADDRESS to call. */
  vaultAddress: string;
  /** The vault share identifier (the share-issuing vault address). */
  shareType: string;
  /** The resolved on-chain basket id this bundle maps to (or null if none exist). */
  basketId: number | null;
  explorerUrl: string;
}

/**
 * Map a synthetic bundle id (e.g. "PBU-HIGH-SHORT") to a REAL on-chain basket
 * id: `hash(bundleId) % basketCount`, with `basketCount` read from the chain.
 * Returns the basket vault contract address the client should call. Defensive:
 * if no baskets exist yet (or the read fails), `basketId` is null but the vault
 * address is still returned.
 */
export async function resolveBundleToOnchain(bundleId: string): Promise<OnchainObjects> {
  let basketId: number | null = null;
  try {
    if (vaultConfigured()) {
      const count = await getBasketCount();
      if (count > 0) {
        // Deterministic 1:1 bundle→basket mapping by canonical index (baskets are
        // seeded in the same order). Fall back to the FNV hash only for an unknown id.
        const idx = bundleIndex(bundleId);
        basketId = (idx >= 0 ? idx : hashBundleId(bundleId)) % count;
      }
    }
  } catch {
    basketId = null;
  }
  const vaultAddress = VAULT.basketVault;
  return {
    vaultAddress,
    shareType: shareType(),
    basketId,
    explorerUrl: vaultAddress ? explorerAddress(vaultAddress) : "",
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Vault state (vault state) — derived from on-chain basket reads
// ───────────────────────────────────────────────────────────────────────────

export interface VaultState {
  total_assets_raw: string;
  total_shares: string;
  accrued_fees_raw: string;
  deposit_fee_bps: number;
  redeem_fee_bps: number;
  /** assets / shares, in display units (1.0 when empty). */
  share_price: number;
}

const EMPTY_STATE: VaultState = {
  total_assets_raw: "0",
  total_shares: "0",
  accrued_fees_raw: "0",
  deposit_fee_bps: VAULT_DEPOSIT_FEE_BPS,
  redeem_fee_bps: VAULT_REDEEM_FEE_BPS,
  share_price: 1,
};

/**
 * Read live vault accounting by aggregating on-chain basket state.
 *
 * The basket vault holds many baskets, so we aggregate `totalShares` (issued shares) and the deposited
 * principal across all baskets to derive a portfolio-level share price. Unsettled
 * baskets are valued at their issued shares (price 1.0); settled baskets surface
 * their `recovered` payout as assets so the price reflects realized P&L.
 */
export async function readVaultState(): Promise<VaultState> {
  if (!vaultConfigured()) return { ...EMPTY_STATE };
  try {
    const count = await getBasketCount();
    if (count === 0) return { ...EMPTY_STATE };

    const baskets = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        getBasket(i).catch(() => null),
      ),
    );

    let totalShares = 0n;
    let totalAssets = 0n;
    for (const b of baskets) {
      if (!b) continue;
      const shares = safeBig(b.totalShares.raw);
      const recovered = safeBig(b.markToWin?.raw) || safeBig(b.recovered.raw);
      totalShares += shares;
      // Active basket: assets == issued shares (NAV 1.0 until settlement marks it).
      // Settled basket: assets == recovered payout.
      totalAssets += b.settled ? safeBig(b.recovered.raw) : recovered > 0n ? recovered : shares;
    }

    const sharePrice =
      totalShares === 0n ? 1 : fromRaw(totalAssets) / fromRaw(totalShares);

    return {
      total_assets_raw: totalAssets.toString(),
      total_shares: totalShares.toString(),
      accrued_fees_raw: "0",
      deposit_fee_bps: VAULT_DEPOSIT_FEE_BPS,
      redeem_fee_bps: VAULT_REDEEM_FEE_BPS,
      share_price: Number.isFinite(sharePrice) && sharePrice > 0 ? sharePrice : 1,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function safeBig(v: string | undefined): bigint {
  try {
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Product state (from on-chain reads)
// ───────────────────────────────────────────────────────────────────────────

export type ProductState = {
  issuePriceBps: number;
  feeBps: number;
  state: "active" | "finalized" | "closed";
  /** The basket-vault CONTRACT ADDRESS backing this product. */
  contractAddress: string;
  vaultAddress: string;
  basketId: number | null;
  explorerUrl: string;
  share_price: number;
  total_assets_usdc: number;
  total_shares: number;
};

/**
 * Cumulant `getProductState(bundleId)` — on Arc, derive product state from the
 * resolved on-chain basket. If the bundle maps to a real basket we report that
 * basket's settled flag; otherwise we fall back to the aggregate vault state.
 */
export async function getProductState(bundleId: string): Promise<ProductState | null> {
  if (!vaultConfigured()) return null;
  try {
    const objects = await resolveBundleToOnchain(bundleId);
    const state = await readVaultState();

    let lifecycle: ProductState["state"] = "active";
    if (objects.basketId !== null) {
      const basket = await getBasket(objects.basketId).catch(() => null);
      if (basket?.settled) lifecycle = "finalized";
    }

    return {
      issuePriceBps: Math.round(state.share_price * 10_000),
      feeBps: state.deposit_fee_bps,
      state: lifecycle,
      contractAddress: VAULT.basketVault,
      vaultAddress: objects.vaultAddress,
      basketId: objects.basketId,
      explorerUrl: objects.explorerUrl,
      share_price: state.share_price,
      total_assets_usdc: fromRaw(state.total_assets_raw),
      total_shares: fromRaw(state.total_shares),
    };
  } catch {
    return null;
  }
}

/**
 * Issue price for a bundle (replaces `getVaultPrice` indirection). Derives from
 * the on-chain NAV; defaults to 1.0 when the vault is empty or unconfigured.
 */
export async function getVaultPrice(bundleId: string): Promise<{
  bundle_id: string;
  vault_id: string;
  issue_price: number;
  fee_bps: number;
  redeem_fee_bps: number;
  total_assets_usdc: number;
  total_shares: number;
  vault_state: "active";
} | null> {
  try {
    const state = await readVaultState();
    void bundleId;
    return {
      bundle_id: bundleId,
      vault_id: VAULT.basketVault,
      issue_price: state.share_price,
      fee_bps: state.deposit_fee_bps,
      redeem_fee_bps: state.redeem_fee_bps,
      total_assets_usdc: fromRaw(state.total_assets_raw),
      total_shares: fromRaw(state.total_shares),
      vault_state: "active",
    };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Deposit / redeem economics (kept identical to Cumulant)
// ───────────────────────────────────────────────────────────────────────────

export interface DepositEconomics {
  gross_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  expected_shares: number;
  share_price: number;
  deposit_fee_bps: number;
}

/** Compute deposit economics against the live share price. */
export function computeDeposit(grossUsdc: number, state: VaultState): DepositEconomics {
  const grossRaw = toRaw(grossUsdc);
  const feeRaw = (grossRaw * BigInt(state.deposit_fee_bps)) / BigInt(BPS_DENOM);
  const netRaw = grossRaw - feeRaw;
  const totalShares = safeBig(state.total_shares);
  const assets = safeBig(state.total_assets_raw);
  const sharesRaw =
    totalShares === 0n || assets === 0n ? netRaw : (netRaw * totalShares) / assets;
  return {
    gross_usdc: fromRaw(grossRaw),
    fee_usdc: fromRaw(feeRaw),
    net_usdc: fromRaw(netRaw),
    expected_shares: fromRaw(sharesRaw),
    share_price: state.share_price,
    deposit_fee_bps: state.deposit_fee_bps,
  };
}

/** Lightweight estimate used by quote routes (Cumulant `estimateDeposit`). */
export function estimateDeposit(amountUsdc: number, issuePrice: number) {
  const feeUsdc = amountUsdc * (VAULT_DEPOSIT_FEE_BPS / BPS_DENOM);
  const netUsdc = amountUsdc - feeUsdc;
  const expectedTokens = issuePrice > 0 ? netUsdc / issuePrice : netUsdc;
  return { feeUsdc, netUsdc, expectedTokens };
}

/** Lightweight estimate used by quote routes (Cumulant `estimateRedeem`). */
export function estimateRedeem(tokens: number, issuePrice: number, active: boolean) {
  const grossUsdc = tokens * issuePrice;
  const exitFeeUsdc = active ? grossUsdc * (VAULT_REDEEM_FEE_BPS / BPS_DENOM) : 0;
  return {
    expectedUsdc: grossUsdc - exitFeeUsdc,
    exitFeeUsdc,
    redeemKind: active ? ("active_early" as const) : ("finalized" as const),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Prepare flows (thin resolvers — NO tx bytes; client signs on Arc)
// ───────────────────────────────────────────────────────────────────────────

export interface PreparedDeposit {
  /** Marker mirroring Cumulant `kind: 'prepared'`. */
  kind: "prepared";
  /** EVM vault contract the client should call (BasketVault.deposit). */
  vault_address: string;
  vault_id: string;
  basket_id: number | null;
  /** USDC token to approve before depositing. */
  usdc_address: string;
  usdc_decimals: number;
  /** The vault share identifier minted by this deposit. */
  share_type: string;
  economics: DepositEconomics;
}

/**
 * Resolve everything the client needs to build + sign a deposit itself. There is
 * no server-side tx construction on Arc — we return the basket id, the vault
 * address, the USDC token to approve, and the deposit economics.
 */
export async function prepareDeposit(args: {
  owner: string;
  amount_usdc: number;
  label?: string;
}): Promise<PreparedDeposit> {
  if (!vaultConfigured()) {
    throw new Error(
      "Cumulant contracts not configured (set BASKET_VAULT_ADDRESS et al).",
    );
  }
  if (!(args.amount_usdc > 0)) throw new Error("amount_usdc must be positive");

  const objects = await resolveBundleToOnchain(args.label ?? "");
  const state = await readVaultState();
  const economics = computeDeposit(args.amount_usdc, state);

  return {
    kind: "prepared",
    vault_address: objects.vaultAddress,
    vault_id: objects.vaultAddress,
    basket_id: objects.basketId,
    usdc_address: VAULT.usdc,
    usdc_decimals: USDC_DECIMALS,
    share_type: objects.shareType,
    economics,
  };
}

export interface PreparedRedeem {
  kind: "prepared";
  vault_address: string;
  vault_id: string;
  basket_id: number | null;
  share_id: string;
  economics: {
    shares: number;
    gross_usdc: number;
    fee_usdc: number;
    net_usdc: number;
    redeem_fee_bps: number;
  };
}

/**
 * Resolve everything the client needs to build + sign a redeem. We read the
 * caller's on-chain share balance for the resolved basket and quote the exit
 * economics; the client calls BasketVault.redeem with its own signature.
 */
export async function prepareRedeem(args: {
  owner: string;
  share_id?: string;
  label?: string;
}): Promise<PreparedRedeem> {
  if (!vaultConfigured()) {
    throw new Error(
      "Cumulant contracts not configured (set BASKET_VAULT_ADDRESS et al).",
    );
  }

  const objects = await resolveBundleToOnchain(args.label ?? "");
  const state = await readVaultState();

  // Best-effort: read the caller's share balance for this basket.
  let shares = 0;
  if (objects.basketId !== null) {
    const owned = await sharesOfBasket(objects.basketId, args.owner).catch(() => 0);
    shares = owned;
  }
  if (shares <= 0) {
    throw new Error(`No vault positions for ${args.owner}`);
  }

  const grossUsdc = shares * state.share_price;
  const feeUsdc = grossUsdc * (state.redeem_fee_bps / BPS_DENOM);
  const netUsdc = grossUsdc - feeUsdc;

  return {
    kind: "prepared",
    vault_address: objects.vaultAddress,
    vault_id: objects.vaultAddress,
    basket_id: objects.basketId,
    share_id: args.share_id ?? String(objects.basketId ?? ""),
    economics: {
      shares,
      gross_usdc: grossUsdc,
      fee_usdc: feeUsdc,
      net_usdc: netUsdc,
      redeem_fee_bps: state.redeem_fee_bps,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Positions (replaces listShares) — read on-chain holdings
// ───────────────────────────────────────────────────────────────────────────

export interface VaultShareInfo {
  share_id: string;
  shares: number;
  principal_usdc: number;
  label: string;
}

/** Read a single basket's share balance for an owner (display units). */
async function sharesOfBasket(basketId: number, owner: string): Promise<number> {
  if (!config.basketVault) return 0;
  try {
    const { basketVaultAbi } = await import("../abi/BasketVault.js");
    const raw = (await publicClient.readContract({
      address: config.basketVault,
      abi: basketVaultAbi,
      functionName: "sharesOf",
      args: [BigInt(basketId), owner as Address],
    })) as bigint;
    return fromRaw(raw);
  } catch {
    return 0;
  }
}

/**
 * List a wallet's on-chain basket positions (EVM analogue of Arc's
 * `listShares`). Each basket the wallet holds shares in becomes one entry.
 */
export async function listShares(owner: string): Promise<VaultShareInfo[]> {
  if (!vaultConfigured()) return [];
  try {
    const count = await getBasketCount();
    const entries = await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const shares = await sharesOfBasket(i, owner);
        if (shares <= 0) return null;
        const basket = await getBasket(i).catch(() => null);
        return {
          share_id: `${config.basketVault}:${i}`,
          shares,
          // The contracts don't track per-depositor principal separately from
          // shares, so principal == shares deposited (NAV-1.0 entry basis).
          principal_usdc: shares,
          label: basket?.name ?? `basket-${i}`,
        } as VaultShareInfo;
      }),
    );
    return entries.filter((e): e is VaultShareInfo => e !== null);
  } catch {
    return [];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tx-hash confirmation
// ───────────────────────────────────────────────────────────────────────────

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export interface TxConfirmation {
  ok: boolean;
  status: string;
  /** EVM tx hash that was verified. */
  hash: string;
  explorer_url: string;
  event?: Record<string, unknown>;
  usdc_delta?: number;
  block_number?: number;
}

/**
 * Verify an EVM tx hash actually landed on-chain with success. Optionally
 * computes the owner's USDC delta from the receipt's ERC-20 Transfer logs so a
 * redeem can surface the realized payout.
 */
export async function confirmTxHash(
  hash: string,
  owner?: string,
): Promise<TxConfirmation> {
  const trimmed = (hash ?? "").trim();
  const fail = (status: string): TxConfirmation => ({
    ok: false,
    status,
    hash: trimmed,
    explorer_url: explorerTx(trimmed),
    event: undefined,
  });
  if (!TX_HASH_RE.test(trimmed)) return fail("invalid_hash");

  try {
    const receipt = await publicClient.getTransactionReceipt({
      hash: trimmed as `0x${string}`,
    });
    const ok = receipt.status === "success";
    let delta: number | undefined;
    if (owner) {
      delta = usdcDeltaFromReceipt(receipt, owner);
    }
    return {
      ok,
      status: receipt.status,
      hash: trimmed,
      explorer_url: explorerTx(trimmed),
      block_number: Number(receipt.blockNumber),
      usdc_delta: delta,
      // Owner-binding: in this non-custodial EOA flow the tx sender IS the wallet
      // that signed the deposit/redeem, so surfacing it lets the confirm routes
      // reject a real hash claimed by a different wallet (previously always undefined,
      // which made ownerMismatch() inert and the confirm path fail-open).
      event: receipt.from ? { owner: receipt.from } : undefined,
    };
  } catch {
    // Receipt not yet indexed / not found.
    return fail("not_found");
  }
}

/** EVM tx-hash confirmation reduced to a boolean. */
export async function confirmReceipt(hashValue: string): Promise<boolean> {
  const c = await confirmTxHash(hashValue);
  return c.ok;
}

/** Real USDC delta credited to `owner` by a confirmed tx hash (e.g. a redeem). */
export async function getUserUsdcDeltaFromHash(
  hashValue?: string,
  owner?: string,
): Promise<number | null> {
  if (!hashValue) return null;
  const c = await confirmTxHash(hashValue, owner);
  return c.usdc_delta ?? null;
}

/** Cumulant-name alias. */
export const getUserUsdcDeltaByHash = getUserUsdcDeltaFromHash;

const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Sum the USDC ERC-20 Transfer deltas crediting/debiting `owner` in a receipt. */
function usdcDeltaFromReceipt(
  receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] },
  owner: string,
): number | undefined {
  const usdcAddr = (config.usdc ?? "").toLowerCase();
  const ownerTopic = owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  let net = 0n;
  let matched = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddr) continue;
    if (!log.topics || log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    const from = (log.topics[1] ?? "").toLowerCase().slice(-64);
    const to = (log.topics[2] ?? "").toLowerCase().slice(-64);
    let value = 0n;
    try {
      value = BigInt(log.data);
    } catch {
      value = 0n;
    }
    if (to === ownerTopic) {
      net += value;
      matched = true;
    }
    if (from === ownerTopic) {
      net -= value;
      matched = true;
    }
  }
  return matched ? fromRaw(net) : undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Off-chain bundle mirror (off-chain mirror) — Supabase optional
// ───────────────────────────────────────────────────────────────────────────

/**
 * Initialize the on-chain product reference for a bundle. On Arc there is no
 * per-bundle deploy — the basket vault already exists — so this resolves the
 * real on-chain references rather than fabricating ids. Supabase mirroring (leg
 * ordering) is best-effort and a safe no-op when Supabase is unconfigured.
 */
export async function initializeOnchainVaultForBundle(bundleId: string): Promise<{
  vaultAddress: string;
  basketId: number | null;
  shareType: string;
  note: string;
} | null> {
  try {
    const objects = await resolveBundleToOnchain(bundleId);
    // Best-effort Supabase leg ordering, if the db layer is present + configured.
    try {
      const { getLegsByBundleId } = await import("../db/queries.js");
      const { supabase } = await import("../db/supabase.js");
      if (supabase) {
        const legs = await getLegsByBundleId(bundleId);
        const sorted = [...legs].sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        await Promise.all(
          sorted.map((leg, idx) =>
            supabase.from("legs").update({ leg_index: idx }).eq("id", leg.id),
          ),
        );
      }
    } catch {
      /* db optional */
    }
    return {
      vaultAddress: objects.vaultAddress,
      basketId: objects.basketId,
      shareType: objects.shareType,
      note: "Bundle is backed by the shared on-chain Cumulant basket vault; deposits mint real vault shares.",
    };
  } catch {
    return null;
  }
}

/**
 * Mirror a leg's resolution in the DB. There is no per-bundle on-chain market to
 * settle here (the resolver route handles market settlement), so this returns
 * null (no extra on-chain tx) — matching Cumulant. Safe no-op without Supabase.
 */
export async function resolveLegOnchainMirror(
  _bundleId: string,
  legId: string,
  outcome: "won" | "lost",
): Promise<string | null> {
  try {
    const { supabase } = await import("../db/supabase.js");
    if (supabase) {
      await supabase
        .from("legs")
        .update({ onchain_resolved_at: new Date().toISOString() })
        .eq("id", legId);
    }
  } catch {
    /* db optional */
  }
  void outcome;
  return null;
}

/** Finalize a bundle in the DB once all its legs are resolved. Safe no-op without Supabase. */
export async function finalizeBundleIfReady(bundleId: string): Promise<string | null> {
  try {
    const { getLegsByBundleId, updateBundleStatus } = await import(
      "../db/queries.js"
    );
    const legs = await getLegsByBundleId(bundleId);
    if (legs.length === 0) return null;
    if (legs.some((l) => l.status !== "won" && l.status !== "lost")) return null;

    const { supabase } = await import("../db/supabase.js");
    if (supabase) {
      await supabase
        .from("bundles")
        .update({
          onchain_finalized_at: new Date().toISOString(),
          status: "resolved",
        })
        .eq("id", bundleId);
      await updateBundleStatus(bundleId, "resolved");
    }
  } catch {
    /* db optional */
  }
  // No on-chain finalize tx in the shared-vault model.
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Admin fee withdrawal — capability differs on Arc (no fabricated tx)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Admin fee withdrawal. The deployed Cumulant vaults don't expose a protocol
 * fee-withdrawal entrypoint (fees are folded into NAV), so there is no server tx
 * to sign here. We return null rather than fabricate a hash — the honest EVM
 * analogue of Cumulant's vault fee sweep.
 */
export async function adminWithdrawFees(_bundleId?: string): Promise<string | null> {
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Yield sleeve — surfaced from the live vault NAV (from the live vault NAV)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The "yield sleeve" backing protected notes is represented by the live vault:
 * its share price grows as P&L accrues. We surface the real vault address + an
 * indicative APY config (no on-chain init tx needed on Arc).
 */
export async function initializeYieldSleeve(apyBps: number): Promise<{
  initialized: boolean;
  signature: string | null;
  sleeve: { apy_bps: number; vault_address: string; share_price: number };
}> {
  const state = vaultConfigured() ? await readVaultState() : null;
  return {
    initialized: vaultConfigured(),
    signature: null,
    sleeve: {
      apy_bps: apyBps,
      vault_address: VAULT.basketVault,
      share_price: state?.share_price ?? 1,
    },
  };
}

export async function getYieldSleeveState(): Promise<{
  apy_bps: number;
  vault_address: string;
  share_price: number;
  total_assets_usdc: number;
  accrued_fees_usdc: number;
}> {
  const state = await readVaultState();
  return {
    apy_bps: 800,
    vault_address: VAULT.basketVault,
    share_price: state.share_price,
    total_assets_usdc: fromRaw(state.total_assets_raw),
    accrued_fees_usdc: fromRaw(state.accrued_fees_raw),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Aggregate protocol state — convenience read across all product families
// ───────────────────────────────────────────────────────────────────────────

/**
 * Aggregate TVL/issued across baskets, tranches and notes. Used by status/admin
 * surfaces; fully defensive so a single failing read can't break the call.
 */
export async function getProtocolState(): Promise<{
  configured: boolean;
  chain: string;
  vault_address: string;
  share_price: number;
  baskets: number;
  tranches: number;
  notes: number;
  total_assets_usdc: number;
  total_shares: number;
}> {
  if (!vaultConfigured()) {
    return {
      configured: false,
      chain: config.chainName,
      vault_address: "",
      share_price: 1,
      baskets: 0,
      tranches: 0,
      notes: 0,
      total_assets_usdc: 0,
      total_shares: 0,
    };
  }
  const [state, baskets, tranches, notes] = await Promise.all([
    readVaultState(),
    getBasketCount().catch(() => 0),
    getTrancheCount().catch(() => 0),
    getNoteCount().catch(() => 0),
  ]);
  return {
    configured: true,
    chain: config.chainName,
    vault_address: VAULT.basketVault,
    share_price: state.share_price,
    baskets,
    tranches,
    notes,
    total_assets_usdc: fromRaw(state.total_assets_raw),
    total_shares: fromRaw(state.total_shares),
  };
}

// Keep the other product readers re-exported so a single import surface mirrors
// what Cumulant routes reached for (tranche/note state derive product economics).
export { getTranche, getTrancheCount, getNote, getNoteCount };
