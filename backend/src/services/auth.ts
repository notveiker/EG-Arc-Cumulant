/**
 * Auth helpers for mutating/admin routes.
 *
 * Two schemes:
 *  - resolverAuthorized: server-owned admin actions (seeding, NAV resolution) gated
 *    by a Bearer RESOLVER_API_SECRET, constant-time compared, FAIL-CLOSED on a public
 *    chain (an unset secret rejects everywhere except a local dev chain).
 *  - verifyWalletAuth: user actions where "owner + id in the POST body" is NOT
 *    authentication — the caller must prove control of `owner` by signing a canonical
 *    message. We recover the signer and require it equals `owner` with a live deadline.
 *    Fail-closed on a public chain (an unsigned request is allowed only on local dev).
 */
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { config } from "../config.js";

/** Bearer RESOLVER_API_SECRET; fail-closed on public chains when the secret is unset. */
export function resolverAuthorized(req: Request): boolean {
  const secret = process.env.RESOLVER_API_SECRET;
  if (!secret) return config.chain === "local";
  const provided = req.get("authorization") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Canonical message a wallet signs to authorize an action on one of its positions. */
export function walletAuthMessage(action: string, ref: string, deadline: number): string {
  return `Cumulant authorize\naction: ${action}\nref: ${ref}\ndeadline: ${deadline}`;
}

/**
 * Verify a wallet-signed authorization: `signature` over walletAuthMessage(action,
 * ref, deadline) must recover to `owner`, with the deadline still in the future. On a
 * public chain an unsigned request is rejected; on local dev it's allowed (so the
 * dev loop isn't blocked). `ref` is typically the position id.
 */
export async function verifyWalletAuth(args: {
  owner: string;
  action: string;
  ref: string;
  deadline?: number;
  signature?: string;
}): Promise<boolean> {
  if (!args.signature || !args.deadline) return config.chain === "local";
  if (!args.owner) return false;
  if (args.deadline < Math.floor(Date.now() / 1000)) return false;
  try {
    const recovered = await recoverMessageAddress({
      message: walletAuthMessage(args.action, args.ref, args.deadline),
      signature: args.signature as `0x${string}`,
    });
    return recovered.toLowerCase() === args.owner.toLowerCase();
  } catch {
    return false;
  }
}
