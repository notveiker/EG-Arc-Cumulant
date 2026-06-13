"use client";

import React from "react";
import { C, FD, FM } from "../_lib/tokens";
import { ACTIVE_ADDRESS, shortAddress } from "../_lib/chain";

export function ConnectWalletCard({
  title,
  subtitle,
  accent,
  contractAddress,
}: {
  title: string;
  subtitle: string;
  accent?: string;
  contractAddress?: string;
}) {
  const c = accent ?? C.tealLight;
  return (
    <div
      style={{
        background: C.card,
        border: `0.5px solid ${C.border}`,
        borderRadius: 14,
        padding: 20,
      }}
    >
      <div style={{ fontFamily: FD, fontSize: 15, color: C.textPrimary }}>
        {title}
      </div>
      <div style={{ marginTop: 8, fontFamily: FM, fontSize: 11, color: C.textSecondary }}>
        {subtitle}
      </div>
      <div style={{ marginTop: 14, fontFamily: FM, fontSize: 11, color: c }}>
        Arc testnet · {ACTIVE_ADDRESS ? shortAddress(ACTIVE_ADDRESS) : "local signer"}
      </div>
      {contractAddress && (
        <div style={{ marginTop: 8, fontFamily: FM, fontSize: 10, color: C.textMuted }}>
          {shortAddress(contractAddress)}
        </div>
      )}
    </div>
  );
}
