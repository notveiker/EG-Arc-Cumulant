"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { C, FD, FM } from "../_lib/tokens";
import { FLOW_ENABLED, checkFlowEligibility, flowStatus, type FlowSettlement } from "../_lib/flow-client";

/**
 * "Fund from any chain" — Dynamic Flow on-ramp entry for a Cumulant product.
 *
 * A user can pay with any token on any chain (or an exchange); Flow settles it as Arc
 * USDC, our HMAC-verified webhook records the settlement, and this card unlocks the
 * on-chain deposit (which the user still signs with their own Dynamic wallet). It polls
 * `/api/flow/eligibility` while a funding attempt is open and calls `onSettled` once the
 * deposit is unlocked. Inert (informational) until `NEXT_PUBLIC_DYNAMIC_FLOW_ENABLED`.
 */
export function FlowFundCard({
  wallet,
  bundle,
  onSettled,
  accent,
}: {
  wallet?: string;
  bundle: string;
  onSettled?: (s: FlowSettlement) => void;
  accent?: string;
}) {
  const c = accent ?? C.tealLight;
  const { setShowAuthFlow } = useDynamicContext();
  const [settlement, setSettlement] = useState<FlowSettlement | null>(null);
  const [polling, setPolling] = useState(false);
  // Live backend readiness: null = still checking, false = webhook not configured.
  // Flow is only truly usable when the env flag is on AND the backend's
  // HMAC webhook is wired up (otherwise the funding flow leads nowhere).
  const [webhookReady, setWebhookReady] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!FLOW_ENABLED) {
      setWebhookReady(false);
      return;
    }
    let cancelled = false;
    flowStatus()
      .then((s) => {
        if (!cancelled) setWebhookReady(s.webhookConfigured);
      })
      .catch(() => {
        if (!cancelled) setWebhookReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const flowLive = FLOW_ENABLED && webhookReady === true;

  const poll = useCallback(async () => {
    if (!wallet) return;
    const s = await checkFlowEligibility(wallet, bundle);
    if (s) {
      setSettlement(s);
      onSettled?.(s);
      setPolling(false);
    }
  }, [wallet, bundle, onSettled]);

  useEffect(() => {
    void poll();
  }, [poll]);

  useEffect(() => {
    if (!polling) {
      if (timer.current) clearInterval(timer.current);
      return;
    }
    timer.current = setInterval(() => void poll(), 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [polling, poll]);

  const card: React.CSSProperties = {
    background: C.cardGradient,
    border: `0.5px solid ${C.border}`,
    borderRadius: 12,
    padding: 16,
  };
  const title: React.CSSProperties = { fontFamily: FD, fontSize: 13, fontWeight: 600, color: C.textPrimary };
  const sub: React.CSSProperties = {
    marginTop: 6,
    fontFamily: FM,
    fontSize: 11,
    color: C.textSecondary,
    lineHeight: 1.55,
  };

  if (settlement) {
    return (
      <div style={card}>
        <div style={{ ...title, color: c }}>✓ Funded via Flow</div>
        <div style={sub}>
          {settlement.amountUsdc ? `$${settlement.amountUsdc} ` : ""}settled as Arc USDC — your on-chain
          deposit below is unlocked.
        </div>
      </div>
    );
  }

  // Not live: either the env flag is off, the backend Flow webhook isn't
  // configured, or we're still checking. Render the card visibly disabled with a
  // short "coming soon / not configured" note and no clickable button — so a user
  // can never click through to a flow that leads nowhere.
  if (!flowLive) {
    const checking = FLOW_ENABLED && webhookReady === null;
    return (
      <div style={{ ...card, opacity: 0.85 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={title}>Fund from any chain</span>
          <span
            style={{
              fontFamily: FM,
              fontSize: 9.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: C.textMuted,
              border: `0.5px solid ${C.border}`,
              borderRadius: 999,
              padding: "2px 8px",
            }}
          >
            {checking ? "Checking…" : "Coming soon"}
          </span>
        </div>
        <div style={sub}>
          Pay in USDC on Base, ETH on mainnet, or from an exchange — Dynamic Flow settles it as Arc
          USDC into this product.{" "}
          <span style={{ color: C.textMuted }}>
            {checking ? "Checking availability…" : "Cross-chain funding isn’t configured yet."}
          </span>
        </div>
        <button
          type="button"
          disabled
          aria-disabled
          style={{
            marginTop: 12,
            height: 34,
            padding: "0 16px",
            borderRadius: 8,
            border: `0.5px solid ${C.border}`,
            background: "transparent",
            color: C.textMuted,
            fontFamily: FD,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "not-allowed",
          }}
        >
          {checking ? "Checking…" : "Not available yet"}
        </button>
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={title}>Fund from any chain</div>
      <div style={sub}>Pay with any token on any chain; Flow settles it as Arc USDC into this product.</div>
      <button
        type="button"
        disabled={!wallet}
        onClick={() => {
          setShowAuthFlow(true);
          setPolling(true);
        }}
        style={{
          marginTop: 12,
          height: 34,
          padding: "0 16px",
          borderRadius: 8,
          border: `0.5px solid ${c}`,
          background: wallet ? c : "transparent",
          color: wallet ? "#06231f" : C.textSecondary,
          fontFamily: FD,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: wallet ? "pointer" : "not-allowed",
        }}
      >
        {wallet ? "Fund from any chain →" : "Connect a wallet first"}
      </button>
    </div>
  );
}

export default FlowFundCard;
