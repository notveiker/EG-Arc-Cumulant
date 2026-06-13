"use client";

import React from "react";
import { useAccount } from "wagmi";
import { ConnectButton as RainbowConnect } from "@rainbow-me/rainbowkit";
import { C, FD, FM } from "@/lib/tokens";
import { shortAddr } from "@/lib/format";

/** Prompt card shown on product pages when no wallet is connected — wallet-signed actions
 *  on Cumulant require a connected Arc account. */
export function ConnectWalletCard({
  title,
  subtitle,
  accent,
}: {
  title: string;
  subtitle: string;
  accent?: string;
}) {
  const c = accent ?? C.tealLight;
  const { address, chain } = useAccount();
  return (
    <div
      style={{
        background: C.cardGradient,
        border: `0.5px solid ${C.border}`,
        borderRadius: 14,
        padding: 20,
        boxShadow: "0 4px 14px rgba(0,0,0,0.2)",
      }}
    >
      <div style={{ fontFamily: FD, fontSize: 15, fontWeight: 600, color: C.textPrimary }}>{title}</div>
      <div style={{ marginTop: 8, fontFamily: FM, fontSize: 11, color: C.textSecondary, lineHeight: 1.5 }}>
        {subtitle}
      </div>
      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <RainbowConnect.Custom>
          {({ openConnectModal, mounted }) =>
            mounted && !address ? (
              <button
                type="button"
                onClick={openConnectModal}
                style={{
                  height: 34,
                  padding: "0 16px",
                  borderRadius: 8,
                  border: `0.5px solid ${c}`,
                  background: c,
                  color: "#06231f",
                  fontFamily: FD,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Connect Wallet
              </button>
            ) : (
              <span style={{ fontFamily: FM, fontSize: 11, color: c }}>
                {chain?.name ?? "Circle Arc"} · {address ? shortAddr(address) : "—"}
              </span>
            )
          }
        </RainbowConnect.Custom>
      </div>
    </div>
  );
}
