"use client";

import { useState } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { C, FM, BACKEND_URL } from "../_lib/tokens";

/**
 * One-click test-USDC faucet in the header. Mints 10,000 test USDC to the connected
 * Dynamic wallet via the backend (deployer-signed, so the user needs no gas), then pops
 * a bottom toast with a live Arcscan link. Replaces the redundant TESTNET badge — the
 * chain chip already shows the network.
 */
export function FaucetButton() {
  const { primaryWallet, setShowAuthFlow } = useDynamicContext();
  const address = primaryWallet?.address;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ explorerUrl: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function mint() {
    if (!address) {
      setShowAuthFlow(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${BACKEND_URL}/api/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "mint failed");
      setToast({ explorerUrl: j.data.explorerUrl as string });
      window.setTimeout(() => setToast(null), 9000);
    } catch (e) {
      setErr((e as Error).message);
      window.setTimeout(() => setErr(null), 6000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={mint}
        disabled={busy}
        title={address ? "Mint 10,000 test USDC to your wallet" : "Connect a wallet to mint test USDC"}
        style={{
          height: 32,
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          padding: "0 12px",
          borderRadius: 8,
          border: `0.5px solid ${C.border}`,
          background: C.surface,
          color: C.textSecondary,
          fontFamily: FM,
          fontSize: 11,
          letterSpacing: "0.04em",
          whiteSpace: "nowrap",
          cursor: busy ? "default" : "pointer",
          transition: "color 0.15s ease, border-color 0.15s ease",
        }}
        onMouseEnter={(e) => {
          if (busy) return;
          (e.currentTarget as HTMLElement).style.borderColor = `${C.tealLight}66`;
          (e.currentTarget as HTMLElement).style.color = C.textPrimary;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = C.border;
          (e.currentTarget as HTMLElement).style.color = C.textSecondary;
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: C.tealLight,
            boxShadow: `0 0 6px ${C.tealLight}`,
            opacity: busy ? 0.4 : 1,
          }}
        />
        {busy ? "Minting…" : "Mint 10k USDC"}
      </button>

      {(toast || err) && (
        <div
          role="status"
          style={{
            position: "fixed",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "12px 16px",
            borderRadius: 12,
            background: C.cardGradientStrong,
            border: `0.5px solid ${err ? C.border : `${C.tealLight}44`}`,
            boxShadow: "0 16px 44px rgba(0,0,0,0.5)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            fontFamily: FM,
            fontSize: 12.5,
            maxWidth: "min(92vw, 460px)",
          }}
        >
          {err ? (
            <span style={{ color: C.textSecondary }}>Faucet failed — {err}</span>
          ) : (
            <>
              <span
                style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, boxShadow: `0 0 8px ${C.green}` }}
              />
              <span style={{ color: C.textPrimary }}>10,000 test USDC minted</span>
              <a
                href={toast!.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: C.tealLight, textDecoration: "none", fontWeight: 600, whiteSpace: "nowrap" }}
              >
                View on Arcscan →
              </a>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setToast(null);
              setErr(null);
            }}
            aria-label="Dismiss"
            style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

export default FaucetButton;
