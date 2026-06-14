"use client";

import { useActiveWalletAddress, useUsdcBalance } from "../_lib/wallet-bridge";
import { C, FM } from "../_lib/tokens";

/**
 * Header chip showing the connected wallet's LIVE USDC balance on Arc testnet.
 * Replaces the one-shot "Mint 10k USDC" faucet button in the header — minting is
 * a once-per-demo action that now lives on the Portfolio page, while the header
 * surfaces the always-relevant live balance. Renders nothing when disconnected
 * (the adjacent Connect button covers that state).
 */
export function UsdcBalancePill() {
  const address = useActiveWalletAddress();
  const { uiAmount } = useUsdcBalance();
  if (!address) return null;
  return (
    <div
      title="Your live USDC balance on Arc testnet"
      style={{
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "0 12px",
        borderRadius: 8,
        border: `0.5px solid ${C.border}`,
        background: C.surface,
        color: C.textPrimary,
        fontFamily: FM,
        fontSize: 11.5,
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: C.tealLight,
          boxShadow: `0 0 6px ${C.tealLight}`,
        }}
      />
      ${uiAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      <span style={{ color: C.textMuted }}>USDC</span>
    </div>
  );
}

export default UsdcBalancePill;
