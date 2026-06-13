"use client";

/**
 * Cumulant basket deposit client (Circle Arc / EVM).
 *
 * Flow:
 *   1) POST `/api/deposit/prepare` resolves the on-chain basketId + vault
 *      address (plus the fee / NAV / tokens math),
 *   2) the action is signed CLIENT-SIDE via `useCumulant().depositBasket(...)`
 *      (`@/lib/tx`), which approves USDC then writes the vault deposit and
 *      returns an EVM tx hash,
 *   3) POST `/api/deposit/confirm` with `{ ..., signature: <txHash> }` records
 *      the ledger row (History).
 *
 * `useCumulant()` is a React hook, so it can't be called from these plain async
 * helpers — the page passes the resolved `cumulant` action surface + on-chain
 * `config` in via the `cumulant` / `config` args.
 */

import { parseUnits, type Address } from "viem";
import type { ChainConfig } from "@/lib/api";
import type { useCumulant } from "@/lib/tx";
import { BACKEND_URL } from "./tokens";
import { unwrap } from "./http";
import type { WalletSigner } from "./wallet-bridge";

export type { WalletSigner };

/** The client-side signer surface (subset of `useCumulant()`) used for basket flows. */
export type CumulantActions = Pick<ReturnType<typeof useCumulant>, "depositBasket" | "redeemBasket">;

function normalizeName(name: string): string {
  return name;
}

type BundleSummary = {
  id: string;
  name: string;
};

let _bundleMap: Promise<Map<string, BundleSummary>> | null = null;

function loadBundleMap(force: boolean = false): Promise<Map<string, BundleSummary>> {
  if (force) _bundleMap = null;
  if (_bundleMap) return _bundleMap;
  _bundleMap = (async () => {
    const res = await fetch(`${BACKEND_URL}/api/bundles`);
    if (!res.ok) {
      _bundleMap = null;
      throw new DepositError(`Failed to load /api/bundles (HTTP ${res.status})`, res.status);
    }
    const rows = unwrap(await res.json()) as BundleSummary[];
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

export async function resolveBundleUuid(uiBundleId: string): Promise<string> {
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
        `[deposit-client] Basket "${uiBundleId}" not in backend; routing to "${fallback.name}" (${fallback.id}).`,
      );
    }
    return fallback.id;
  }

  throw new DepositError(
    `Bundle "${dbName}" not found. Known bundles: ${Array.from(map.keys()).join(", ") || "(none)"}`,
    404,
  );
}

export interface DepositPrepareResponse {
  kind: "prepared";
  bundle_id: string;
  wallet_address: string;
  amount_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  issue_price: number;
  tokens_minted: number;
  expected_tokens: number;
  /** On-chain basket id to deposit into (resolves the synthetic UI id). */
  onchain_basket_id?: number;
  /** On-chain basket id (EVM backend field name). */
  basket_id?: number;
  /** BasketVault contract address to deposit into. */
  vault?: string;
  vault_address?: string;
  /** The vault share identifier minted by this deposit. */
  share_type?: string;
  position_id?: string;
  tx_hash?: string;
  /** base64 transaction bytes for the wallet to sign (legacy non-custodial flow). */
  prepared_tx?: string;
  sender?: string;
  dry_run?: { ok: boolean; status: string; gas_used?: string; error?: string };
}

export interface DepositConfirmResponse {
  transaction_id: string;
  bundle_id: string;
  tokens_minted: number;
  issue_price: number;
  fee_usdc: number;
  net_usdc: number;
}

export interface RedeemPrepareResponse {
  kind: "prepared";
  bundle_id: string;
  wallet_address: string;
  total_tokens: number;
  expected_usdc: number;
  redeem_kind?: "finalized" | "active_early";
  exit_fee_usdc?: number;
  /** On-chain basket id to redeem from. */
  onchain_basket_id?: number;
  /** On-chain basket id (EVM backend field name). */
  basket_id?: number;
  /** BasketVault contract address to redeem from. */
  vault?: string;
  vault_address?: string;
  /** Share amount (vault tokens, 6dp) the wallet holds and can redeem. */
  shares?: number;
  position_id?: string;
  share_id?: string;
  tx_hash?: string;
  prepared_tx?: string;
  sender?: string;
  dry_run?: { ok: boolean; status: string; gas_used?: string; error?: string };
}

export interface RedeemConfirmResponse {
  wallet_address?: string;
  bundle_id?: string;
  total_tokens?: number;
  payout_usdc?: number | null;
  transaction_id?: string | null;
  confirmed?: boolean;
}

export class DepositError extends Error {
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
    throw new DepositError(msg, res.status, payload);
  }
  return unwrap<T>(payload);
}

