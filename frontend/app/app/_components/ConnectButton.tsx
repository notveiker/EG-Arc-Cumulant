"use client";

import { ConnectButton as RainbowConnect } from "@rainbow-me/rainbowkit";
import { C, FM, EASE } from "../_lib/tokens";

/**
 * Real Arc (EVM) wallet connect (RainbowKit). Renders a "Connect Wallet" control
 * that opens the wallet picker and, once connected, shows the active chain + the
 * account, each opening RainbowKit's account/chain modals.
 *
 * Ported from the Cumulant the wallet SDK version: the controls are sized to sit in the
 * 32px header chrome alongside the FaucetButton (32px tall, 8px radius, surface
 * bg, 11px mono, Tidal palette) rather than RainbowKit's oversized default pills.
 * We render via RainbowKit's headless `Custom` so every control is styled inline
 * with the same tokens — no portal-scoped CSS overrides needed.
 */
export function ConnectButton(_props: { variant?: "header" | "block" }) {
  return (
    <div className="cumulant-connect" style={{ display: "flex" }}>
      <RainbowConnect.Custom>
        {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
          const ready = mounted;
          const connected = ready && account && chain;

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
                (e.currentTarget as HTMLElement).style.color = primary
                  ? C.textPrimary
                  : C.textSecondary;
                (e.currentTarget as HTMLElement).style.borderColor = primary
                  ? `${C.tealLight}55`
                  : C.border;
              }}
            >
              {label}
            </button>
          );

          return (
            <div
              style={{ display: "flex", gap: 6, alignItems: "center" }}
              aria-hidden={!ready}
            >
              {!connected
                ? pill("Connect Wallet", openConnectModal, true)
                : chain.unsupported
                  ? pill("Wrong network", openChainModal)
                  : (
                    <>
                      <button
                        type="button"
                        onClick={openChainModal}
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
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: C.teal,
                          }}
                        />
                        {chain.name}
                      </button>
                      {pill(account.displayName, openAccountModal)}
                    </>
                  )}
            </div>
          );
        }}
      </RainbowConnect.Custom>
    </div>
  );
}

export default ConnectButton;
