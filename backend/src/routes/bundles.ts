import { Router, type Request, type Response } from "express";

/**
 * Synthetic "bundle" directory.
 *
 * There is no persisted bundles table; the
 * basket universe is synthesised CLIENT-SIDE from the live Polymarket feed
 * (see frontend live-baskets), producing 9 stable ids — one per
 * (risk tier × resolution window). The deposit / PPN clients call GET /api/bundles
 * to map a synthetic id (e.g. "PBU-HIGH-SHORT") to a bundle record before they
 * resolve it to an on-chain basket via the EVM adapter (resolveBundleToOnchain).
 *
 * Keeping `id === name === the synthetic label` means resolveBundleUuid* in the
 * clients round-trips the label straight through to /api/deposit/prepare and
 * /api/ppn/onchain/prepare, where it is hashed to an on-chain basketId.
 */
const router = Router();

const TIERS = [
  ["HIGH", 90],
  ["MID", 70],
  ["LOW", 50],
] as const;
const WINDOWS = ["SHORT", "MED", "LONG"] as const;

interface BundleSummary {
  id: string;
  name: string;
  risk_tier: 90 | 70 | 50;
  window: "SHORT" | "MED" | "LONG";
  status: "active";
}

function synthBundles(): BundleSummary[] {
  const out: BundleSummary[] = [];
  for (const [code, tier] of TIERS) {
    for (const w of WINDOWS) {
      const id = `PBU-${code}-${w}`;
      out.push({ id, name: id, risk_tier: tier, window: w, status: "active" });
    }
  }
  return out;
}

// Bare array (the clients read `(await res.json()) as BundleSummary[]`).
router.get("/", (_req: Request, res: Response) => res.json(synthBundles()));

// Register /name/:name before /:id so "name" isn't captured as an id.
router.get("/name/:name", (req: Request, res: Response) => {
  const b = synthBundles().find((x) => x.name === req.params.name);
  if (!b) return res.status(404).json({ ok: false, error: "unknown bundle" });
  res.json(b);
});

router.get("/:id", (req: Request, res: Response) => {
  const b = synthBundles().find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ ok: false, error: "unknown bundle" });
  res.json(b);
});

export default router;
