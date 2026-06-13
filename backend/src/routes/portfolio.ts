import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { isAddress, getAddress } from "viem";
import { constructPortfolio, type PortfolioRequest } from "../services/portfolio.js";
import { getPortfolio } from "../contracts.js";

const router = Router();

const RequestSchema = z.object({
  risk_pct: z.number().finite().min(0).max(100),
  capital_usd: z.number().finite().positive().max(100_000),
  objective: z
    .enum(["income", "speculation", "balanced"])
    .optional()
    .default("balanced"),
  horizon: z
    .enum(["short", "medium", "long"])
    .optional()
    .default("medium"),
  // Optional client-picked reference basket. When the frontend passes this,
  // the backend skips its Supabase lookup and uses these values directly so
  // recommendations link to a basket the frontend can actually resolve.
  basket: z
    .object({
      id: z.string().min(1).max(128),
      name: z.string().min(1).max(128),
      risk_tier: z.number().finite().min(0).max(100),
      nav: z.number().finite().min(0).max(1),
      // Days / legs are positive numbers (not strictly integers) so live
      // baskets with fractional days-to-resolution don't 400 the request.
      days: z.number().finite().min(0.5).max(365),
      legs: z.number().finite().min(1).max(500),
    })
    .optional(),
});

/**
 * Sanitize a thrown error into a short, safe message. Never leaks stack traces,
 * internal URLs, viem/RPC dumps, or raw EVM addresses to the client.
 */
function safeError(err: unknown): string {
  if (!(err instanceof Error)) return "internal error";
  const first = err.message.split("\n")[0]?.slice(0, 160) ?? "internal error";
  return /https?:\/\/|viem@|Request Arguments|0x[0-9a-f]{40,}/i.test(first)
    ? "internal error"
    : first;
}

/**
 * POST /api/portfolio/construct
 * Body: { risk_pct: 0-100, capital_usd: number, objective?: "income"|"speculation"|"balanced",
 *         horizon?: "short"|"medium"|"long", basket?: {...} }
 *
 * Returns a deterministic, heuristic allocation across tranches drawn from the
 * live Cumulant primitive surface (live tranche quotes + curated Polymarket
 * book). Off-chain only — no on-chain side effects, no LLM. The response is the
 * raw PortfolioResponse the frontend expects (allocations, summary, expected
 * APY band, risk score), not the { ok, data } envelope.
 */
router.post("/construct", async (req: Request, res: Response) => {
  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "validation",
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await constructPortfolio(parsed.data as PortfolioRequest);
    return res.json(result);
  } catch (err: unknown) {
    // Validation failures from the service layer (weights don't sum, missing
    // tranche quotes, capital cap, etc.). The heuristic composer is fully
    // deterministic and runs in-process, so there are no upstream LLM/timeout
    // failure modes to map — anything thrown here is a composer error.
    const msg = safeError(err);
    console.error("[POST /api/portfolio/construct]", err);
    return res.status(502).json({ error: "composer", message: msg });
  }
});

/**
 * GET /api/portfolio/:address
 * Live on-chain portfolio for an EVM address: the wallet's real prediction-market
 * / vault positions read straight off Arc. Returns the { ok, data } envelope. This
 * coexists with POST /construct on the same mount; registering /construct above
 * keeps the literal subpath from being captured by this :address param route.
 */
router.get("/:address", async (req: Request, res: Response) => {
  const addr = req.params.address;
  if (!isAddress(addr)) {
    return res.status(400).json({ ok: false, error: "invalid address" });
  }
  try {
    const data = await getPortfolio(getAddress(addr));
    return res.json({ ok: true, data });
  } catch (err: unknown) {
    console.error("[GET /api/portfolio/:address]", err);
    return res.status(500).json({ ok: false, error: safeError(err) });
  }
});

export default router;
