"use client";

import { DynamicWidget } from "@dynamic-labs/sdk-react-core";

/**
 * Wallet control for the app header — Dynamic's native account widget.
 *
 * Logged out → a "Log in / connect" button (email / social / passkey / external wallet).
 * Logged in → an account chip showing the identity + network that opens a **dropdown** with
 * the full wallet management surface (copy address, fund, switch network, send / transfer,
 * view profile, disconnect). This replaces the old custom pill, which only re-triggered the
 * login flow and had no dropdown. All wallet-signed trading still flows through
 * DynamicWagmiConnector unchanged.
 */
export function ConnectButton(_props: { variant?: "header" | "block" }) {
  return (
    <div className="cumulant-connect" style={{ display: "flex" }}>
      <DynamicWidget variant="dropdown" />
    </div>
  );
}

export default ConnectButton;
