"use client";

import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { useAccount } from "wagmi";
import { useDynamicIdentity } from "../_lib/dynamic-identity";
import { C, FM, EASE } from "../_lib/tokens";

/**
 * Arc (EVM) wallet connect — backed by Dynamic (email / social / passkey / external
 * wallet + embedded wallets), bridged into wagmi via DynamicWagmiConnector so every
 * wallet-signed Cumulant action in `lib/tx.ts` keeps working unchanged. Styled to the
 * 32px Tidal header chrome (replaces the prior RainbowKit ConnectButton).
 *
 * Disconnected → opens Dynamic's login flow (`setShowAuthFlow`). Connected → shows the
 * active chain + address; tapping the address re-opens the Dynamic widget to manage /
 * disconnect. The address resolves from `primaryWallet`; the chain from wagmi.
 */
export function ConnectButton(_props: { variant?: "header" | "block" }) {
  const { primaryWallet, setShowAuthFlow, sdkHasLoaded } = useDynamicContext();
  const { chain } = useAccount();
  const id = useDynamicIdentity();
  const ready = sdkHasLoaded;
  const address = primaryWallet?.address;
  const connected = ready && !!address;

  const baseStyle: React.CSSProperties = {
    height: 32,
    minHeight: 32,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "0 12px",
    borderRadius: 8,
    border: `0.5px solid ${C.border}`,
    background: C.surface,
    color: C.textSecondary,
    fontFamily: FM,
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.02em",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxShadow: "none",
    transition: `all 0.15s ${EASE}`,
  };

  const pill = (label: string, onClick: () => void, primary = false) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...baseStyle,
        border: `0.5px solid ${primary ? `${C.tealLight}55` : C.border}`,
        color: primary ? C.textPrimary : C.textSecondary,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.color = C.textPrimary;
        (e.currentTarget as HTMLElement).style.borderColor = `${C.tealLight}55`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color = primary ? C.textPrimary : C.textSecondary;
        (e.currentTarget as HTMLElement).style.borderColor = primary ? `${C.tealLight}55` : C.border;
      }}
    >
      {label}
    </button>
  );

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  return (
    <div className="cumulant-connect" style={{ display: "flex" }} aria-hidden={!ready}>
      {!connected ? (
        pill("Connect Wallet", () => setShowAuthFlow(true), true)
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setShowAuthFlow(true)}
            style={baseStyle}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = C.textPrimary;
              (e.currentTarget as HTMLElement).style.borderColor = `${C.tealLight}55`;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = C.textSecondary;
              (e.currentTarget as HTMLElement).style.borderColor = C.border;
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.teal }} />
            {chain?.name ?? "Arc Testnet"}
          </button>
          {pill(id.displayName ?? short(address!), () => setShowAuthFlow(true))}
          {id.walletCount > 1 && (
            <span
              title={`${id.walletCount} linked wallets`}
              style={{ ...baseStyle, padding: "0 8px", color: C.teal }}
            >
              +{id.walletCount - 1}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default ConnectButton;
