/**
 * Test-USDC faucet — mints 10,000 freely-mintable MockUSDC to the caller's connected
 * (Dynamic) wallet so demos aren't gated on the $20 Arc testnet faucet, AND tops the
 * wallet up with a little native Arc gas if it's empty, so a brand-new wallet can buy /
 * sell immediately without a separate trip to faucet.circle.com.
 *
 * Server-signed with the deployer/resolver key. MockUSDC.mint() is public on-chain, so
 * this exposes nothing not already callable by anyone — it just pays the gas for the
 * user. Testnet only; does not touch product trust or resolver semantics. Returns the
 * mint tx hash (+ optional gas tx hash) + a live explorer link for the UI toast.
 */
import { Router, type Request, type Response } from "express";
import { isAddress, getAddress, parseUnits, parseEther } from "viem";
import { config, explorerTx } from "../config.js";
import { publicClient, resolverWallet } from "../chain.js";

const router = Router();
const ok = <T>(res: Response, data: T) => res.json({ ok: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

const FAUCET_AMOUNT = parseUnits("10000", 6); // 10,000 test USDC (6 decimals)
// Native Arc gas top-up for a fresh wallet (Arc native = USDC, 18-dec accounting).
// Enough for several buys/sells; only sent when the wallet is essentially empty so we
// don't drain the resolver re-funding wallets that already have gas.
const GAS_GRANT = parseEther("0.04");
const GAS_MIN_USER = parseEther("0.01"); // top up only below this
const GAS_RESOLVER_FLOOR = parseEther("0.02"); // never spend the resolver below this

// ── Abuse controls (in-memory; per-process, no DB) ──────────────────────────
// A given wallet can only be served once per WALLET_COOLDOWN_MS, and a given IP
// is capped to one request per IP_COOLDOWN_MS — so a brand-new wallet can demo
// freely but a script can't loop the mint. The native-gas top-up draws from a
// per-process budget (GAS_BUDGET total); once exhausted we keep minting USDC but
// stop sending native gas, so a drain attack can never empty the resolver.
const WALLET_COOLDOWN_MS = 60_000; // one mint per wallet / minute
const IP_COOLDOWN_MS = 30_000; // one request per IP / 30s
const GAS_BUDGET = parseEther("2"); // total native gas this process will grant
const lastServedByWallet = new Map<string, number>();
const lastServedByIp = new Map<string, number>();
let gasGrantedTotal = 0n; // cumulative native gas granted this process

/** Prune stale cooldown entries so the maps can't grow unbounded over a long run. */
function prune(map: Map<string, number>, windowMs: number, now: number): void {
  for (const [k, t] of map) if (now - t > windowMs) map.delete(k);
}
const mintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

router.post("/", async (req: Request, res: Response) => {
  const address = (req.body?.address ?? "") as string;
  if (!address || !isAddress(address)) {
    return fail(res, 400, "a valid wallet address is required");
  }

  // ── Abuse controls (checked before any signing) ──────────────────────────
  const now = Date.now();
  prune(lastServedByWallet, WALLET_COOLDOWN_MS, now);
  prune(lastServedByIp, IP_COOLDOWN_MS, now);

  const walletKey = getAddress(address); // checksummed → one key per wallet
  const lastWallet = lastServedByWallet.get(walletKey);
  if (lastWallet !== undefined && now - lastWallet < WALLET_COOLDOWN_MS) {
    return fail(res, 429, "this wallet was funded recently — try again shortly");
  }

  const ip = req.ip ?? "unknown";
  const lastIp = lastServedByIp.get(ip);
  if (lastIp !== undefined && now - lastIp < IP_COOLDOWN_MS) {
    return fail(res, 429, "too many faucet requests — try again shortly");
  }

  const wallet = resolverWallet();
  if (!wallet || !wallet.account) {
    return fail(res, 503, "faucet signer not configured");
  }

  // Reserve the cooldown slots now so concurrent/looped requests are rejected even
  // before the mint confirms (a script can't fire 100 in the same tick).
  lastServedByWallet.set(walletKey, now);
  lastServedByIp.set(ip, now);
  try {
    const to = getAddress(address);
    const hash = await wallet.writeContract({
      address: config.usdc as `0x${string}`,
      abi: mintAbi,
      functionName: "mint",
      args: [to, FAUCET_AMOUNT],
      account: wallet.account,
      chain: wallet.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    // Best-effort native gas top-up so a brand-new wallet can buy/sell right away
    // without a separate faucet.circle.com trip. Never fails the mint: any error
    // (resolver low on gas, RPC blip) is swallowed and the mint still returns ok.
    let gasTxHash: `0x${string}` | null = null;
    try {
      // Per-process gas budget: once we've granted GAS_BUDGET total native gas,
      // stop topping up (keep minting USDC) so a drain attack can't empty the
      // resolver via repeated fresh wallets.
      if (gasGrantedTotal + GAS_GRANT <= GAS_BUDGET) {
        const [userBal, resolverBal] = await Promise.all([
          publicClient.getBalance({ address: to }),
          publicClient.getBalance({ address: wallet.account.address }),
        ]);
        if (userBal < GAS_MIN_USER && resolverBal > GAS_GRANT + GAS_RESOLVER_FLOOR) {
          gasTxHash = await wallet.sendTransaction({
            to,
            value: GAS_GRANT,
            account: wallet.account,
            chain: wallet.chain,
          });
          await publicClient.waitForTransactionReceipt({ hash: gasTxHash });
          gasGrantedTotal += GAS_GRANT; // count it only after it actually went out
        }
      }
    } catch {
      gasTxHash = null; // gas top-up is optional; the mint already succeeded
    }

    return ok(res, {
      txHash: hash,
      gasTxHash,
      explorerUrl: explorerTx(hash),
      amount: "10000",
      gasGranted: gasTxHash ? "0.04" : null,
    });
  } catch {
    // The mint failed — release the cooldown reservations so a genuine retry
    // isn't locked out of the window for a server-side failure.
    lastServedByWallet.delete(walletKey);
    lastServedByIp.delete(ip);
    // Most likely cause: the deployer is out of gas, or this deployment isn't on the
    // mintable MockUSDC. Keep the client message generic.
    return fail(res, 500, "faucet mint failed — try again shortly");
  }
});

export default router;
