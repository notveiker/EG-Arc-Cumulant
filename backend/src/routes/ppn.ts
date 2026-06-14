/**
 * Cumulant protected-note (PPN) + tranche routes (Circle Arc / EVM).
 *
 * Cumulant on Arc (EVM). The product layer is identical — a
 * principal-protected note is a real vault deposit tagged with its tranche /
 * bundle as the share label — but the on-chain rail is EVM:
 *
 *  - There are NO server-built transactions for user actions. Users custody
 *    their own USDC and sign every deposit/redeem CLIENT-SIDE.
 *  - `/onchain/prepare` is a thin RESOLVER: it maps the synthetic bundle id to a
 *    real on-chain basket id + returns the vault CONTRACT ADDRESS (from config)
 *    the client should call. It does NOT build/return tx bytes.
 *  - `/onchain/confirm` (and redeem/divest/close confirm) RECORD a ledger row /
 *    `ppn_vaults` update given a client-provided EVM tx HASH (0x… 66 chars); it
 *    verifies the receipt actually landed via the on-chain adapter.
 *  - Arcscan →
 *    Arcscan (config.explorer). All financial math is kept identical.
 *
 * Persistence (Supabase) is best-effort and degrades to a safe no-op when
 * unconfigured. The off-chain tranche RFQ is priced by the real `quoteTranches`
 * engine. Every response uses the { ok, data } / { ok, error } envelope.
 */
import { Router, type Request, type Response } from "express";
import {
  createPPNVault,
  createTransaction,
  getActivePPNVault,
  getBundleById,
  getLegsByBundleId,
  getPPNVaultById,
  getPPNVaultsByWallet,
  getTransactionBySignature,
  updatePPNVaultOnchain,
} from "../db/queries.js";
import {
  prepareRedeem,
  confirmTxHash,
  readVaultState,
  listShares,
  vaultConfigured,
  resolveBundleToNote,
  resolveBundleToTranche,
  resolveRedeemNote,
  resolveRedeemTranche,
  listOnchainPpnHoldings,
  VAULT,
} from "../services/onchain.js";
import { quoteTranches } from "../services/tranching.js";
import { allocateNote } from "../services/ppn-allocator.js";
import type { PPNVault } from "../types.js";
import { bundleIdAtIndex } from "./bundles.js";

const router = Router();

// ── Envelope helpers (match the rest of the Cumulant backend) ─────────────────

