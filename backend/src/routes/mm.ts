import { Router, type Request, type Response } from "express";
import { isAddress } from "viem";
import {
  quoteSellToMM,
  getMmReserves,
  type ProductKind,
  type TrancheKind,
} from "../services/mm-quote.js";
import {
  vaultConfigured,
  resolveBundleToOnchain,
  resolveBundleToNote,
  resolveBundleToTranche,
} from "../services/onchain.js";
import { confirmSoldToMM, usdcFromRaw } from "../services/verify.js";
import { createTransaction, getTransactionBySignature } from "../db/queries.js";

/**
 * MM secondary-market routes (Cumulant / Arc).
 *
 * The protocol market-maker QUOTES a bid for a pre-settlement position and signs
 * it with the vault owner key; the seller submits that signature to the vault's
 * on-chain `sellToMM(...)`. So:
 *   POST /api/mm/quote    → price + sign a bid (the off-chain half of the sell)
 *   GET  /api/mm/reserves → each vault's live MM reserve (UI/debug)
 *   POST /api/mm/confirm  → record the on-chain sell from a client tx hash (ledger)
 *
 * The backend signs the quote but NEVER submits the sell — the user signs and
 * sends `sellToMM` from their own wallet, so the trade is non-custodial end to end.
 */

const router = Router();

const ok = <T>(res: Response, data: T, status = 200) =>
  res.status(status).json({ ok: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

function safeMessage(err: unknown): string {
  if (!(err instanceof Error)) return "internal error";
  return err.message.split("\n")[0].slice(0, 200);
}

function statusForError(message: string): number {
  if (/positive|must be|invalid|required|does not map|reserve too low/i.test(message))
    return 400;
  if (/no position|not found|not configured/i.test(message)) return 404;
  return 500;
}

const PRODUCT_KINDS: ProductKind[] = ["basket", "tranche", "note"];

/**
 * POST /api/mm/quote
 * body: { bundle_id, product_type: "basket"|"tranche"|"note", wallet_address,
 *         size_usdc?, tranche_kind?: "senior"|"junior" }
 * → signed MM bid the client submits to `sellToMM`.
 */
router.post("/quote", async (req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return fail(res, 503, "On-chain vaults not configured");
    const {
      bundle_id,
      product_type,
      wallet_address,
      size_usdc,
      tranche_kind,
    } = req.body as {
      bundle_id?: string;
      product_type?: string;
      wallet_address?: string;
      size_usdc?: number;
      tranche_kind?: string;
    };

    if (!bundle_id) return fail(res, 400, "bundle_id required");
    if (!wallet_address || !isAddress(wallet_address))
      return fail(res, 400, "valid wallet_address required");
    const productType = product_type as ProductKind;
    if (!PRODUCT_KINDS.includes(productType))
      return fail(res, 400, "product_type must be basket | tranche | note");
    const trancheKind: TrancheKind | undefined =
      tranche_kind === "junior" ? "junior" : tranche_kind === "senior" ? "senior" : undefined;

    const quote = await quoteSellToMM({
      bundleId: bundle_id,
      productType,
      owner: wallet_address,
      size_usdc: typeof size_usdc === "number" ? size_usdc : 0,
      trancheKind,
    });

    return ok(res, quote);
  } catch (err) {
    const msg = safeMessage(err);
    console.error("POST /api/mm/quote error:", msg);
    return fail(res, statusForError(msg), `Failed to quote: ${msg}`);
  }
});

/** GET /api/mm/reserves → each vault's live MM reserve (display USDC). */
router.get("/reserves", async (_req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return ok(res, { basket: null, tranche: null, note: null });
    return ok(res, await getMmReserves());
  } catch (err) {
    return fail(res, 500, `Failed to read reserves: ${safeMessage(err)}`);
  }
});

/**
 * POST /api/mm/confirm — record an MM sell from a client-provided EVM tx HASH.
 * We verify the receipt landed and the realized USDC payout (from the receipt's
 * Transfer logs), then persist a best-effort ledger row (no-op if Supabase off).
 */
router.post("/confirm", async (req: Request, res: Response) => {
  try {
    const { bundle_id, wallet_address, signature, payout_usdc } = req.body as {
      bundle_id?: string;
      wallet_address?: string;
      signature?: string;
      payout_usdc?: number;
    };
    if (!signature) return fail(res, 400, "signature (tx hash) required");
    if (!bundle_id || !wallet_address)
      return fail(res, 400, "bundle_id and wallet_address required");

    // TRUST BOUNDARY: prove the tx emitted a SoldToMM event with seller ==
    // wallet_address on the vault this bundle maps to, and take the payout FROM the
    // event (never the client-supplied payout_usdc). The bundle resolves to the same
    // index across all three vaults, so we try each and accept the one that verifies.
    void payout_usdc; // intentionally not trusted
    const [basketRef, noteRef, trancheRef] = await Promise.all([
      resolveBundleToOnchain(bundle_id),
      resolveBundleToNote(bundle_id),
      resolveBundleToTranche(bundle_id),
    ]);
    const attempts = await Promise.all([
      basketRef.basketId !== null
        ? confirmSoldToMM(signature, wallet_address, "basket", basketRef.basketId)
        : Promise.resolve(null),
      noteRef ? confirmSoldToMM(signature, wallet_address, "note", noteRef.noteId) : Promise.resolve(null),
      trancheRef
        ? confirmSoldToMM(signature, wallet_address, "tranche", trancheRef.trancheId)
        : Promise.resolve(null),
    ]);
    const c = attempts.find((a) => a && a.ok);
    if (!c) return fail(res, 400, "MM sell not verified on-chain (no matching SoldToMM event)");
    const payout = usdcFromRaw(c.args?.payout ?? 0n);

    const existing = await getTransactionBySignature(signature).catch(() => null);
    if (existing) {
      return ok(res, {
        confirmed: true,
        idempotent: true,
        tx_hash: signature,
        explorer_url: c.explorer_url,
        transaction_id: existing.id,
        bundle_id,
        payout_usdc: payout,
      });
    }

    let transactionId: string | null = null;
    try {
      const tx = await createTransaction({
        bundle_id,
        wallet_address,
        type: "redemption", // an MM sell is a pre-settlement exit
        amount_usdc: payout,
        tokens: 0,
        fee_usdc: 0,
        tx_signature: signature,
      });
      transactionId = tx?.id ?? null;
    } catch {
      /* indexing optional */
    }

    return ok(
      res,
      {
        confirmed: true,
        tx_hash: signature,
        explorer_url: c.explorer_url,
        transaction_id: transactionId,
        bundle_id,
        payout_usdc: payout,
      },
      201,
    );
  } catch (err) {
    console.error("POST /api/mm/confirm error:", safeMessage(err));
    return fail(res, 500, `Failed to confirm MM sell: ${safeMessage(err)}`);
  }
});

export default router;
