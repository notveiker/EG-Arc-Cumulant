import { Router, type Request, type Response } from "express";
import {
  getBundleById,
  createPosition,
  createTransaction,
  getTransactionBySignature,
  getTransactionsByWallet,
  getPPNVaultsForLedger,
} from "../db/queries.js";
import { supabase } from "../db/supabase.js";
import {
  prepareDeposit,
  prepareRedeem,
  confirmTxHash,
  readVaultState,
  resolveBundleToOnchain,
  getVaultPrice,
  listShares,
  vaultConfigured,
  VAULT,
} from "../services/onchain.js";
import { validate, depositSchema, redeemSchema } from "../utils/validation.js";

// Basket-vault deposit / redeem routes —
// Circle Arc (EVM). The translation contract:
//   - There are NO backend-built transactions for user actions on Arc. The
//     `/prepare` endpoints are thin resolvers that return the on-chain basket id
//     plus the basket vault CONTRACT ADDRESS the client should call; the client
//     signs the deposit/redeem itself.
//   - The `/confirm` endpoints RECORD a ledger row given a client-provided EVM tx
//     HASH (0x… 66 chars). We verify the receipt actually landed (success) and
//     bind the hash to the claiming wallet / bundle before persisting.
//   - (config.explorer).
//   - All responses use the { ok, data } envelope.

const router = Router();

/** Envelope helpers — match the rest of the Cumulant backend. */
const ok = <T>(res: Response, data: T, status = 200) =>
  res.status(status).json({ ok: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

/** Sanitize an error to a short, safe message (never leak stack traces). */
function safeMessage(err: unknown): string {
  if (!(err instanceof Error)) return "internal error";
  // Keep it to the first line; drop anything that looks like a path/stack.
  return err.message.split("\n")[0].slice(0, 200);
}

/** Classify a prepare/build error into the right HTTP status. */
function statusForError(message: string): number {
  if (/insufficient/i.test(message)) return 400;
  if (/no vault positions|not found|not configured/i.test(message)) return 404;
  return 500;
}

/** The on-chain event's owner must match the wallet claiming the deposit/redeem. */
function ownerMismatch(
  event: Record<string, unknown> | undefined,
  wallet: string,
): boolean {
  const owner = (event?.owner as string | undefined)?.toLowerCase();
  return Boolean(owner && wallet && owner !== wallet.toLowerCase());
}

/** Decode the on-chain share label the deposit was tagged with, if surfaced. */
function eventLabel(event: Record<string, unknown> | undefined): string | null {
  const raw = event?.label;
  if (Array.isArray(raw)) return Buffer.from(raw as number[]).toString("utf8");
  if (typeof raw === "string") return raw;
  return null;
}

function notConfigured(res: Response) {
  return fail(
    res,
    503,
    "On-chain vault not configured (set BASKET_VAULT_ADDRESS et al).",
  );
}

/**
 * Resolve everything the client needs to build + sign a deposit itself. There is
 * NO server-side tx construction on Arc — we return the resolved on-chain basket
 * id, the vault CONTRACT ADDRESS the client should call, the USDC token to
 * approve, and the deposit economics (fee / net / expected shares).
 */
async function prepareDepositHandler(req: Request, res: Response) {
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const { bundle_id, wallet_address, amount_usdc } = req.body as {
      bundle_id: string;
      wallet_address: string;
      amount_usdc: number;
    };

    const prep = await prepareDeposit({
      owner: wallet_address,
      amount_usdc,
      label: bundle_id,
    });

    return ok(res, {
      kind: "prepared",
      bundle_id,
      wallet_address,
      amount_usdc,
      fee_usdc: prep.economics.fee_usdc,
      net_usdc: prep.economics.net_usdc,
      issue_price: prep.economics.share_price,
      tokens_minted: prep.economics.expected_shares,
      expected_tokens: prep.economics.expected_shares,
      deposit_fee_bps: prep.economics.deposit_fee_bps,
      // The vault contract + basket the client should call (no tx bytes on Arc):
      vault_address: prep.vault_address,
      basket_id: prep.basket_id,
      usdc_address: prep.usdc_address,
      usdc_decimals: prep.usdc_decimals,
      // The vault share identifier minted by this deposit.
      share_type: prep.share_type,
    });
  } catch (err) {
    const msg = safeMessage(err);
    console.error("POST /api/deposit/prepare error:", msg);
    return fail(res, statusForError(msg), `Failed to prepare deposit: ${msg}`);
  }
}

router.post("/prepare", validate(depositSchema), prepareDepositHandler);
router.post("/", validate(depositSchema), prepareDepositHandler);

router.get("/vault-price/:bundleId", async (req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const price = await getVaultPrice(req.params.bundleId);
    if (!price) throw new Error("vault price unavailable");
    return ok(res, {
      bundle_id: req.params.bundleId,
      vault_id: VAULT.basketVault,
      issue_price: price.issue_price,
      fee_bps: price.fee_bps,
      redeem_fee_bps: price.redeem_fee_bps,
      total_assets_usdc: price.total_assets_usdc,
      total_shares: price.total_shares,
      vault_state: "active",
    });
  } catch (err) {
    return fail(res, 500, `Failed to fetch vault price: ${safeMessage(err)}`);
  }
});

