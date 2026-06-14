import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import {
  getLiveNAV,
  checkAndUpdateResolutions,
  getVaultPrice,
} from "../services/pricing.js";
import { getPolymarketBasketNAVs } from "../services/polymarket.js";
import { isFullyResolved } from "../services/nav.js";
import {
  getBundleById,
  getLegsByBundleId,
  updateBundleStatus,
  updateLegResolution,
  getNAVHistory,
  getNAVHistorySince,
} from "../db/queries.js";

const router = Router();

// ── Envelope + error helpers ───────────────────────────────────────────────
const ok = <T>(res: Response, data: T) => res.json({ ok: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

/** Sanitize errors so internal RPC/Supabase/viem details never leak to clients. */
function safeError(e: unknown): string {
  if (!(e instanceof Error)) return "internal error";
  const first = e.message.split("\n")[0]?.slice(0, 160) ?? "internal error";
  // Drop anything that looks like an internal URL / version / request dump / address.
  return /https?:\/\/|viem@|Request Arguments|0x[0-9a-f]{40,}/i.test(first)
    ? "internal error"
    : first;
}

/** A bundle id is a non-empty, reasonably bounded path token. */
function isValidBundleId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 128;
}

/**
 * Resolver/admin auth — same scheme as backend/src/index.ts `resolverAuthorized`:
 * checks `Authorization: Bearer <RESOLVER_API_SECRET>` with a constant-time compare.
 * On a public chain (config.chain !== "local") an UNSET secret REJECTS (fail-closed):
 * an unset secret there must never hand anyone the server-owned resolve role.
 */
function resolverAuthorized(req: Request): boolean {
  const secret = process.env.RESOLVER_API_SECRET;
  if (!secret) {
    // No secret configured: allow ONLY on a local dev chain. Never fail open on
    // a public chain (Arc).
    return config.chain === "local";
  }
  const provided = req.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Constant-time comparison (equal-length guard first) so the secret can't be
  // recovered via response-timing.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET /api/nav/:bundleId
 * Get live NAV for a bundle. Fetches latest Polymarket prices, updates the
 * (optional) Supabase ledger, and returns the full NAV breakdown with per-leg
 * contributions. The vault price is the on-chain mint price read from the Arc
 * basket vault (USDC, 6-decimals); the Polymarket NAV is informational only.
 */
router.get("/:bundleId", async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;
    if (!isValidBundleId(bundleId)) return fail(res, 400, "invalid bundle id");

    const [vaultPrice, polyNAVs, bundle] = await Promise.all([
      getVaultPrice(bundleId),
      getPolymarketBasketNAVs(),
      getBundleById(bundleId),
    ]);

    // Per-leg probability data for the breakdown table.
    const navResult = await getLiveNAV(bundleId);
    if (!navResult) {
      return fail(res, 404, "bundle not found or has no legs");
    }

    const polyData = bundle ? polyNAVs.get(bundle.name) : undefined;

    return ok(res, {
      ...navResult,
      nav: navResult.nav, // real leg-weighted NAV (consistent everywhere)
      vault_price: vaultPrice?.issue_price ?? null, // on-chain mint price (Arc)
      polymarket_nav: polyData?.nav ?? null, // informational only
      polymarket_leg_count: polyData?.leg_count ?? null,
      polymarket_daily_change: polyData?.daily_change ?? null,
    });
  } catch (err) {
    console.error("GET /api/nav/:bundleId error:", err);
    return fail(res, 500, safeError(err));
  }
});

/**
 * GET /api/nav/:bundleId/history
 * Returns historical NAV snapshots for rendering price charts.
 * Query params:
 *   ?since=<ISO datetime> - return all snapshots since this time
 *   ?limit=<number>       - max snapshots to return (default 100, ignored if since is provided)
 * Snapshots are recorded periodically by the cron. Degrades to an empty list
 * when Supabase is not configured.
 */
router.get("/:bundleId/history", async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;
    if (!isValidBundleId(bundleId)) return fail(res, 400, "invalid bundle id");

    const { since, limit } = req.query;

    let history;
    if (since && typeof since === "string") {
      history = await getNAVHistorySince(bundleId, since);
    } else {
      let parsedLimit = 100;
      if (typeof limit === "string") {
        const n = parseInt(limit, 10);
        if (Number.isFinite(n) && n > 0) parsedLimit = Math.min(n, 1000);
      }
      history = await getNAVHistory(bundleId, parsedLimit);
    }

    return ok(res, {
      bundle_id: bundleId,
      count: history.length,
      history,
    });
  } catch (err) {
    console.error("GET /api/nav/:bundleId/history error:", err);
    return fail(res, 500, safeError(err));
  }
});

