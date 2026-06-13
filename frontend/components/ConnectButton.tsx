"use client";

import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { useAccount } from "wagmi";
import { C, FD, EASE } from "@/lib/tokens";

/** Wallet connect button (Dynamic-backed) styled to match the Cumulant header chrome. */
export function ConnectButton() {
  const { primaryWallet, setShowAuthFlow, sdkHasLoaded } = useDynamicContext();
  const { chain } = useAccount();
  const ready = sdkHasLoaded;
  const address = primaryWallet?.address;
  const connected = ready && !!address;

  const pill = (label: string, onClick: () => void, primary = false) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 32,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "0 14px",
        borderRadius: 7,
        border: `0.5px solid ${primary ? C.tealLight : C.border}`,
        background: primary ? C.tealLight : "transparent",
        color: primary ? "#06231f" : C.textPrimary,
        fontFamily: FD,
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
        transition: `all 0.15s ${EASE}`,
      }}
      onMouseEnter={(e) => {
        if (!primary) (e.currentTarget as HTMLElement).style.borderColor = C.borderHover;
      }}
      onMouseLeave={(e) => {
        if (!primary) (e.currentTarget as HTMLElement).style.borderColor = C.border;
      }}
    >
      {label}
    </button>
  );

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }} aria-hidden={!ready}>
      {!connected ? (
        pill("Connect Wallet", () => setShowAuthFlow(true), true)
      ) : (
        <>
          <button
            type="button"
            onClick={() => setShowAuthFlow(true)}
            style={{
              height: 32,
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "0 11px",
              borderRadius: 7,
              border: `0.5px solid ${C.border}`,
              background: "transparent",
              color: C.textSecondary,
              fontFamily: FD,
              fontSize: 12,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.teal }} />
            {chain?.name ?? "Arc Testnet"}
          </button>
          {pill(short(address!), () => setShowAuthFlow(true))}
        </>
      )}
    </div>
  );
}
