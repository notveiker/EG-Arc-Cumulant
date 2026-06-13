"use client";
/**
 * Client for the continuous distribution market on Cumulant (Circle Arc / EVM).
 *
 * Quotes are computed server-side (Normal mu/sigma, constant-L2 AMM, g(x)-f(x))
 * and returned as RAW JSON from /api/distribution/continuous/*. Opening a position
 * escrows the collateral on-chain via the user's own wallet:
 *   POST open/prepare -> backend returns the escrow target { vault, amount_usdc6dp }
 *   -> the wallet signs a USDC transfer CLIENT-SIDE via wagmi (see
 *   `useContinuousEscrow()`) -> POST open/confirm { signature: <txHash> }.
 *
 * `explorer_url` in returned shapes points at Arcscan. The escrow signing is
 * supplied through an OPTIONAL `signEscrow` callback on `openContinuousPosition`
 * (the page wires it via `useContinuousEscrow`).
 */
import { useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseUnits, type Address } from "viem";
import { useConfig } from "@/lib/hooks";
import { withWalletTimeout } from "@/lib/tx";
import { BACKEND_URL } from "./tokens";
import { unwrap } from "./http";
import type { WalletSigner } from "./wallet-bridge";

export interface ContinuousMarket {
  id: string;
  underlying: string;
  question: string;
  unit: string;
  expiry_ts: number;
  mu: number;
  sigma: number;
  mu_min: number;
  mu_max: number;
  sigma_min: number;
  sigma_max: number;
  step: number;
  source: "polymarket" | "spot" | "reference";
  volume_usd: number;
  category: string;
  polymarket_url: string | null;
  pool_liquidity_usdc: number;
  backing_usdc: number;
  l2_norm_k: number;
}

export interface ContinuousQuote {
  market_id: string;
  question: string;
  unit: string;
  market_mu: number;
  market_sigma: number;
  target_mu: number;
  target_sigma: number;
  collateral_usdc: number;
  maker_fee_usdc: number;
  net_usdc: number;
  x: number[];
  market_pdf: number[];
  target_pdf: number[];
  market_curve: number[];
  target_curve: number[];
  trade_curve: number[];
  collateral_required_usdc: number;
  max_profit_usdc: number;
  max_loss_usdc: number;
  expected_value_usdc: number;
  l2_distance: number;
  pool_liquidity_usdc: number;
  price_impact_bps: number;
  sigma_min: number;
  max_collateral_usdc: number;
  capacity_exceeded: boolean;
  quote_model: string;
}

export interface ContinuousPosition {
  id: string;
  market_id: string;
  question: string;
  market_mu: number;
  market_sigma: number;
  target_mu: number;
  target_sigma: number;
  collateral_usdc: number;
  max_profit_usdc: number;
  open_tx_hash: string;
  opened_at: number;
  realized_x: number;
  settled: boolean;
  settle_tx_hash?: string;
  payoff_usdc?: number;
  net_usdc?: number;
  settled_at?: number;
}

export interface SettleResult {
  position_id: string;
  realized_x: number;
  payoff_usdc: number;
  net_usdc: number;
  pnl_usdc: number;
  settle_tx_hash: string | null;
  explorer_url: string | null;
}

export interface CloseResult {
  position_id: string;
  mark_usdc: number;
  slippage_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  pnl_usdc: number;
  price_impact_bps: number;
  close_tx_hash: string | null;
  explorer_url: string | null;
}

/** Escrow target the backend resolves at open/prepare time (resolved server-side). */
interface ContinuousOpenPrepare {
  /** Vault/escrow contract that receives the collateral. */
  vault?: Address | string | null;
  /** USDC token address to transfer (falls back to /api/config usdc). */
  usdc?: Address | string | null;
  /** Collateral in 6-decimal base units, as a string for bigint safety. */
  amount_usdc6dp?: string | number | null;
  /** Convenience float in whole USDC (used if amount_usdc6dp is absent). */
  collateral_usdc?: number | null;
  /** Unused on Arc. */
  prepared_tx?: string | null;
}

/**
 * Signs the on-chain collateral escrow for a continuous-market open. Returns the
 * EVM tx hash. The implementation lives in `useContinuousEscrow()` (it needs the
 * wagmi wallet hooks); `openContinuousPosition` accepts it as an optional arg so
 * its documented signature is unchanged.
 */
export type EscrowSigner = (prep: ContinuousOpenPrepare) => Promise<string>;

async function jsonGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return unwrap(await res.json()) as T;
}

async function jsonPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return unwrap<T>(payload);
}

export function fetchContinuousMarkets(): Promise<{ markets: ContinuousMarket[] }> {
  return jsonGet("/api/distribution/continuous/markets");
}

/** Seed simulated AMM liquidity into a market's pool. */
export function seedLiquidity(
  marketId: string,
  amountUsdc: number,
): Promise<{ market_id: string; pool_liquidity_usdc: number; seeded_usdc: number }> {
  return jsonPost("/api/distribution/continuous/seed-liquidity", {
    market_id: marketId,
    amount_usdc: amountUsdc,
  });
}

/** Seed a random 5–6 figure position into EVERY market pool at once. */
export function seedAllPools(): Promise<{
  count: number;
  seeded: Array<{ market_id: string; amount_usdc: number; pool_liquidity_usdc: number }>;
}> {
  return jsonPost("/api/distribution/continuous/seed-all", {});
}