router.get("/vault-prices", async (_req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return ok(res, { count: 0, prices: [] });
    const state = await readVaultState();
    return ok(res, {
      count: 1,
      prices: [
        {
          bundle_id: "cumulant-vault",
          bundle_name: "Cumulant Vault (USDC)",
          vault_id: VAULT.basketVault,
          issue_price: state.share_price,
          fee_bps: state.deposit_fee_bps,
          total_assets_usdc: Number(state.total_assets_raw) / 10 ** VAULT.usdcDecimals,
        },
      ],
    });
  } catch (err) {
    return fail(res, 500, `Failed to fetch vault prices: ${safeMessage(err)}`);
  }
});

/**
 * Record a deposit ledger row from a client-provided EVM tx HASH. We verify the
 * tx actually landed (receipt status === success) before persisting, bind the
 * hash to the claiming wallet/bundle, and dedupe by hash for idempotency.
 */
router.post("/confirm", async (req: Request, res: Response) => {
  try {
    const {
      bundle_id,
      wallet_address,
      amount_usdc,
      signature,
      tokens_minted,
      issue_price,
      fee_usdc,
    } = req.body as {
      bundle_id: string;
      wallet_address: string;
      amount_usdc: number;
      signature: string;
      tokens_minted?: number;
      issue_price?: number;
      fee_usdc?: number;
    };
    if (!signature) return fail(res, 400, "signature (tx hash) required");
    if (!bundle_id || !wallet_address)
      return fail(res, 400, "bundle_id and wallet_address required");

    const c = await confirmTxHash(signature, wallet_address);
    if (!c.ok) {
      return fail(res, 400, `Arc transaction not confirmed: ${c.status}`);
    }
    // Owner-binding: reject a real tx hash claimed by the wrong wallet.
    if (ownerMismatch(c.event, wallet_address)) {
      return fail(res, 400, "Tx owner does not match wallet_address");
    }
    // Bundle-binding: the on-chain deposit label (when surfaced) must match the
    // claimed bundle so a hash can't be attributed to the wrong basket.
    const label = eventLabel(c.event);
    if (label && label !== bundle_id) {
      return fail(res, 400, "Tx bundle label does not match bundle_id");
    }
    // Idempotency: a hash already recorded returns the existing row unchanged.
    const existing = await getTransactionBySignature(signature).catch(() => null);
    if (existing) {
      return ok(res, {
        confirmed: true,
        idempotent: true,
        tx_hash: signature,
        explorer_url: c.explorer_url,
        transaction_id: existing.id,
        bundle_id,
      });
    }

    // Best-effort off-chain indexing (no-op if Supabase is unconfigured).
    let transactionId: string | null = null;
    try {
      const position = await createPosition({
        bundle_id,
        wallet_address,
        tokens_held: tokens_minted ?? 0,
        entry_price: issue_price ?? 1,
        deposited_usdc: amount_usdc,
      });
      const transaction = await createTransaction({
        bundle_id,
        wallet_address,
        type: "deposit",
        amount_usdc,
        tokens: tokens_minted ?? 0,
        fee_usdc: fee_usdc ?? 0,
        tx_signature: signature,
      });
      transactionId = transaction?.id ?? null;
      if (transaction && supabase) {
        await supabase
          .from("transactions")
          .update({ onchain_tx_signature: signature })
          .eq("id", transaction.id);
      }
      void position;
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
        tokens_minted: tokens_minted ?? null,
        issue_price: issue_price ?? null,
        fee_usdc: fee_usdc ?? null,
      },
      201,
    );
  } catch (err) {
    console.error("POST /api/deposit/confirm error:", safeMessage(err));
    return fail(res, 500, `Failed to confirm deposit: ${safeMessage(err)}`);
  }
});