/**
 * POST /api/nav/:bundleId/check-resolutions
 * Manually trigger a resolution check for a bundle. Reads the latest Polymarket
 * state for each active leg and resolves it (mirroring on-chain on Arc). If all
 * legs are now resolved, the bundle status is auto-updated to 'resolved'.
 */
router.post("/:bundleId/check-resolutions", async (req: Request, res: Response) => {
  try {
    // Mutating/admin route: server-owned resolver role only (fail-closed on Arc).
    if (!resolverAuthorized(req)) return fail(res, 401, "unauthorized");

    const { bundleId } = req.params;
    if (!isValidBundleId(bundleId)) return fail(res, 400, "invalid bundle id");

    const newlyResolved = await checkAndUpdateResolutions(bundleId);

    // Check if all legs are now resolved.
    const allLegs = await getLegsByBundleId(bundleId);
    if (allLegs.length === 0) {
      return fail(res, 404, "no legs found for bundle");
    }

    let bundleFullyResolved = false;
    if (isFullyResolved(allLegs)) {
      await updateBundleStatus(bundleId, "resolved");
      bundleFullyResolved = true;
    }

    return ok(res, {
      bundle_id: bundleId,
      newly_resolved: newlyResolved.map((leg) => ({
        leg_id: leg.id,
        question: leg.question,
        status: leg.status,
        resolution_value: leg.resolution_value,
      })),
      newly_resolved_count: newlyResolved.length,
      total_legs: allLegs.length,
      resolved_legs: allLegs.filter((l) => l.status !== "active").length,
      bundle_fully_resolved: bundleFullyResolved,
    });
  } catch (err) {
    console.error("POST /api/nav/:bundleId/check-resolutions error:", err);
    return fail(res, 500, safeError(err));
  }
});

/**
 * POST /api/nav/:bundleId/simulate-resolution
 * FOR DEMO ONLY: manually force-resolve a leg.
 * Body: { leg_id: string, outcome: 'won' | 'lost' }
 */
router.post("/:bundleId/simulate-resolution", async (req: Request, res: Response) => {
  try {
    // Demo-only force-resolve: requires the resolver role AND is disabled entirely
    // outside a local/dev chain — even WITH the secret it must never run on Arc.
    if (!resolverAuthorized(req)) return fail(res, 401, "unauthorized");
    if (config.chain !== "local") return fail(res, 403, "disabled outside local/dev");

    const { bundleId } = req.params;
    if (!isValidBundleId(bundleId)) return fail(res, 400, "invalid bundle id");

    const body = (req.body ?? {}) as { leg_id?: unknown; outcome?: unknown };
    const { leg_id, outcome } = body;

    if (typeof leg_id !== "string" || leg_id.length === 0) {
      return fail(res, 400, "missing or invalid field: leg_id");
    }
    if (outcome !== "won" && outcome !== "lost") {
      return fail(res, 400, 'outcome must be "won" or "lost"');
    }

    const resolutionValue = outcome === "won" ? 1.0 : 0.0;

    const updatedLeg = await updateLegResolution(leg_id, outcome, resolutionValue);
    if (!updatedLeg) {
      return fail(res, 404, "leg not found");
    }

    // Check if all legs are now resolved; if so, update the bundle status.
    const allLegs = await getLegsByBundleId(bundleId);
    let bundleFullyResolved = false;
    if (isFullyResolved(allLegs)) {
      await updateBundleStatus(bundleId, "resolved");
      bundleFullyResolved = true;
    }

    return ok(res, {
      bundle_id: bundleId,
      leg: {
        leg_id: updatedLeg.id,
        question: updatedLeg.question,
        status: updatedLeg.status,
        resolution_value: updatedLeg.resolution_value,
      },
      total_legs: allLegs.length,
      resolved_legs: allLegs.filter((l) => l.status !== "active").length,
      bundle_fully_resolved: bundleFullyResolved,
    });
  } catch (err) {
    console.error("POST /api/nav/:bundleId/simulate-resolution error:", err);
    return fail(res, 500, safeError(err));
  }
});

export default router;
