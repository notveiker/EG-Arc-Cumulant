"use client";

/**
 * Cumulant MM secondary-market client (Circle Arc / EVM).
 *
 * Pre-settlement exit flow — the protocol acts as a market-maker:
 *   1) POST `/api/mm/quote` returns an owner-SIGNED bid for the position
 *      (per-product price below par + a deadline + signature),
 *   2) the seller submits `sellToMM(...)` CLIENT-SIDE via `useCumulant()`; the
 *      vault recovers the signer, checks it == owner(), pays the seller from the
 *      MM reserve, and warehouses the position to settlement,
 *   3) POST `/api/mm/confirm` with the tx hash records the ledger row (History).
 *
 * The backend prices + signs; the user signs + sends the sell. Non-custodial end
 * to end — the backend never moves the user's position. Buys (deposit) and sells
 * (sellToMM) both settle on chain; only the quoting is simulated off-chain.
 */

import type { Address } from "viem";
import type { useCumulant } from "@/lib/tx";
import { BACKEND_URL } from "./tokens";
import { unwrap } from "./http";
import type { WalletSigner } from "./wallet-bridge";

export type MmProductType = "basket" | "tranche" | "note";
// Mezzanine + junior both ride the on-chain subordinate slice (senior=false);
// only the MM bid differs. Senior is the protected slice (senior=true).
export type MmTrancheKind = "senior" | "junior" | "mezzanine";

/** The signed MM bid, mirroring the backend `SignedQuote`. */
export interface MmQuote {
  productType: MmProductType;
  trancheKind: MmTrancheKind | null;
  vault: Address;
  productId: number;
  seller: Address;
  /** Position size sold, 6dp base units (string) — the exact `shares`/`principal` arg. */
  size6dp: string;
  size_usdc: number;
  /** MM payout, 6dp base units (string) — the exact signed `payout`. */
  payout6dp: string;
  payout_usdc: number;
  mark_per_unit: number;
  bid_per_unit: number;
  spread_bps: number;
  deadline: number;
  signature: `0x${string}`;
  digest: `0x${string}`;
  chainId: number;
  reserve_usdc: number;
  explorerUrl: string;
}

export class MmError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "MmError";
    this.status = status;
  }
}

/** The subset of `useCumulant()` the MM sell needs. */
export type CumulantSellActions = Pick<
  ReturnType<typeof useCumulant>,
  "sellBasketToMM" | "sellTrancheToMM" | "sellNoteToMM"
>;

function requireWallet(wallet: WalletSigner): string {
  if (!wallet.connected || !wallet.address) {
    throw new MmError("Connect an Arc wallet to continue.", 0);
  }
  return wallet.address;
}

/** Fetch a fresh owner-signed MM bid for a position. */
export async function fetchMmQuote(args: {
  bundleId: string;
  productType: MmProductType;
  walletAddress: string;
  sizeUsdc: number;
  trancheKind?: MmTrancheKind;
  signal?: AbortSignal;
}): Promise<MmQuote> {
  const res = await fetch(`${BACKEND_URL}/api/mm/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bundle_id: args.bundleId,
      product_type: args.productType,
      wallet_address: args.walletAddress,
      size_usdc: args.sizeUsdc,
      tranche_kind: args.trancheKind,
    }),
    signal: args.signal,
  });
  if (!res.ok) {
    let msg = `MM quote failed (HTTP ${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* keep default */
    }
    throw new MmError(msg, res.status);
  }
  return unwrap(await res.json()) as MmQuote;
}

/** Record a completed MM sell (best-effort; no-op if the backend can't persist). */
async function confirmMmSell(args: {
  bundleId: string;
  walletAddress: string;
  signature: string;
  payoutUsdc: number;
}): Promise<void> {
  try {
    await fetch(`${BACKEND_URL}/api/mm/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bundle_id: args.bundleId,
        wallet_address: args.walletAddress,
        signature: args.signature,
        payout_usdc: args.payoutUsdc,
      }),
    });
  } catch {
    /* ledger indexing is optional */
  }
}

/**
 * Sell a pre-settlement position to the protocol market-maker. Fetches (or reuses)
 * a signed quote, submits `sellToMM` from the user's wallet, then records it.
 */
export async function sellToMMFromBundle(args: {
  wallet: WalletSigner;
  cumulant: CumulantSellActions;
  bundleId: string;
  productType: MmProductType;
  sizeUsdc: number;
  trancheKind?: MmTrancheKind;
  /** A pre-fetched quote to reuse; re-fetched if absent or expired. */
  quote?: MmQuote | null;
  onStage?: (stage: "preparing" | "signing" | "confirming" | "persisting") => void;
}): Promise<{ signature: string; quote: MmQuote }> {
  const owner = requireWallet(args.wallet);

  args.onStage?.("preparing");
  // Re-fetch if no quote, a mismatched size, or within 30s of expiry (so the
  // signed deadline can't lapse mid-signature).
  const nowSec = Math.floor(Date.now() / 1000);
  const stale =
    !args.quote ||
    args.quote.deadline - nowSec < 30 ||
    args.quote.seller.toLowerCase() !== owner.toLowerCase();
  const quote = stale
    ? await fetchMmQuote({
        bundleId: args.bundleId,
        productType: args.productType,
        walletAddress: owner,
        sizeUsdc: args.sizeUsdc,
        trancheKind: args.trancheKind,
      })
    : (args.quote as MmQuote);

  const size = BigInt(quote.size6dp);
  const payout = BigInt(quote.payout6dp);
  const deadline = BigInt(quote.deadline);

  args.onStage?.("signing");
  let signature: string;
  if (args.productType === "basket") {
    signature = await args.cumulant.sellBasketToMM(
      quote.vault,
      quote.productId,
      size,
      payout,
      deadline,
      quote.signature,
    );
  } else if (args.productType === "tranche") {
    signature = await args.cumulant.sellTrancheToMM(
      quote.vault,
      quote.productId,
      size,
      // Senior is the only protected slice; mezzanine + junior are subordinate.
      // MUST match the backend digest's senior bool (trancheKind === "senior").
      quote.trancheKind === "senior",
      payout,
      deadline,
      quote.signature,
    );
  } else {
    signature = await args.cumulant.sellNoteToMM(
      quote.vault,
      quote.productId,
      size,
      payout,
      deadline,
      quote.signature,
    );
  }

  args.onStage?.("confirming");
  await confirmMmSell({
    bundleId: args.bundleId,
    walletAddress: owner,
    signature,
    payoutUsdc: quote.payout_usdc,
  });

  args.onStage?.("persisting");
  return { signature, quote };
}