const ok = <T>(res: Response, data: T) => res.json({ ok: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

/** Sanitize errors so internal RPC/viem/db details never leak to clients. */
function safeError(e: unknown): string {
  if (!(e instanceof Error)) return "internal error";
  const first = e.message.split("\n")[0]?.slice(0, 200) ?? "internal error";
  // Drop anything that looks like an internal URL / version / raw address dump.
  return /https?:\/\/|viem@|Request Arguments/i.test(first)
    ? "internal error"
    : first;
}

/** Map a sanitized error message to an HTTP status (ported from Cumulant). */
function statusForError(message: string): number {
  if (/insufficient/i.test(message)) return 400;
  if (/no vault positions|not found/i.test(message)) return 404;
  if (/not configured/i.test(message)) return 503;
  return 500;
}

type TrancheKind = "senior" | "mezzanine" | "junior";

function maturityDate(days = 30): { iso: string; ts: number } {
  const ts = Date.now() + days * 86_400_000;
  return { iso: new Date(ts).toISOString(), ts: Math.floor(ts / 1000) };
}

function ppnLabel(bundleId: string, kind?: string): string {
  return `ppn:${kind ?? "note"}:${bundleId}`;
}

/** 0x-prefixed 66-char EVM transaction hash. */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function notConfigured(res: Response) {
  return fail(res, 503, "On-chain vault not configured.");
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /allocate — deterministic capital deployment plan (no AI)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Capital deployment plan for a protected note: floor sleeve (protected vault) +
 * the risk sleeve split across basket / tranche / distribution by profile. Pure
 * heuristic — the ppn-allocator carries no AI dependency.
 */
router.post("/allocate", (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as {
      profile?: string;
      amount_usdc?: number;
      apy?: number;
      days?: number;
      basket_label?: string;
      distribution_label?: string;
      baskets?: string[];
      distributions?: string[];
    };
    const allocation = allocateNote({
      profile: String(b.profile ?? "Income"),
      amountUsdc: Number(b.amount_usdc ?? 0),
      apy: Number(b.apy ?? 0),
      days: Number(b.days ?? 30),
      basketLabel: b.basket_label,
      distributionLabel: b.distribution_label,
      baskets: Array.isArray(b.baskets) ? b.baskets : undefined,
      distributions: Array.isArray(b.distributions) ? b.distributions : undefined,
    });
    ok(res, allocation);
  } catch (err) {
    fail(res, 400, safeError(err));
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /onchain/prepare — resolve ids + vault address (NO tx bytes)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Open a protected-note position = a real vault deposit, tagged with the
 * tranche/bundle as the share label. Returns the resolved on-chain basket id +
 * the vault CONTRACT ADDRESS the client should call (it signs the deposit
 * itself; the backend builds no transaction on Arc).
 */
router.post("/onchain/prepare", async (req: Request, res: Response) => {
  try {
    if (!vaultConfigured()) return notConfigured(res);
    const b = (req.body ?? {}) as {
      bundle_id?: string;
      wallet_address?: string;
      amount_usdc?: number;
      maturity_days?: number;
      tranche_kind?: TrancheKind;
      tranche_attach?: number;
      tranche_detach?: number;
      price_per_token?: number;
    };
    const bundle_id = typeof b.bundle_id === "string" ? b.bundle_id.trim() : "";
    const wallet_address =
      typeof b.wallet_address === "string" ? b.wallet_address.trim() : "";
    const amount_usdc = Number(b.amount_usdc);
    const tranche_kind = b.tranche_kind;

    if (!bundle_id || !wallet_address || !(amount_usdc > 0)) {
      return fail(
        res,
        400,
        "bundle_id, wallet_address, and positive amount_usdc are required",
      );
    }

    const maturity = maturityDate(b.maturity_days ?? 30);
    const isTranche = tranche_kind != null;

    // Resolve the REAL on-chain product the wallet will sign against:
    //   - a tranche position -> TrancheVault.deposit(trancheId, amount, senior)
    //   - a protected note   -> ProtectedNote.deposit(noteId, amount)
    // (This used to resolve the BasketVault + a basket id, which the note/tranche
    //  signer can't use — it needs a note_id/tranche_id on the matching contract.)
    const noteRef = isTranche ? null : await resolveBundleToNote(bundle_id);
    const trancheRef = isTranche ? await resolveBundleToTranche(bundle_id) : null;
    const target = trancheRef ?? noteRef;
    if (!target) {
      return fail(
        res,
        503,
        isTranche
          ? "No on-chain tranche is available to open this position yet."
          : "No on-chain note is available to open this position yet.",
      );
    }
    const onchainId = trancheRef ? trancheRef.trancheId : noteRef!.noteId;

    // Protected-note / tranche principal is reserved 1:1 — no basket deposit fee,
    // and the position size equals the deposited principal (one share per USDC).
    const amount6dp = Math.round(amount_usdc * 1e6).toString();

    // Best-effort DB record (safe no-op when Supabase is unconfigured). The row
    // is written WITHOUT an on-chain hash; `/onchain/confirm` stamps the hash
    // once the Arc deposit lands, which is the dividing line between a real
    // on-chain position and an abandoned row.
    let vaultId: string | null = null;
    try {
      const vault = await createPPNVault({
        bundle_id,
        wallet_address,
        principal_usdc: amount_usdc,
        yield_deployed_usdc: 0,
        estimated_apy: 8,
        vault_address: target.vault,
        status: "active",
        maturity_date: maturity.iso,
        maturity_ts: maturity.ts,
        note_seed_hex: undefined,
        onchain_tx_signature: null,
        redemption_tx_signature: null,
        tranche_kind: tranche_kind ?? null,
        tranche_attach: b.tranche_attach ?? null,
        tranche_detach: b.tranche_detach ?? null,
        price_per_token: b.price_per_token ?? null,
      });
      vaultId = vault?.id ?? null;
    } catch {
      /* DB optional */
    }

    ok(res, {
      kind: "prepared",
      vault_id: vaultId,
      bundle_id,
      wallet_address,
      amount_usdc,
      amount_usdc6dp: amount6dp,
      fee_usdc: 0,
      net_deposit_usdc: amount_usdc,
      deposit_fee_bps: 0,
      expected_shares: amount_usdc,
      share_price: 1,
      tranche_kind: tranche_kind ?? null,
      maturity_date: maturity.iso,
      maturity_ts: maturity.ts,
      // EVM call target: the wallet signs ProtectedNote/TrancheVault deposit here.
      vault: target.vault,
      ...(isTranche ? { tranche_id: onchainId } : { note_id: onchainId }),
      usdc_address: VAULT.usdc,
      usdc_decimals: VAULT.usdcDecimals,
      explorer_url: target.explorerUrl,
      // Stable position reference the frontend carries through to /confirm.
      position_id: vaultId ?? `${isTranche ? "tranche" : "note"}-${onchainId}`,
    });
  } catch (err) {
    const msg = safeError(err);
    console.error("POST /api/ppn/onchain/prepare error:", msg);
    fail(res, statusForError(msg), msg);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /onchain/confirm — record the deposit ledger row from a tx hash
// ──────────────────────────────────────────────────────────────────────────────

router.post("/onchain/confirm", async (req: Request, res: Response) => {
  try {
    const b = (req.body ?? {}) as {
      vault_id?: string;
      wallet_address?: string;
      signature?: string;
      tx_hash?: string;
      bundle_id?: string;
      amount_usdc?: number;
    };
    // Accept `tx_hash` (EVM-native) or `signature` (Cumulant-name) for the hash.
    const signature =
      typeof b.tx_hash === "string" && b.tx_hash
        ? b.tx_hash.trim()
        : typeof b.signature === "string"
          ? b.signature.trim()
          : "";
    const wallet_address =
      typeof b.wallet_address === "string" ? b.wallet_address.trim() : undefined;
    const vault_id = typeof b.vault_id === "string" ? b.vault_id : undefined;
    const bundle_id = typeof b.bundle_id === "string" ? b.bundle_id : undefined;

    if (!signature) return fail(res, 400, "tx_hash (EVM transaction hash) required");
    if (!TX_HASH_RE.test(signature)) {
      return fail(res, 400, "tx_hash must be a 0x-prefixed 66-char EVM hash");
    }

    const c = await confirmTxHash(signature, wallet_address);
    if (!c.ok) return fail(res, 400, `Arc transaction not confirmed: ${c.status}`);

    try {
      if (vault_id)
        await updatePPNVaultOnchain(vault_id, { onchain_tx_signature: signature });
    } catch {
      /* DB optional */
    }

    // Record the deposit in the ledger so it shows in Portfolio → History. The
    // basket rail records via /api/deposit/confirm; PPN/tranche deposits ride
    // this confirm, so without this they were invisible to the ledger. Prefer
    // the bundle/amount the client passed and fall back to the Supabase vault
    // row. Best-effort + idempotent on the tx hash.
    try {
      if (wallet_address) {
        const already = await getTransactionBySignature(signature);
        if (!already) {
          const vault = vault_id ? await getPPNVaultById(vault_id) : null;
          const ledgerBundle = bundle_id ?? vault?.bundle_id;
          const principal =
            Number(b.amount_usdc) || Number(vault?.principal_usdc) || 0;
          if (ledgerBundle && principal > 0) {
            await createTransaction({
              bundle_id: ledgerBundle,
              wallet_address,
              type: "deposit",
              amount_usdc: principal,
              tokens: 0,
              fee_usdc: principal * 0.0015,
              tx_signature: signature,
            });
          }
        }
      }
    } catch {
      /* ledger indexing optional */
    }

    ok(res, {
      confirmed: true,
      vault_id: vault_id ?? null,
      tx_hash: signature,
      explorer_url: c.explorer_url,
      block_number: c.block_number ?? null,
    });
  } catch (err) {
    console.error("POST /api/ppn/onchain/confirm error:", err);
    fail(res, 500, safeError(err));
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// redeem / divest / close — prepare (resolve) + confirm (record)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * redeem / divest / close all resolve the wallet's matching share receipt and
 * quote the exit economics. The client signs BasketVault.redeem itself.
 */
async function prepareRedeemHandler(req: Request, res: Response) {
  if (!vaultConfigured()) return notConfigured(res);
  const b = (req.body ?? {}) as {
    wallet_address?: string;
    bundle_id?: string;
    tranche_kind?: TrancheKind;
    share_id?: string;
    vault_id?: string;
  };
  const wallet_address =
    typeof b.wallet_address === "string" ? b.wallet_address.trim() : "";
  let bundle_id = typeof b.bundle_id === "string" ? b.bundle_id : undefined;
  const vault_id = typeof b.vault_id === "string" ? b.vault_id : undefined;
  if (!wallet_address) {
    return fail(res, 400, "wallet_address is required");
  }

  // Several callers pass only a synthetic vault_id (`tranche-{i}-{kind}` or
  // `note-{i}`) with no bundle_id / tranche_kind. Without resolving these here the
  // handler falls through to the legacy BASKET-share path (→ "No vault positions"
  // or a WRONG-contract redeem from BasketVault). Parse the synthetic id and
  // resolve the correct ProtectedNote / TrancheVault target directly.
  if (!bundle_id && vault_id) {
    const noteMatch = /^note-(\d+)$/.exec(vault_id);
    const trancheMatch = /^tranche-(\d+)-(senior|junior)$/.exec(vault_id);
    if (trancheMatch) {
      const synthBundle = bundleIdAtIndex(Number(trancheMatch[1]));
      const kind = trancheMatch[2] as TrancheKind;
      if (synthBundle) {
        const ref = await resolveRedeemTranche(synthBundle, wallet_address, kind);
        if (ref) {
          const principal = Number(ref.shares6dp) / 1e6;
          return ok(res, {
            kind: "prepared",
            bundle_id: synthBundle,
            wallet_address,
            principal_usdc: principal,
            strategy_fee_usdc: 0,
            expected_proceeds_usdc: principal,
            redeem_fee_bps: 0,
            tranche_kind: kind,
            vault: ref.vault,
            tranche_id: ref.trancheId,
            senior: ref.senior,
            shares: ref.shares6dp,
            explorer_url: ref.explorerUrl,
            position_id: `tranche-${ref.trancheId}-${kind}`,
          });
        }
      }
    } else if (noteMatch) {
      const synthBundle = bundleIdAtIndex(Number(noteMatch[1]));
      if (synthBundle) {
        const ref = await resolveRedeemNote(synthBundle, wallet_address);
        if (ref) {
          const principal = Number(ref.principal6dp) / 1e6;
          return ok(res, {
            kind: "prepared",
            bundle_id: synthBundle,
            wallet_address,
            principal_usdc: principal,
            strategy_fee_usdc: 0,
            expected_proceeds_usdc: principal,
            redeem_fee_bps: 0,
            tranche_kind: null,
            vault: ref.vault,
            note_id: ref.noteId,
            explorer_url: ref.explorerUrl,
            position_id: `note-${ref.noteId}`,
          });
        }
      }
    }
    // Synthetic id recognized but no on-chain position resolved → reuse the
    // bundle for the standard path below (it'll surface the right not-found).
    if (noteMatch || trancheMatch) {
      const idx = Number((noteMatch ?? trancheMatch)![1]);
      bundle_id = bundleIdAtIndex(idx) ?? bundle_id;
    }
  }
  // Resolve the owner's REAL on-chain position so the wallet signs the matching
  // ProtectedNote/TrancheVault redeem. (This used to resolve a BasketVault share,
  // which the note/tranche redeem signer can't use — it needs a note_id/tranche_id
  // on the right contract, plus the owner's share size for a tranche.)
  const isTranche = b.tranche_kind != null;
  if (bundle_id) {
    if (isTranche) {
      const ref = await resolveRedeemTranche(bundle_id, wallet_address, b.tranche_kind!);
      if (ref) {
        const principal = Number(ref.shares6dp) / 1e6;
        return ok(res, {
          kind: "prepared",
          bundle_id,
          wallet_address,
          principal_usdc: principal,
          strategy_fee_usdc: 0,
          expected_proceeds_usdc: principal,
          redeem_fee_bps: 0,
          tranche_kind: b.tranche_kind ?? null,
          vault: ref.vault,
          tranche_id: ref.trancheId,
          shares: ref.shares6dp,
          explorer_url: ref.explorerUrl,
          position_id: `tranche-${ref.trancheId}`,
        });
      }
    } else {
      const ref = await resolveRedeemNote(bundle_id, wallet_address);
      if (ref) {
        const principal = Number(ref.principal6dp) / 1e6;
        return ok(res, {
          kind: "prepared",
          bundle_id,
          wallet_address,
          principal_usdc: principal,
          strategy_fee_usdc: 0,
          expected_proceeds_usdc: principal,
          redeem_fee_bps: 0,
          tranche_kind: null,
          vault: ref.vault,
          note_id: ref.noteId,
          explorer_url: ref.explorerUrl,
          position_id: `note-${ref.noteId}`,
        });
      }
    }
  }

  // Fallback: legacy basket-share redeem (resolve by share id) when no bundle is given.
  const prep = await prepareRedeem({
    owner: wallet_address,
    share_id: b.share_id,
    label: bundle_id ? ppnLabel(bundle_id, b.tranche_kind) : undefined,
  });

  return ok(res, {
    kind: "prepared",
    bundle_id: bundle_id ?? null,
    wallet_address,
    share_id: prep.share_id,
    basket_id: prep.basket_id,
    principal_usdc: prep.economics.shares,
    strategy_fee_usdc: prep.economics.fee_usdc,
    expected_proceeds_usdc: prep.economics.net_usdc,
    redeem_fee_bps: prep.economics.redeem_fee_bps,
    // EVM call target the client signs against.
    vault_address: prep.vault_address,
    // On-chain position reference the ported frontend still reads.
    position_id: prep.share_id,
  });
}

router.post("/onchain/redeem/prepare", async (req, res) => {
  try {
    await prepareRedeemHandler(req, res);
  } catch (err) {
    const msg = safeError(err);
    fail(res, statusForError(msg), msg);
  }
});
router.post("/onchain/divest/prepare", async (req, res) => {
  try {
    await prepareRedeemHandler(req, res);
  } catch (err) {
    const msg = safeError(err);
    fail(res, statusForError(msg), msg);
  }
});
router.post("/onchain/close/prepare", async (req, res) => {
  try {
    await prepareRedeemHandler(req, res);
  } catch (err) {
    const msg = safeError(err);
    fail(res, statusForError(msg), msg);
  }
});

/**
 * Record a redeem/divest/close from a client-provided EVM tx hash. Resolves the
 * active note/tranche vault by (wallet, bundle) to mark it withdrawn AND stamp
 * the redemption hash — stamping it is what lets the ledger enrichment tag this
 * sell with its real product (Note / Tranche) instead of defaulting to "Basket".
 */
async function confirmCloseHandler(req: Request, res: Response, status: string) {
  const b = (req.body ?? {}) as {
    vault_id?: string;
    wallet_address?: string;
    signature?: string;
    tx_hash?: string;
    bundle_id?: string;
  };
  const signature =
    typeof b.tx_hash === "string" && b.tx_hash
      ? b.tx_hash.trim()
      : typeof b.signature === "string"
        ? b.signature.trim()
        : "";
  const wallet_address =
    typeof b.wallet_address === "string" ? b.wallet_address.trim() : undefined;
  const vault_id = typeof b.vault_id === "string" ? b.vault_id : undefined;
  const bundle_id = typeof b.bundle_id === "string" ? b.bundle_id : undefined;

  if (!signature) return fail(res, 400, "tx_hash (EVM transaction hash) required");
  if (!TX_HASH_RE.test(signature)) {
    return fail(res, 400, "tx_hash must be a 0x-prefixed 66-char EVM hash");
  }

  const c = await confirmTxHash(signature, wallet_address);
  if (!c.ok) return fail(res, 400, `Arc transaction not confirmed: ${c.status}`);

  // The redeem's share id is the on-chain basket reference, not the Supabase row
  // id, so resolve the active note/tranche vault by (wallet, bundle) to mark it
  // withdrawn AND stamp the redemption hash.
  let resolvedVault: PPNVault | null = null;
  try {
    if (wallet_address && bundle_id) {
      resolvedVault = await getActivePPNVault(wallet_address, bundle_id);
    }
    const updateId = resolvedVault?.id ?? vault_id;
    if (updateId) {
      await updatePPNVaultOnchain(updateId, {
        status: "withdrawn",
        redemption_tx_signature: signature,
      });
    }
  } catch {
    /* DB optional */
  }

  // Record the exit in the ledger (Portfolio → History). Amount is the real
  // on-chain USDC delta credited to the wallet. Best-effort + idempotent.
  try {
    if (wallet_address) {
      const already = await getTransactionBySignature(signature);
      if (!already) {
        const ledgerBundle = bundle_id ?? resolvedVault?.bundle_id;
        if (ledgerBundle) {
          await createTransaction({
            bundle_id: ledgerBundle,
            wallet_address,
            type: "redemption",
            amount_usdc: c.usdc_delta ?? 0,
            tokens: 0,
            fee_usdc: 0,
            tx_signature: signature,
          });
        }
      }
    }
  } catch {
    /* ledger indexing optional */
  }

  return ok(res, {
    confirmed: true,
    vault_id: vault_id ?? null,
    tx_hash: signature,
    explorer_url: c.explorer_url,
    principal_returned: c.usdc_delta ?? null,
    block_number: c.block_number ?? null,
    status,
  });
}

router.post("/onchain/redeem/confirm", (req, res) =>
  confirmCloseHandler(req, res, "withdrawn").catch((e) =>
    fail(res, 500, safeError(e)),
  ),
);
router.post("/onchain/divest/confirm", (req, res) =>
  confirmCloseHandler(req, res, "active").catch((e) =>
    fail(res, 500, safeError(e)),
  ),
);
router.post("/onchain/close/confirm", (req, res) =>
  confirmCloseHandler(req, res, "withdrawn").catch((e) =>
    fail(res, 500, safeError(e)),
  ),
);

// ──────────────────────────────────────────────────────────────────────────────
// POST /tranche/sell/rfq — off-chain secondary-market RFQ (real pricing)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Reconstruct a minimal vault for an on-chain position that has no Supabase row
 * (Supabase unconfigured). The portfolio surfaces such positions with synthetic
 * ids (`note-{i}` / `tranche-{i}-{kind}`); here we read the live on-chain
 * principal/shares so the sell RFQ can still price + offer them. Returns null if
 * the id isn't synthetic, the wallet is unknown, or the position is empty.
 */
async function reconstructOnchainSellVault(
  id: string,
  wallet: string,
): Promise<PPNVault | null> {
  if (!wallet) return null;
  const note = /^note-(\d+)$/.exec(id);
  const tranche = /^tranche-(\d+)-(senior|junior)$/.exec(id);
  const maturity_date = new Date(Date.now() + 30 * 86_400_000).toISOString();
  if (note) {
    const bundle_id = bundleIdAtIndex(Number(note[1]));
    if (!bundle_id) return null;
    const ref = await resolveRedeemNote(bundle_id, wallet).catch(() => null);
    const principal = ref ? Number(ref.principal6dp) / 1e6 : 0;
    if (!(principal > 0)) return null;
    return { id, bundle_id, tranche_kind: null, principal_usdc: principal, price_per_token: 1, maturity_date } as PPNVault;
  }
  if (tranche) {
    const bundle_id = bundleIdAtIndex(Number(tranche[1]));
    if (!bundle_id) return null;
    const kind = tranche[2] as TrancheKind;
    const ref = await resolveRedeemTranche(bundle_id, wallet, kind).catch(() => null);
    const principal = ref ? Number(ref.shares6dp) / 1e6 : 0;
    if (!(principal > 0)) return null;
    return { id, bundle_id, tranche_kind: kind, principal_usdc: principal, price_per_token: 1, maturity_date } as PPNVault;
  }
  return null;
}

/**
 * Secondary-market RFQ for tranche positions, priced by the REAL `quoteTranches`
 * engine (no hardcoded haircut). Resolves from the Supabase row when present, else
 * reconstructs the position from on-chain state (so it works without Supabase);
 * returns `missing` only for ids it can resolve from neither.
 */
router.post("/tranche/sell/rfq", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { vault_ids?: unknown; wallet_address?: unknown };
    const wallet = typeof body.wallet_address === "string" ? body.wallet_address.trim() : "";
    const ids = Array.isArray(body.vault_ids)
      ? body.vault_ids.filter((v): v is string => typeof v === "string" && !!v)
      : [];
    const quotes = await Promise.all(
      ids.map(async (id) => {
        const vault =
          (await getPPNVaultById(id).catch(() => null)) ??
          (await reconstructOnchainSellVault(id, wallet).catch(() => null));
        if (!vault)
          return { vault_id: id, status: "missing" as const, error: "Vault not found" };
        const bundle = await getBundleById(vault.bundle_id).catch(() => null);
        const legs = await getLegsByBundleId(vault.bundle_id).catch(() => []);
        const nowSec = Math.floor(Date.now() / 1000);
        const maturitySec = Math.floor(
          new Date(vault.maturity_date).getTime() / 1000,
        );
        const matured = nowSec >= maturitySec;
        const horizonDays = Math.max(1, (maturitySec - nowSec) / 86_400);

        const kind = (vault.tranche_kind ?? "senior") as TrancheKind;
        const nav = bundle?.issue_price ?? vault.price_per_token ?? 0.5;
        const tranche = quoteTranches({
          bundleNav: nav,
          totalLegs: Math.max(1, legs.length || 1),
          horizonDays,
        }).find((t) => t.kind === kind);

        const indicativePct = matured ? 100 : tranche ? tranche.pricePerToken * 100 : 95;
        const indicativeUsdc = vault.principal_usdc * (indicativePct / 100);
        return {
          vault_id: id,
          bundle_id: vault.bundle_id,
          tranche_kind: kind,
          status: "can_execute_onchain" as const,
          matured,
          maturity_ts: maturitySec,
          seconds_remaining: Math.max(0, maturitySec - nowSec),
          entry_price_per_token: vault.price_per_token ?? null,
          indicative_price_per_token: tranche?.pricePerToken ?? null,
          indicative_price_pct: indicativePct,
          indicative_usdc: indicativeUsdc,
          mm_spread_bps: tranche?.mmSpreadBps ?? null,
          underwriting_bps: tranche?.underwritingBps ?? null,
          protocol_fee_bps: tranche?.protocolFeeBps ?? null,
          expected_apy_pct: tranche?.expectedYieldPct ?? null,
          onchain_expected_usdc: indicativeUsdc,
        };
      }),
    );
    ok(res, {
      kind: "rfq",
      quotes,
      executable_count: quotes.filter((q) => q.status === "can_execute_onchain")
        .length,
    });
  } catch (err) {
    console.error("POST /api/ppn/tranche/sell/rfq error:", err);
    fail(res, 500, safeError(err));
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /portfolio/:walletAddress — on-chain shares merged with ppn_vaults rows
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Live PPN portfolio: on-chain `ppn:`-labeled vault shares merged with the
 * Supabase `ppn_vaults` rows for the wallet (which carry the note's maturity /
 * apy metadata the on-chain share lacks).
 */
router.get("/portfolio/:walletAddress", async (req: Request, res: Response) => {
  try {
    const walletAddress = String(req.params.walletAddress ?? "").trim();
    if (!walletAddress) return fail(res, 400, "walletAddress is required");

    if (!vaultConfigured()) {
      return ok(res, {
        wallet_address: walletAddress,
        vaults: [],
        summary: {
          total_vaults: 0,
          total_principal: 0,
          total_value: 0,
          principal_protected: true,
        },
      });
    }

    const [state, shares, dbVaults, onchain] = await Promise.all([
      readVaultState(),
      listShares(walletAddress),
      getPPNVaultsByWallet(walletAddress).catch(() => [] as PPNVault[]),
      listOnchainPpnHoldings(walletAddress).catch(() => []),
    ]);

    const DAY = 86_400_000;
    const now = Date.now();

    // On-chain holdings are the ONLY source of truth for what's a LIVE position.
    // `listOnchainPpnHoldings` reads the CURRENT protectedNote / trancheVault
    // (via VAULT, keyed to this chainId) and returns only positions with a
    // positive balance. We key them by (bundle_id, tranche_kind) so the
    // Supabase-merge / fallback paths below can be gated on a REAL on-chain
    // holding — a stale ppn_vaults row from an OLD deployment (wrong vault, or
    // zero current balance) has no matching key and must NOT surface as live.
    const onchainKey = (bundleId: string, kind: string | null) =>
      `${bundleId}::${kind ?? "note"}`;
    const onchainByKey = new Map(
      onchain.map((h) => [onchainKey(h.bundle_id, h.tranche_kind), h]),
    );

    // PRIMARY source: real on-chain ProtectedNote / TrancheVault holdings. The
    // DB-backed ppn_vaults table is empty when Supabase is unconfigured, so
    // without this the portfolio (and the tranche sell surface) showed $0.00 for
    // positions that genuinely exist on-chain. Enrich each holding with the
    // matching Supabase row's term/apy metadata when one exists.
    if (onchain.length > 0) {
      const rows = onchain.map((h) => {
        const dbV = dbVaults.find(
          (v) => v.bundle_id === h.bundle_id && (v.tranche_kind ?? null) === h.tranche_kind,
        );
        const value = h.principal_usdc * state.share_price;
        const createdMs = dbV?.created_at ? new Date(dbV.created_at).getTime() : now;
        const maturityMs = dbV?.maturity_date
          ? new Date(dbV.maturity_date).getTime()
          : now + 30 * DAY; // 30-day default term (matches the deposit default) when no DB row
        return {
          share_id: h.vault_id,
          vault_id: h.vault_id,
          bundle_id: h.bundle_id,
          tranche_kind: h.tranche_kind,
          // A tranche row must carry a tranche signal so the client buckets it as
          // a tranche (looksLikeTranche); price_per_token = 1 keeps qty == principal.
          price_per_token: h.tranche_kind ? (dbV?.price_per_token ?? 1) : null,
          principal_usdc: h.principal_usdc,
          yield_deployed_usdc: 0,
          current_value: value,
          accrued_yield: value - h.principal_usdc,
          status: "active",
          created_at: dbV?.created_at ?? new Date(createdMs).toISOString(),
          maturity_date: dbV?.maturity_date ?? new Date(maturityMs).toISOString(),
          days_elapsed: Math.max(0, (now - createdMs) / DAY),
          days_remaining: Math.max(0, (maturityMs - now) / DAY),
          estimated_apy: dbV?.estimated_apy ?? 0.08,
          // Read straight from the current on-chain contracts → always backed.
          is_onchain_backed: true,
        };
      });
      const totalPrincipal = rows.reduce((s, r) => s + r.principal_usdc, 0);
      const totalValue = rows.reduce((s, r) => s + r.current_value, 0);
      return ok(res, {
        wallet_address: walletAddress,
        share_price: state.share_price,
        vaults: rows,
        summary: {
          total_vaults: rows.length,
          total_principal: totalPrincipal,
          total_accrued_yield: totalValue - totalPrincipal,
          total_value: totalValue,
          principal_protected: true,
        },
      });
    }

    const ppnShares = shares.filter((s) => s.label.startsWith("ppn:"));

    // On-chain ppn-labeled shares are the source of truth for live principal. If
    // the chain exposes none (the EVM basket vault labels by basket name, not
    // ppn:), fall back to the Supabase rows so the portfolio still renders the
    // user's confirmed notes — merged with on-chain NAV via the share price.
    //
    // BOTH fallback paths are gated on a REAL current on-chain holding
    // (`onchainByKey`, keyed to THIS chain's protectedNote/trancheVault with a
    // positive balance). A stale ppn_vaults row from an OLD deployment — wrong
    // vault_address, or zero on-chain principal — has no matching holding and is
    // dropped, so it can never render as a live position or expose a Sell that
    // can't be quoted. When `onchain` is empty (the common stale case) every
    // fallback row is excluded and the portfolio is correctly empty.
    const rows =
      ppnShares.length > 0
        ? ppnShares
            .filter((s) => {
              const parts = s.label.split(":");
              const bundleId = parts[2] ?? "cumulant-vault";
              const trancheKind =
                parts[1] && parts[1] !== "note" ? parts[1] : null;
              return onchainByKey.has(onchainKey(bundleId, trancheKind));
            })
            .map((s) => {
            const parts = s.label.split(":");
            const bundleId = parts[2] ?? "cumulant-vault";
            const trancheKind =
              parts[1] && parts[1] !== "note" ? parts[1] : null;
            const value = s.shares * state.share_price;
            // Recover the note's term / apy / created-at from the matching
            // Supabase vault row. The on-chain share carries principal but no
            // maturity metadata, so without this the portfolio shows "MATURITY
            // UNKNOWN" even though the note was created with a real term.
            const dbV = dbVaults.find(
              (v) =>
                v.bundle_id === bundleId &&
                (v.tranche_kind ?? null) === trancheKind,
            );
            const createdMs = dbV?.created_at
              ? new Date(dbV.created_at).getTime()
              : NaN;
            const maturityMs = dbV?.maturity_date
              ? new Date(dbV.maturity_date).getTime()
              : NaN;
            return {
              share_id: s.share_id,
              vault_id: s.share_id,
              bundle_id: bundleId,
              tranche_kind: trancheKind,
              principal_usdc: s.principal_usdc,
              current_value: value,
              accrued_yield: value - s.principal_usdc,
              status: "active",
              created_at: dbV?.created_at ?? null,
              maturity_date: dbV?.maturity_date ?? null,
              days_elapsed: Number.isFinite(createdMs)
                ? Math.max(0, (now - createdMs) / DAY)
                : 0,
              days_remaining: Number.isFinite(maturityMs)
                ? Math.max(0, (maturityMs - now) / DAY)
                : 0,
              estimated_apy: dbV?.estimated_apy ?? null,
              is_onchain_backed: true,
            };
          })
        : dbVaults
            .filter((v) =>
              onchainByKey.has(onchainKey(v.bundle_id, v.tranche_kind ?? null)),
            )
            .map((v) => {
            const principal = Number(v.principal_usdc) || 0;
            const value = principal * state.share_price;
            const createdMs = v.created_at
              ? new Date(v.created_at).getTime()
              : NaN;
            const maturityMs = v.maturity_date
              ? new Date(v.maturity_date).getTime()
              : NaN;
            return {
              share_id: v.id,
              vault_id: v.id,
              bundle_id: v.bundle_id,
              tranche_kind: v.tranche_kind ?? null,
              principal_usdc: principal,
              current_value: value,
              accrued_yield: value - principal,
              status: v.status ?? "active",
              created_at: v.created_at ?? null,
              maturity_date: v.maturity_date ?? null,
              days_elapsed: Number.isFinite(createdMs)
                ? Math.max(0, (now - createdMs) / DAY)
                : 0,
              days_remaining: Number.isFinite(maturityMs)
                ? Math.max(0, (maturityMs - now) / DAY)
                : 0,
              estimated_apy: v.estimated_apy ?? null,
              is_onchain_backed: true,
            };
          });

    const totalPrincipal = rows.reduce((sum, r) => sum + r.principal_usdc, 0);
    const totalValue = rows.reduce((sum, r) => sum + r.current_value, 0);

    ok(res, {
      wallet_address: walletAddress,
      share_price: state.share_price,
      vaults: rows,
      summary: {
        total_vaults: rows.length,
        total_principal: totalPrincipal,
        total_accrued_yield: totalValue - totalPrincipal,
        total_value: totalValue,
        principal_protected: true,
      },
    });
  } catch (err) {
    console.error("GET /api/ppn/portfolio error:", err);
    fail(res, 500, safeError(err));
  }
});

export default router;
