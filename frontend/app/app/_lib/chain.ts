"use client";

/**
 * Chain identity + explorer helpers for the Cumulant app shell (Circle Arc / EVM).
 *
 * The function NAMES are kept Arc-compatible (`arcscanTxUrl`, …) so the call
 * sites ported over from the original app compile unchanged; the implementations
 * point at Arcscan and the Arc/EVM world.
 */
import { ACTIVE_CHAIN, explorerTx } from "@/lib/chains";

export const CHAIN = (process.env.NEXT_PUBLIC_CHAIN ?? "arc").toLowerCase();
export const IS_LEGACY = false;
export const IS_ARC = true;

export const ARC_NETWORK = ACTIVE_CHAIN.testnet ? "testnet" : "mainnet";
// Compat alias — some ported libs reference NETWORK_NAME / ACTIVE_ADDRESS.
export const NETWORK_NAME = ARC_NETWORK;
export const ACTIVE_ADDRESS = "";

const EXPLORER =
  ACTIVE_CHAIN.blockExplorers?.default.url ??
  process.env.NEXT_PUBLIC_ARC_EXPLORER ??
  "https://testnet.arcscan.app";

export function shortAddress(address: string): string {
  if (!address) return address;
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Arc (Arcscan) tx URL. Name kept Arc-compatible for ported call sites. */
export function arcscanTxUrl(hash: string): string {
  return explorerTx(hash);
}

/** Arc (Arcscan) address URL. Name kept Arc-compatible for ported call sites. */
export function arcscanAddressUrl(addr: string): string {
  return EXPLORER ? `${EXPLORER}/address/${addr}` : "#";
}

export const explorerTxUrl = arcscanTxUrl;
export const explorerAddressUrl = arcscanAddressUrl;

/**
 * Map a raw wallet/RPC signing error to a clear, actionable message.
 *
 * "User rejected"/"denied" come from the WALLET (MetaMask/Rabbit/etc.) when the
 * user cancels — surface it plainly. Insufficient-funds is passed through.
 * Opaque/empty errors get generic, wallet-agnostic recovery guidance. The dApp
 * only ever requests a signature; it never sees a wallet password.
 */
export function friendlyWalletError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  let msg = raw;
  if (!msg) {
    try {
      msg = JSON.stringify(err) ?? "";
    } catch {
      msg = "";
    }
  }
  // Our own signer-timeout message is already user-ready and actionable
  // (embedded-wallet rate-limit hint) — pass it through verbatim before the
  // generic "couldn't sign" fallback can swallow it.
  if (/didn't return a signature/i.test(msg)) {
    return msg.split("\n")[0];
  }
  if (/user rejected|rejected the request|user denied|user cancel|rejection|denied transaction/i.test(msg)) {
    return "Transaction was rejected in your wallet.";
  }
  if (/insufficient funds|insufficient balance|exceeds balance|transfer amount exceeds/i.test(msg)) {
    return msg.split("\n")[0];
  }
  // Known protocol custom errors → plain language. These reach the client as a
  // viem-decoded custom-error name (with the contract ABI) or inside the revert
  // reason string, so a name match covers both.
  const CUSTOM_ERRORS: Array<[RegExp, string]> = [
    [/NotSettled/i, "This position can't be redeemed yet — it opens once the underlying market settles."],
    [/AlreadySettled/i, "This position has already settled."],
    [/MarketClosed/i, "This market has closed to new deposits."],
    [/NotResolved/i, "The underlying market hasn't resolved yet."],
    [/InsufficientShares/i, "You don't hold enough shares for that amount."],
    [/DepositTooSmall/i, "Deposit is too small to spread across the tranche legs — try a larger amount."],
    [/NothingDeposited|NothingToClaim|NothingToReclaim/i, "There's no position here to redeem."],
  ];
  for (const [re, friendly] of CUSTOM_ERRORS) {
    if (re.test(msg)) return friendly;
  }
  // A contract revert reason is useful — keep it short.
  const revert = /(execution reverted|reverted)[:.]?\s*([^\n]{0,140})/i.exec(msg);
  if (revert && revert[2]?.trim()) return `Transaction reverted: ${revert[2].trim()}`;
  if (
    !msg ||
    msg === "{}" ||
    msg === "[object Object]" ||
    /locked|could not|failed to|sign|chain mismatch|wrong network/i.test(msg)
  ) {
    return "Your wallet couldn't sign the transaction. Try again — and if it persists, disconnect and reconnect your wallet. Make sure the wallet is on Arc testnet.";
  }
  return msg.split("\n")[0];
}