/**
 * Resolve everything the client needs to build + sign a redeem itself: the vault
 * contract address, the resolved basket id, and the exit economics (gross / fee /
 * net) quoted against the caller's live on-chain share balance.
 */
async function prepareRedeemHandler(req: Request, res: Response) {
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const { bundle_id, wallet_address } = req.body as {
      bundle_id: string;
      wallet_address: string;
    };
    const prep = await prepareRedeem({ owner: wallet_address, label: bundle_id });
    return ok(res, {
      kind: "prepared",
      bundle_id,
      wallet_address,
      share_id: prep.share_id,
      total_tokens: prep.economics.shares,
      expected_usdc: prep.economics.net_usdc,
      gross_usdc: prep.economics.gross_usdc,
      exit_fee_usdc: prep.economics.fee_usdc,
      redeem_fee_bps: prep.economics.redeem_fee_bps,
      redeem_kind: "active_early",
      vault_address: prep.vault_address,
      basket_id: prep.basket_id,
    });
  } catch (err) {
    const msg = safeMessage(err);
    console.error("POST /api/deposit/redeem/prepare error:", msg);
    return fail(res, statusForError(msg), `Failed to prepare redeem: ${msg}`);
  }
}

router.post("/redeem/prepare", validate(redeemSchema), prepareRedeemHandler);
// Alias: redeem == redeem/prepare (resolve the on-chain references to call).
router.post("/redeem", validate(redeemSchema), prepareRedeemHandler);

/**
 * Record a redeem ledger row from a client-provided EVM tx HASH. We verify the
 * receipt landed (success), bind the hash to the wallet, and surface the realized
 * USDC payout derived from the receipt's ERC-20 Transfer logs.
 */
router.post("/redeem/confirm", async (req: Request, res: Response) => {
  try {
    const { bundle_id, wallet_address, signature } = req.body as {
      bundle_id: string;
      wallet_address: string;
      signature: string;
    };
    if (!signature) return fail(res, 400, "signature (tx hash) required");
    if (!bundle_id || !wallet_address)
      return fail(res, 400, "bundle_id and wallet_address required");

    const c = await confirmTxHash(signature, wallet_address);
    if (!c.ok) {
      return fail(res, 400, `Arc transaction not confirmed: ${c.status}`);
    }
    if (ownerMismatch(c.event, wallet_address)) {
      return fail(res, 400, "Tx owner does not match wallet_address");
    }
    const existingRedeem = await getTransactionBySignature(signature).catch(
      () => null,
    );
    if (existingRedeem) {
      return ok(res, {
        confirmed: true,
        idempotent: true,
        tx_hash: signature,
        explorer_url: c.explorer_url,
        bundle_id,
        wallet_address,
        payout_usdc: c.usdc_delta ?? null,
        transaction_id: existingRedeem.id,
      });
    }

    let transactionId: string | null = null;
    try {
      const tx = await createTransaction({
        bundle_id,
        wallet_address,
        type: "redemption",
        amount_usdc: c.usdc_delta ?? 0,
        tokens: 0,
        fee_usdc: 0,
        tx_signature: signature,
      });
      transactionId = tx?.id ?? null;
    } catch {
      /* indexing optional */
    }

    return ok(res, {
      confirmed: true,
      tx_hash: signature,
      explorer_url: c.explorer_url,
      bundle_id,
      wallet_address,
      payout_usdc: c.usdc_delta ?? null,
      transaction_id: transactionId,
    });
  } catch (err) {
    console.error("POST /api/deposit/redeem/confirm error:", safeMessage(err));
    return fail(res, 500, `Failed to confirm redeem: ${safeMessage(err)}`);
  }
});