export async function prepareDeposit(args: {
  bundleId: string;
  walletAddress: string;
  amountUsdc: number;
}): Promise<DepositPrepareResponse> {
  const uuid = await resolveBundleUuid(args.bundleId);
  return postJson<DepositPrepareResponse>("/api/deposit/prepare", {
    bundle_id: uuid,
    wallet_address: args.walletAddress,
    amount_usdc: args.amountUsdc,
  });
}

export async function confirmDeposit(args: {
  bundleId: string;
  walletAddress: string;
  amountUsdc: number;
  signature: string;
  tokensMinted: number;
  issuePrice: number;
  feeUsdc: number;
}): Promise<DepositConfirmResponse> {
  const uuid = await resolveBundleUuid(args.bundleId);
  return postJson<DepositConfirmResponse>("/api/deposit/confirm", {
    bundle_id: uuid,
    wallet_address: args.walletAddress,
    amount_usdc: args.amountUsdc,
    signature: args.signature,
    tokens_minted: args.tokensMinted,
    issue_price: args.issuePrice,
    fee_usdc: args.feeUsdc,
  });
}

export async function prepareRedeem(args: {
  bundleId: string;
  walletAddress: string;
  amountTokens?: number;
}): Promise<RedeemPrepareResponse> {
  const uuid = await resolveBundleUuid(args.bundleId);
  return postJson<RedeemPrepareResponse>("/api/deposit/redeem/prepare", {
    bundle_id: uuid,
    wallet_address: args.walletAddress,
    ...(args.amountTokens != null ? { amount_tokens: args.amountTokens } : {}),
  });
}

export async function confirmRedeem(args: {
  bundleId: string;
  walletAddress: string;
  signature: string;
  expectedUsdc: number;
  tokensRedeemed?: number;
}): Promise<RedeemConfirmResponse> {
  const uuid = await resolveBundleUuid(args.bundleId);
  return postJson<RedeemConfirmResponse>("/api/deposit/redeem/confirm", {
    bundle_id: uuid,
    wallet_address: args.walletAddress,
    signature: args.signature,
    expected_usdc: args.expectedUsdc,
    ...(args.tokensRedeemed != null ? { tokens_redeemed: args.tokensRedeemed } : {}),
  });
}

function requireWallet(wallet: WalletSigner): string {
  if (!wallet.connected || !wallet.address) {
    throw new DepositError("Connect an Arc wallet to continue.", 0);
  }
  return wallet.address;
}

/**
 * Resolve the on-chain basket id from a prepare response. Falls back to the
 * EVM backend's `basket_id` field when the synthetic `onchain_basket_id` is
 * absent.
 */
function resolveBasketId(prepare: { onchain_basket_id?: number; basket_id?: number }): number {
  if (typeof prepare.onchain_basket_id === "number" && Number.isFinite(prepare.onchain_basket_id)) {
    return prepare.onchain_basket_id;
  }
  if (typeof prepare.basket_id === "number" && Number.isFinite(prepare.basket_id)) {
    return prepare.basket_id;
  }
  throw new DepositError("Backend did not return an on-chain basket id.", 0, prepare);
}

/** Resolve the BasketVault address: prepare-supplied, then on-chain config. */
function resolveVault(
  prepare: { vault?: string; vault_address?: string },
  config?: ChainConfig | null,
): Address {
  const addr = prepare.vault ?? prepare.vault_address ?? config?.basketVault ?? null;
  if (!addr) {
    throw new DepositError("No BasketVault address available for this deposit.", 0, prepare);
  }
  return addr as Address;
}

/**
 * Non-custodial deposit (Arc / EVM): `/prepare` resolves the on-chain basketId
 * + vault, the user's wallet signs `depositBasket` (approve → deposit) via
 * `useCumulant()`, then `/confirm` verifies + persists. The server never signs
 * or holds funds.
 *
 * Signature is preserved from the flow. The page passes the
 * `useCumulant()` action surface (`cumulant`) + on-chain `config` so signing
 * happens client-side; if omitted we fall back to the legacy
 * `wallet.signPreparedTx(prepared_tx)` path.
 */