export function quoteContinuous(args: {
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
}): Promise<ContinuousQuote> {
  return jsonPost("/api/distribution/continuous/quote", {
    market_id: args.marketId,
    target_mu: args.targetMu,
    target_sigma: args.targetSigma,
    collateral_usdc: args.collateralUsdc,
  });
}

export function fetchContinuousPositions(owner: string): Promise<{ positions: ContinuousPosition[] }> {
  return jsonGet(`/api/distribution/continuous/positions/${encodeURIComponent(owner)}`);
}

/** Minimal ERC-20 surface used for the collateral escrow (approve + transfer). */
const escrowErc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function escrowAmount6dp(prep: ContinuousOpenPrepare): bigint {
  if (prep.amount_usdc6dp != null && prep.amount_usdc6dp !== "") {
    // Already-6dp base units. Tolerate a stray decimal/scientific form rather
    // than letting BigInt() throw an opaque SyntaxError.
    const s = String(prep.amount_usdc6dp).trim();
    if (/^\d+$/.test(s)) return BigInt(s);
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`Invalid escrow base-unit amount: ${prep.amount_usdc6dp}`);
    return BigInt(Math.round(n));
  }
  if (prep.collateral_usdc != null) {
    return parseUnits(String(prep.collateral_usdc), 6);
  }
  throw new Error("Backend did not return an escrow amount.");
}

/**
 * Hook that returns an {@link EscrowSigner}: signs a USDC transfer of the
 * collateral into the continuous-market escrow/vault resolved by the backend's
 * open/prepare call, and resolves once the tx is mined. The page passes the
 * returned signer to {@link openContinuousPosition}.
 */
export function useContinuousEscrow(): EscrowSigner {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { data: cfg } = useConfig();

  return useCallback(
    async (prep: ContinuousOpenPrepare): Promise<string> => {
      if (!address) throw new Error("Connect an Arc wallet to open a position.");
      if (!publicClient) throw new Error("Arc network client is unavailable.");
      const usdc = (prep.usdc ?? cfg?.usdc) as Address | undefined;
      if (!usdc) throw new Error("USDC token address is not configured.");
      const vault = prep.vault as Address | undefined;
      if (!vault) throw new Error("Backend did not return an escrow address.");
      const amount = escrowAmount6dp(prep);

      const hash = await withWalletTimeout(
        writeContractAsync({
          address: usdc,
          abi: escrowErc20Abi,
          functionName: "transfer",
          args: [vault, amount],
        }),
      );
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    },
    [address, publicClient, writeContractAsync, cfg?.usdc],
  );
}

/**
 * Open a continuous distribution position. On Arc: resolve the escrow target via
 * open/prepare, sign a USDC transfer client-side (`signEscrow`, from
 * `useContinuousEscrow()`), then POST open/confirm with the EVM tx hash so the
 * backend records the position. `txHash` in the result is the EVM tx hash.
 *
 * `signEscrow` is an additive optional arg supplied by the calling page (which
 * has wagmi hook context).
 */
export async function openContinuousPosition(args: {
  wallet: WalletSigner;
  marketId: string;
  targetMu: number;
  targetSigma: number;
  collateralUsdc: number;
  signEscrow?: EscrowSigner;
}): Promise<{ txHash: string; position: ContinuousPosition }> {
  const owner = args.wallet.address;
  if (!args.wallet.connected || !owner) throw new Error("Connect an Arc wallet to open a position.");
  if (!args.signEscrow) {
    throw new Error(
      "An escrow signer is required on Arc — pass signEscrow from useContinuousEscrow().",
    );
  }

  const prep = await jsonPost<ContinuousOpenPrepare>("/api/distribution/continuous/open/prepare", {
    wallet_address: owner,
    market_id: args.marketId,
    target_mu: args.targetMu,
    target_sigma: args.targetSigma,
    collateral_usdc: args.collateralUsdc,
  });

  // Fall back to the requested collateral if the backend didn't echo an amount.
  if (prep.amount_usdc6dp == null && prep.collateral_usdc == null) {
    prep.collateral_usdc = args.collateralUsdc;
  }

  const txHash = await args.signEscrow(prep);

  const conf = await jsonPost<{ confirmed: boolean; position: ContinuousPosition }>(
    "/api/distribution/continuous/open/confirm",
    {
      wallet_address: owner,
      market_id: args.marketId,
      target_mu: args.targetMu,
      target_sigma: args.targetSigma,
      collateral_usdc: args.collateralUsdc,
      tx_hash: txHash,
    },
  );
  return { txHash, position: conf.position };
}

/** Settle a position: the protocol pays the realized net on-chain. */
export function settleContinuousPosition(args: {
  owner: string;
  positionId: string;
}): Promise<SettleResult> {
  return jsonPost("/api/distribution/continuous/settle", {
    wallet_address: args.owner,
    position_id: args.positionId,
  });
}

/** Sell/close a position before settlement — unwind through the AMM (mark
 * minus maker fee + price-impact slippage), protocol pays the net on-chain. */
export function closeContinuousPosition(args: {
  owner: string;
  positionId: string;
}): Promise<CloseResult> {
  return jsonPost("/api/distribution/continuous/close", {
    wallet_address: args.owner,
    position_id: args.positionId,
  });
}
