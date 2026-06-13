/**
 * Dynamic Flow routes — confirm cross-chain/exchange deposits that settle as Arc USDC,
 * and gate the on-chain vault deposit on that settlement.
 *
 *   POST /api/flow/webhook              HMAC-verified settlement event from Dynamic
 *   GET  /api/flow/eligibility/:w/:b    has wallet `w`'s Flow deposit for bundle `b` settled?
 *   GET  /api/flow/status               is the webhook wired? (frontend feature gate)
 *
 * No on-chain signing happens here — the user still signs the deposit with their own
 * Dynamic wallet. This only records "the cross-chain funds arrived as Arc USDC".
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import {
  verifyWebhookSignature,
  webhookConfigured,
  recordSettlement,
  getEligibility,
  type FlowSettlement,
} from "../services/flow.js";

const router = Router();

const ok = <T>(res: Response, data: T) => res.json({ ok: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

router.post("/webhook", (req: Request, res: Response) => {
  // Fail-closed posture (mirrors the resolver): a configured secret MUST verify; an
  // unconfigured secret is accepted ONLY on local dev, never on a public chain (Arc).
  if (webhookConfigured()) {
    const signature = req.headers["x-dynamic-signature"] as string | undefined;
    if (!verifyWebhookSignature(signature, req.body)) {
      return fail(res, 401, "invalid signature");
    }
  } else if (config.chain !== "local") {
    return fail(res, 503, "Flow webhook not configured");
  }

  // Tolerant extraction. Dynamic Flow emits a checkout/settlement event; we read the
  // destination wallet, the settled USDC amount, and the bundle we tag onto the
  // checkout's metadata. Field names are centralized here so they're trivial to
  // reconcile against the live event shape once Flow is enabled in the dashboard.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data = (body.data ?? body) as Record<string, unknown>;
  const md = (data.metadata ?? {}) as Record<string, unknown>;
  const wallet = String(data.destinationAddress ?? data.walletAddress ?? data.address ?? "");
  const bundle = String(md.bundle ?? md.bundleId ?? data.reference ?? "");
  const amountUsdc = Number(data.settlementAmount ?? data.amount ?? 0);
  const state = String(data.settlementState ?? data.status ?? body.eventName ?? body.type ?? "");
  const settled = /complete|settled|success|paid/i.test(state);

  if (settled && wallet && bundle) {
    const rec: FlowSettlement = {
      wallet,
      bundle,
      amountUsdc,
      reference: String(data.id ?? data.transactionId ?? ""),
      at: Date.now(),
    };
    recordSettlement(rec);
    return ok(res, { recorded: true, wallet, bundle, amountUsdc });
  }
  // Acknowledge non-terminal / unrecognized events (200) so Dynamic doesn't retry forever.
  return ok(res, { recorded: false, state });
});

router.get("/eligibility/:wallet/:bundle", (req: Request, res: Response) => {
  const settlement = getEligibility(req.params.wallet, req.params.bundle);
  return ok(res, { eligible: Boolean(settlement), settlement });
});

router.get("/status", (_req: Request, res: Response) => {
  return ok(res, { webhookConfigured: webhookConfigured() });
});

export default router;
