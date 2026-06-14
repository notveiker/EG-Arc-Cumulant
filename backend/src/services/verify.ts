/**
 * On-chain event verification for confirm / settlement routes.
 *
 * TRUST BOUNDARY: the backend must NEVER write a ledger/position/redemption record
 * from a client-supplied tx hash without proving the tx actually emitted the EXACT
 * expected event — right CONTRACT, right ACTION, right OWNER, right ID, and (where
 * it matters) amount/shares/payout. This closes the class of bugs where:
 *   - a successful tx by the same wallet to a DIFFERENT contract/function was
 *     accepted as a deposit/redeem/sell, and
 *   - a tx signed by a DIFFERENT wallet was claimed by someone else.
 *
 * Every helper fetches the receipt, requires `status === "success"`, decodes the
 * logs against the product's ABI, keeps only logs emitted BY the expected contract
 * address, and returns the first event whose decoded args satisfy the matcher.
 */
import { parseEventLogs, type Abi } from "viem";
import { publicClient } from "../chain.js";
import { config, explorerTx } from "../config.js";
import { basketVaultAbi } from "../abi/BasketVault.js";
import { trancheVaultAbi } from "../abi/TrancheVault.js";
import { protectedNoteAbi } from "../abi/ProtectedNote.js";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const USDC_DECIMALS = 6;

const eq = (a?: string, b?: string): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** ERC-20 Transfer event — the backend erc20 ABI ships functions only. */
const transferEventAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;

export interface EventVerification {
  ok: boolean;
  /** success | invalid_hash | not_configured | not_found | reverted | no_matching_event */
  status: string;
  hash: string;
  explorer_url: string;
  /** Decoded args of the matched event (only when ok). */
  args?: Record<string, unknown>;
}

function safeMatch(fn: (a: Record<string, unknown>) => boolean, args: Record<string, unknown>): boolean {
  try {
    return fn(args);
  } catch {
    return false;
  }
}

/**
 * Verify a tx exists + succeeded and emitted `eventName` from `address` with
 * decoded args satisfying `match`. Returns the matched event's decoded args.
 */
export async function verifyTxEvent(opts: {
  hash: string;
  address?: string;
  abi: Abi;
  eventName: string;
  match: (args: Record<string, unknown>) => boolean;
}): Promise<EventVerification> {
  const hash = (opts.hash ?? "").trim();
  const base = { hash, explorer_url: explorerTx(hash) };
  if (!TX_HASH_RE.test(hash)) return { ...base, ok: false, status: "invalid_hash" };
  if (!opts.address) return { ...base, ok: false, status: "not_configured" };

  let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
  } catch {
    return { ...base, ok: false, status: "not_found" };
  }
  if (receipt.status !== "success") return { ...base, ok: false, status: "reverted" };

  let events: Array<{ address: string; args: Record<string, unknown> }> = [];
  try {
    events = parseEventLogs({
      abi: opts.abi,
      eventName: opts.eventName as never,
      logs: receipt.logs,
    }) as unknown as Array<{ address: string; args: Record<string, unknown> }>;
  } catch {
    events = [];
  }
  const want = opts.address.toLowerCase();
  const hit = events.find(
    (e) => e.address?.toLowerCase() === want && safeMatch(opts.match, e.args ?? {}),
  );
  if (!hit) return { ...base, ok: false, status: "no_matching_event" };
  return { ...base, ok: true, status: "success", args: hit.args };
}

const num = (v: unknown): number => Number(v as bigint);
/** uint256 USDC base units (6dp) → display USDC. */
export const usdcFromRaw = (v: unknown): number => Number(v as bigint) / 10 ** USDC_DECIMALS;

// ── Basket vault ─────────────────────────────────────────────────────────────
export function confirmBasketDeposit(hash: string, owner: string, basketId: number) {
  return verifyTxEvent({
    hash, address: config.basketVault, abi: basketVaultAbi, eventName: "Deposited",
    match: (a) => eq(a.depositor as string, owner) && num(a.basketId) === basketId,
  });
}
export function confirmBasketRedeem(hash: string, owner: string, basketId: number) {
  return verifyTxEvent({
    hash, address: config.basketVault, abi: basketVaultAbi, eventName: "Redeemed",
    match: (a) => eq(a.redeemer as string, owner) && num(a.basketId) === basketId,
  });
}

// ── Protected note ─────────────────────────────────────────────────────────────
export function confirmNoteDeposit(hash: string, owner: string, noteId: number) {
  return verifyTxEvent({
    hash, address: config.protectedNote, abi: protectedNoteAbi, eventName: "Deposited",
    match: (a) => eq(a.user as string, owner) && num(a.noteId) === noteId,
  });
}
export function confirmNoteRedeem(hash: string, owner: string, noteId: number) {
  return verifyTxEvent({
    hash, address: config.protectedNote, abi: protectedNoteAbi, eventName: "Redeemed",
    match: (a) => eq(a.user as string, owner) && num(a.noteId) === noteId,
  });
}

// ── Tranche vault ──────────────────────────────────────────────────────────────
export function confirmTrancheDeposit(hash: string, owner: string, trancheId: number) {
  return verifyTxEvent({
    hash, address: config.trancheVault, abi: trancheVaultAbi, eventName: "Deposited",
    match: (a) => eq(a.user as string, owner) && num(a.trancheId) === trancheId,
  });
}
export function confirmTrancheRedeem(hash: string, owner: string, trancheId: number) {
  return verifyTxEvent({
    hash, address: config.trancheVault, abi: trancheVaultAbi, eventName: "Redeemed",
    match: (a) => eq(a.user as string, owner) && num(a.trancheId) === trancheId,
  });
}

// ── MM secondary-market sell ────────────────────────────────────────────────────
export type MmProduct = "basket" | "tranche" | "note";
/**
 * Verify a SoldToMM event for the owner on the right vault + product id. The
 * returned args include the on-chain `payout` (6dp) — callers MUST use that, not a
 * client-supplied amount, when recording the sell.
 */
export function confirmSoldToMM(hash: string, owner: string, product: MmProduct, productId: number) {
  const map = {
    basket: { address: config.basketVault, abi: basketVaultAbi as Abi, id: "basketId" },
    tranche: { address: config.trancheVault, abi: trancheVaultAbi as Abi, id: "trancheId" },
    note: { address: config.protectedNote, abi: protectedNoteAbi as Abi, id: "noteId" },
  }[product];
  return verifyTxEvent({
    hash, address: map.address, abi: map.abi, eventName: "SoldToMM",
    match: (a) => eq(a.seller as string, owner) && num(a[map.id]) === productId,
  });
}

// ── USDC escrow (distribution open) ──────────────────────────────────────────────
/**
 * Verify the tx is an ERC-20 USDC Transfer from `owner` to `treasury` for at least
 * `minRaw` (6dp base units). Returns args incl. the actual `value` transferred.
 */
export function confirmUsdcEscrow(hash: string, owner: string, treasury: string, minRaw: bigint) {
  return verifyTxEvent({
    hash, address: config.usdc, abi: transferEventAbi as unknown as Abi, eventName: "Transfer",
    match: (a) => eq(a.from as string, owner) && eq(a.to as string, treasury) && (a.value as bigint) >= minRaw,
  });
}
