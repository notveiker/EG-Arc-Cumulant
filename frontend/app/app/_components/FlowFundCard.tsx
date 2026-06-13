"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { C, FD, FM } from "../_lib/tokens";
import { FLOW_ENABLED, checkFlowEligibility, type FlowSettlement } from "../_lib/flow-client";

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
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  if (!FLOW_ENABLED) {
    return (
      <div style={card}>
        <div style={title}>Fund from any chain</div>
        <div style={sub}>
          Pay in USDC on Base, ETH on mainnet, or from an exchange — Dynamic Flow settles it as Arc
          USDC into this product. <span style={{ color: c }}>Enable Flow in the Dynamic dashboard to
          turn this on.</span>
        </div>
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