/**
 * Live on-chain portfolio: the wallet's real basket-vault positions, valued at
 * the live share price.
 */
router.get("/portfolio/:walletAddress", async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    if (!vaultConfigured()) {
      return ok(res, {
        wallet_address: walletAddress,
        positions: [],
        total_value: 0,
        total_pnl: 0,
      });
    }
    const [state, shares] = await Promise.all([
      readVaultState(),
      listShares(walletAddress),
    ]);

    const positions = shares.map((s) => {
      const currentValue = s.shares * state.share_price;
      const costBasis = s.principal_usdc;
      const unrealizedPnl = currentValue - costBasis;
      return {
        position_id: s.share_id,
        share_id: s.share_id,
        bundle_id: s.label || "cumulant-vault",
        bundle_name: s.label || "Cumulant Vault",
        bundle_status: "active",
        tokens_held: s.shares,
        entry_price: costBasis > 0 && s.shares > 0 ? costBasis / s.shares : 1,
        deposited_usdc: costBasis,
        current_nav: state.share_price,
        current_value: currentValue,
        unrealized_pnl: unrealizedPnl,
        pnl_percent: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
      };
    });

    const totalValue = positions.reduce((s, p) => s + p.current_value, 0);
    const totalDeposited = positions.reduce((s, p) => s + p.deposited_usdc, 0);
    const totalPnl = totalValue - totalDeposited;
    return ok(res, {
      wallet_address: walletAddress,
      vault_id: VAULT.basketVault,
      share_price: state.share_price,
      positions,
      total_value: totalValue,
      total_deposited: totalDeposited,
      total_pnl: totalPnl,
      total_pnl_percent: totalDeposited > 0 ? (totalPnl / totalDeposited) * 100 : 0,
    });
  } catch (err) {
    console.error("GET /api/deposit/portfolio error:", safeMessage(err));
    return fail(res, 500, `Failed to fetch portfolio: ${safeMessage(err)}`);
  }
});

router.get("/transactions/:walletAddress", async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    const [transactions, ledgerVaults] = await Promise.all([
      getTransactionsByWallet(walletAddress),
      getPPNVaultsForLedger(walletAddress).catch(() => []),
    ]);
    // Map every vault's deposit + redemption hash -> the vault, so each
    // transaction can be tagged with its product type (note / tranche). A tx with
    // no vault match is a Market Basket (PBU units, no vault share).
    const vaultBySig = new Map<string, (typeof ledgerVaults)[number]>();
    for (const v of ledgerVaults) {
      if (v.onchain_tx_signature) vaultBySig.set(v.onchain_tx_signature, v);
      if (v.redemption_tx_signature) vaultBySig.set(v.redemption_tx_signature, v);
    }
    const enriched = await Promise.all(
      transactions.map(async (tx) => {
        const bundle = await getBundleById(tx.bundle_id).catch(() => null);
        const v = tx.tx_signature ? vaultBySig.get(tx.tx_signature) : undefined;
        // product: 'tranche' (has tranche_kind) | 'note' (vault share, no
        // tranche) | 'basket' (no vault match). Drives the History label.
        const product = v ? (v.tranche_kind ? "tranche" : "note") : "basket";
        return {
          id: tx.id,
          bundle_id: tx.bundle_id,
          bundle_name: bundle?.name ?? "Cumulant Vault",
          type: tx.type,
          amount_usdc: tx.amount_usdc,
          tokens: tx.tokens,
          fee_usdc: tx.fee_usdc,
          tx_signature: tx.tx_signature,
          created_at: tx.created_at,
          product,
          tranche_kind: v?.tranche_kind ?? null,
          principal_usdc: v ? v.principal_usdc : null,
        };
      }),
    );
    return ok(res, {
      wallet_address: walletAddress,
      count: enriched.length,
      transactions: enriched,
    });
  } catch (err) {
    console.error("GET /api/deposit/transactions error:", safeMessage(err));
    return fail(res, 500, `Failed to fetch transactions: ${safeMessage(err)}`);
  }
});

// Cumulant-name alias kept for compatibility with callers that imported it.
export const depositRoutes = router;
export default router;
