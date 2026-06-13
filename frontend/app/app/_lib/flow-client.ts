"use client";

/**
 * Dynamic Flow client — cross-chain / exchange funding that settles as Arc USDC.
 *
 * The on-ramp itself runs in Dynamic's UI (opened via the auth/funding flow once Flow
 * is enabled in the dashboard). Settlement is confirmed server-side by an HMAC-verified
 * webhook (`backend/src/routes/flow.ts`), which records eligibility. This module reads
 * that eligibility so a product page can UNLOCK the on-chain deposit the user signs
 * themselves. Gated by `NEXT_PUBLIC_DYNAMIC_FLOW_ENABLED` so it's inert until configured.
 */
import { BACKEND_URL } from "./tokens";

export const FLOW_ENABLED = (process.env.NEXT_PUBLIC_DYNAMIC_FLOW_ENABLED ?? "") === "true";

export interface FlowSettlement {
  wallet: string;
  bundle: string;
  amountUsdc: number;
  reference: string;
  at: number;
}

export async function flowStatus(): Promise<{ webhookConfigured: boolean }> {
  try {
    const r = await fetch(`${BACKEND_URL}/api/flow/status`, { cache: "no-store" });
    const j = await r.json();
    return (j?.data as { webhookConfigured: boolean }) ?? { webhookConfigured: false };
  } catch {
    return { webhookConfigured: false };
  }
}

/** Returns the recorded Flow settlement for this wallet+bundle, or null if none yet. */
export async function checkFlowEligibility(
  wallet: string,
  bundle: string,
): Promise<FlowSettlement | null> {
  if (!wallet || !bundle) return null;
  try {
    const r = await fetch(
      `${BACKEND_URL}/api/flow/eligibility/${encodeURIComponent(wallet)}/${encodeURIComponent(bundle)}`,
      { cache: "no-store" },
    );
    const j = await r.json();
    return (j?.data?.settlement as FlowSettlement | null) ?? null;
  } catch {
    return null;
  }
}