export async function depositIntoBundle(args: {
  wallet: WalletSigner;
  bundleId: string;
  amountUsdc: number;
  navAtDeposit?: number;
  confirmationTimeoutMs?: number;
  onStage?: (stage: "preparing" | "signing" | "confirming" | "persisting") => void;
  /** Client-side signer (from `useCumulant()`); enables the on-chain Arc flow. */
  cumulant?: CumulantActions;
  /** On-chain config (from `useConfig()`) — supplies USDC + fallback vault address. */
  config?: ChainConfig | null;
}): Promise<{
  signature: string;
  prepare: DepositPrepareResponse;
  confirm: DepositConfirmResponse;
}> {
  const { wallet, bundleId, amountUsdc, cumulant, config } = args;
  const owner = requireWallet(wallet);

  args.onStage?.("preparing");
  const prepare = await prepareDeposit({ bundleId, walletAddress: owner, amountUsdc });

  args.onStage?.("signing");
  let signature: string;
  if (cumulant) {
    // Arc path: approve USDC → deposit into the BasketVault, returns the tx hash.
    const usdc = config?.usdc;
    if (!usdc) {
      throw new DepositError("USDC address unavailable from chain config.", 0, prepare);
    }
    const vault = resolveVault(prepare, config);
    const basketId = resolveBasketId(prepare);
    const amount = parseUnits(String(amountUsdc), 6);
    signature = await cumulant.depositBasket(vault, usdc, basketId, amount);
  } else {
    // Legacy fallback: backend-built tx bytes (throws on Arc by design).
    if (!prepare.prepared_tx) {
      throw new DepositError("Backend did not return a signable transaction.", 0, prepare);
    }
    signature = await wallet.signPreparedTx(prepare.prepared_tx);
  }

  args.onStage?.("confirming");
  const confirm = await confirmDeposit({
    bundleId,
    walletAddress: owner,
    amountUsdc,
    signature,
    tokensMinted: prepare.tokens_minted,
    issuePrice: prepare.issue_price,
    feeUsdc: prepare.fee_usdc,
  });

  args.onStage?.("persisting");
  try {
    const { recordVirtualPosition } = await import("./virtual-positions");
    const vaultRef = prepare.vault_address ?? prepare.vault ?? "";
    recordVirtualPosition({
      wallet: owner,
      uuid: vaultRef || signature,
      uiBundleId: bundleId,
      tokens: prepare.tokens_minted,
      depositedUsdc: amountUsdc,
      navAtDeposit: args.navAtDeposit ?? prepare.issue_price ?? 1,
      signature,
      createdAt: Date.now(),
      chain: "arc",
      marketId: vaultRef,
      positionId: prepare.position_id ?? "",
    });
  } catch {
    // Browser-local position recording is only for UI continuity.
  }

  return { signature, prepare, confirm };
}

/**
 * Non-custodial redeem (Arc / EVM): `/prepare` resolves the on-chain basketId +
 * vault + share amount, the wallet signs `redeemBasket` via `useCumulant()`,
 * then `/confirm` verifies + persists.
 */
export async function redeemFromBundle(args: {
  wallet: WalletSigner;
  bundleId: string;
  amountTokens?: number;
  confirmationTimeoutMs?: number;
  onStage?: (stage: "preparing" | "signing" | "confirming" | "persisting") => void;
  /** Client-side signer (from `useCumulant()`); enables the on-chain Arc flow. */
  cumulant?: CumulantActions;
  /** On-chain config (from `useConfig()`) — supplies the fallback vault address. */
  config?: ChainConfig | null;
}): Promise<{
  signature: string;
  prepare: RedeemPrepareResponse;
  confirm: RedeemConfirmResponse;
}> {
  const { wallet, bundleId, cumulant, config } = args;
  const owner = requireWallet(wallet);

  args.onStage?.("preparing");
  const prepare = await prepareRedeem({ bundleId, walletAddress: owner, amountTokens: args.amountTokens });

  args.onStage?.("signing");
  let signature: string;
  if (cumulant) {
    // Arc path: redeem the wallet's vault shares, returns the tx hash.
    const vault = resolveVault(prepare, config);
    const basketId = resolveBasketId(prepare);
    const sharesUi = prepare.shares ?? args.amountTokens ?? prepare.total_tokens;
    if (sharesUi == null || !Number.isFinite(sharesUi) || sharesUi <= 0) {
      throw new DepositError("No redeemable on-chain position for this wallet.", 404, prepare);
    }
    const shares = parseUnits(String(sharesUi), 6);
    signature = await cumulant.redeemBasket(vault, basketId, shares);
  } else {
    // Legacy fallback: backend-built tx bytes (throws on Arc by design).
    if (!prepare.prepared_tx) {
      throw new DepositError("No redeemable on-chain position for this wallet.", 404, prepare);
    }
    signature = await wallet.signPreparedTx(prepare.prepared_tx);
  }

  args.onStage?.("confirming");
  const confirm = await confirmRedeem({
    bundleId,
    walletAddress: owner,
    signature,
    expectedUsdc: prepare.expected_usdc,
    tokensRedeemed: prepare.total_tokens,
  });

  args.onStage?.("persisting");
  try {
    const { clearVirtualPositionByIds } = await import("./virtual-positions");
    const vaultRef = prepare.vault_address ?? prepare.vault ?? "";
    if (vaultRef) {
      clearVirtualPositionByIds(
        owner,
        vaultRef,
        prepare.share_id ?? prepare.position_id ?? "",
      );
    }
  } catch {
    // Browser-local position recording is only for UI continuity.
  }

  return { signature, prepare, confirm };
}
