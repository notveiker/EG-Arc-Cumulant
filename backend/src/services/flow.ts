/**
 * Dynamic Flow (Fireblocks Flow) settlement tracking.
 *
 * Flow lets a user fund a Cumulant product with any token on any chain (or from an
 * exchange) and settle it as Arc USDC. Dynamic confirms settlement by POSTing an
 * HMAC-signed webhook to us. We verify the signature, record the settlement, and
 * expose an eligibility check so the frontend can UNLOCK the on-chain vault deposit
 * for that wallet + bundle.
 *
 * Trust model: this NEVER signs anything on-chain and never touches the resolver
 * role. It only records "this wallet's cross-chain deposit for this bundle settled",
 * which gates a deposit the USER still signs with their own (Dynamic) wallet.
 *
 * Webhook signature scheme (Dynamic docs · recipes/webhooks-signature-validation):
 *   header `x-dynamic-signature: sha256=<hex>` = HMAC-SHA256(secret, JSON.stringify(body)).
 *   Secret = the webhook signing secret from the Dynamic dashboard → env
 *   `DYNAMIC_WEBHOOK_SECRET` (never commit it).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** A settled cross-chain Flow deposit, recorded from a verified Dynamic webhook. */
export interface FlowSettlement {
  wallet: string;
  bundle: string;
  amountUsdc: number;
  reference: string;
  at: number;
}

/** In-memory eligibility ledger, keyed by `${wallet}:${bundle}` (lowercased). Off-chain
 *  indexing only — safe to lose; the real value (the Arc USDC) lives in the user's wallet. */
const settlements = new Map<string, FlowSettlement>();
const keyOf = (wallet: string, bundle: string) => `${wallet.toLowerCase()}:${bundle.toLowerCase()}`;

export function webhookConfigured(): boolean {
  return Boolean(process.env.DYNAMIC_WEBHOOK_SECRET?.trim());
}

/**
 * Verify a Dynamic webhook HMAC-SHA256 signature over the JSON body. Returns false
 * (fail-closed) when the secret or signature is missing or the digest doesn't match.
 */
export function verifyWebhookSignature(signature: string | undefined, payload: unknown): boolean {
  const secret = process.env.DYNAMIC_WEBHOOK_SECRET?.trim();
  if (!secret || !signature) return false;
  const digest = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  const trusted = Buffer.from(`sha256=${digest}`, "ascii");
  const untrusted = Buffer.from(signature, "ascii");
  // timingSafeEqual throws on length mismatch — guard first.
  if (trusted.length !== untrusted.length) return false;
  return timingSafeEqual(trusted, untrusted);
}

export function recordSettlement(s: FlowSettlement): void {
  settlements.set(keyOf(s.wallet, s.bundle), s);
}

export function getEligibility(wallet: string, bundle: string): FlowSettlement | null {
  if (!wallet || !bundle) return null;
  return settlements.get(keyOf(wallet, bundle)) ?? null;
}
