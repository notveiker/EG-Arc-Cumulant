"use client";

import { useLinkedPortfolio } from "../_lib/linked-portfolio";
import { C, FD, FM } from "../_lib/tokens";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Cross-wallet Cumulant book. Renders only when the user's Dynamic identity has 2+
 * linked wallets — showing the combined USDC + position count and a per-wallet
 * breakdown. Makes the multi-wallet identity tangible against the on-chain base layer.
 */
export function LinkedWalletsCard() {
  const { wallets, walletCount, totalUsdc, totalPositions, loading } = useLinkedPortfolio();
  if (walletCount < 2) return null; // single-wallet users see the normal portfolio

  return (
    <div
      style={{
        background: C.cardGradient,
        border: `0.5px solid ${C.border}`,
        borderRadius: 14,
        padding: 18,
        marginBottom: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontFamily: FD, fontSize: 14, fontWeight: 600, color: C.textPrimary }}>
          Your Cumulant book · {walletCount} linked wallets
        </div>
        <div style={{ fontFamily: FM, fontSize: 11, color: C.textSecondary }}>
          {loading ? "aggregating…" : `${usd(totalUsdc)} · ${totalPositions} positions`}
        </div>
      </div>
      <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
        {wallets.map((w) => (
          <div
            key={w.address}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: FM,
              fontSize: 11,
              color: C.textSecondary,
              borderTop: `0.5px solid ${C.border}`,
              paddingTop: 6,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.teal }} />
              {short(w.address)}
            </span>
            <span>
              {usd(w.usdc)} · {w.positions} pos
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, fontFamily: FM, fontSize: 10, color: C.textSecondary }}>
        Aggregated across every wallet linked to your Dynamic identity.
      </div>
    </div>
  );
}

export default LinkedWalletsCard;
