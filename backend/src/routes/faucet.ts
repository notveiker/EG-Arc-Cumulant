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
  const wallet = resolverWallet();
  if (!wallet || !wallet.account) {
    return fail(res, 503, "faucet signer not configured");
  }
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
    // Most likely cause: the deployer is out of gas, or this deployment isn't on the
    // mintable MockUSDC. Keep the client message generic.
    return fail(res, 500, "faucet mint failed — try again shortly");
  }
});

export default router;
