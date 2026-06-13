/**
 * Test-USDC faucet — mints 10,000 freely-mintable MockUSDC to the caller's connected
 * (Dynamic) wallet so demos aren't gated on the $20 Arc testnet faucet.
 *
 * Server-signed with the deployer/resolver key (which holds the gas). MockUSDC.mint()
 * is public on-chain, so this exposes nothing not already callable by anyone — it just
 * pays the gas for the user. Testnet only; does not touch product trust or resolver
 * semantics. Returns the tx hash + a live explorer link for the UI toast.
 */
import { Router, type Request, type Response } from "express";
import { isAddress, getAddress, parseUnits } from "viem";
import { config, explorerTx } from "../config.js";
import { publicClient, resolverWallet } from "../chain.js";

const router = Router();
const ok = <T>(res: Response, data: T) => res.json({ ok: true, data });
const fail = (res: Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

const FAUCET_AMOUNT = parseUnits("10000", 6); // 10,000 test USDC (6 decimals)
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
    const hash = await wallet.writeContract({
      address: config.usdc as `0x${string}`,
      abi: mintAbi,
      functionName: "mint",
      args: [getAddress(address), FAUCET_AMOUNT],
      account: wallet.account,
      chain: wallet.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return ok(res, { txHash: hash, explorerUrl: explorerTx(hash), amount: "10000" });
  } catch {
    // Most likely cause: the deployer is out of gas, or this deployment isn't on the
    // mintable MockUSDC. Keep the client message generic.
    return fail(res, 500, "faucet mint failed — try again shortly");
  }
});

export default router;
