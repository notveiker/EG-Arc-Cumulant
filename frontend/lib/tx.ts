"use client";

import { useCallback } from "react";
import { maxUint256, type Address } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { predictionMarketAbi } from "./abi/PredictionMarket";
import { basketVaultAbi } from "./abi/BasketVault";
import { trancheVaultAbi } from "./abi/TrancheVault";
import { protectedNoteAbi } from "./abi/ProtectedNote";
import { erc20Abi } from "./abi/erc20";

export type Side = 1 | 2; // 1 = YES, 2 = NO

/**
 * Wallet signatures must not hang the UI forever. An embedded (email/MPC) wallet
 * whose signer is rate-limited (HTTP 429) never resolves `writeContractAsync`, so
 * the button would sit on "Preparing…" with no modal and no error. Race every
 * signature against a timeout that rejects with an actionable message instead.
 */
const WALLET_SIGN_TIMEOUT_MS = 90_000;
const WALLET_SIGN_TIMEOUT_MSG =
  "Wallet didn't return a signature in time. If you signed in with email, the embedded wallet's signer may be rate-limited — try again, or connect an external wallet (e.g. MetaMask).";

export function withWalletTimeout<T>(p: Promise<T>, ms = WALLET_SIGN_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(WALLET_SIGN_TIMEOUT_MSG)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Wallet-signed actions against the Cumulant contracts. Every function here is signed by
 * the connected user's own wallet — the backend never signs trades. Approvals are handled
 * inline (approve → action), and each call resolves once the final tx is mined.
 */
export function useCumulant() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // Every on-chain write funnels through this so a stuck signer surfaces an error
  // (see withWalletTimeout) instead of leaving the UI on an infinite busy state.
  const writeGuarded = useCallback(
    (params: Parameters<typeof writeContractAsync>[0]) =>
      withWalletTimeout(writeContractAsync(params)),
    [writeContractAsync],
  );

  const ensureAllowance = useCallback(
    async (usdc: Address, spender: Address, amount: bigint) => {
      if (!publicClient || !address) throw new Error("wallet not connected");
      const allowance = await publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, spender],
      });
      if ((allowance as bigint) >= amount) return;
      const hash = await writeGuarded({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    [address, publicClient, writeGuarded],
  );

  const wait = useCallback(
    async (hash: `0x${string}`) => {
      await publicClient!.waitForTransactionReceipt({ hash });
      return hash;
    },
    [publicClient],
  );

  const buy = useCallback(
    async (pm: Address, usdc: Address, marketId: number, side: Side, amount: bigint) => {
      await ensureAllowance(usdc, pm, amount);
      const hash = await writeGuarded({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "buy",
        args: [BigInt(marketId), side, amount],
      });
      return wait(hash);
    },
    [ensureAllowance, wait, writeGuarded],
  );

  const claim = useCallback(
    async (pm: Address, marketId: number) => {
      const hash = await writeGuarded({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "claim",
        args: [BigInt(marketId)],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const createMarket = useCallback(
    async (pm: Address, question: string, closeTime: number) => {
      const hash = await writeGuarded({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "createMarket",
        args: [question, BigInt(closeTime)],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const resolve = useCallback(
    async (pm: Address, marketId: number, side: Side) => {
      const hash = await writeGuarded({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "resolve",
        args: [BigInt(marketId), side],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const voidMarket = useCallback(
    async (pm: Address, marketId: number) => {
      const hash = await writeGuarded({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "voidMarket",
        args: [BigInt(marketId)],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const depositBasket = useCallback(
    async (vault: Address, usdc: Address, basketId: number, amount: bigint) => {
      await ensureAllowance(usdc, vault, amount);
      const hash = await writeGuarded({
        address: vault,
        abi: basketVaultAbi,
        functionName: "deposit",
        args: [BigInt(basketId), amount],
      });
      return wait(hash);
    },
    [ensureAllowance, wait, writeGuarded],
  );

  const settleBasket = useCallback(
    async (vault: Address, basketId: number) => {
      const hash = await writeGuarded({
        address: vault,
        abi: basketVaultAbi,
        functionName: "settle",
        args: [BigInt(basketId)],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const redeemBasket = useCallback(
    async (vault: Address, basketId: number, shares: bigint) => {
      const hash = await writeGuarded({
        address: vault,
        abi: basketVaultAbi,
        functionName: "redeem",
        args: [BigInt(basketId), shares],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  // ── Tranches ──────────────────────────────────────────────────────────────

  const depositTranche = useCallback(
    async (vault: Address, usdc: Address, trancheId: number, amount: bigint, senior: boolean) => {
      await ensureAllowance(usdc, vault, amount);
      const hash = await writeGuarded({
        address: vault,
        abi: trancheVaultAbi,
        functionName: "deposit",
        args: [BigInt(trancheId), amount, senior],
      });
      return wait(hash);
    },
    [ensureAllowance, wait, writeGuarded],
  );

  const settleTranche = useCallback(
    async (vault: Address, trancheId: number) => {
      const hash = await writeGuarded({
        address: vault,
        abi: trancheVaultAbi,
        functionName: "settle",
        args: [BigInt(trancheId)],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const redeemTranche = useCallback(
    async (vault: Address, trancheId: number, shares: bigint, senior: boolean) => {
      const hash = await writeGuarded({
        address: vault,
        abi: trancheVaultAbi,
        functionName: "redeem",
        args: [BigInt(trancheId), shares, senior],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  // ── Protected notes ───────────────────────────────────────────────────────

  const depositNote = useCallback(
    async (note: Address, usdc: Address, noteId: number, amount: bigint) => {
      await ensureAllowance(usdc, note, amount);
      const hash = await writeGuarded({
        address: note,
        abi: protectedNoteAbi,
        functionName: "deposit",
        args: [BigInt(noteId), amount],
      });
      return wait(hash);
    },
    [ensureAllowance, wait, writeGuarded],
  );

  const settleNote = useCallback(
    async (note: Address, noteId: number) => {
      const hash = await writeGuarded({
        address: note,
        abi: protectedNoteAbi,
        functionName: "settle",
        args: [BigInt(noteId)],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const redeemNote = useCallback(
    async (note: Address, noteId: number) => {
      const hash = await writeGuarded({
        address: note,
        abi: protectedNoteAbi,
        functionName: "redeem",
        args: [BigInt(noteId)],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  // ── MM secondary market (pre-settlement exit at an owner-signed quote) ───────
  // The backend prices + signs the quote; the user submits the sell here. No USDC
  // approval needed — the seller is PAID (the vault transfers from its MM reserve).

  const sellBasketToMM = useCallback(
    async (
      vault: Address,
      basketId: number,
      shares: bigint,
      payout: bigint,
      deadline: bigint,
      signature: `0x${string}`,
    ) => {
      const hash = await writeGuarded({
        address: vault,
        abi: basketVaultAbi,
        functionName: "sellToMM",
        args: [BigInt(basketId), shares, payout, deadline, signature],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const sellTrancheToMM = useCallback(
    async (
      vault: Address,
      trancheId: number,
      shares: bigint,
      senior: boolean,
      payout: bigint,
      deadline: bigint,
      signature: `0x${string}`,
    ) => {
      const hash = await writeGuarded({
        address: vault,
        abi: trancheVaultAbi,
        functionName: "sellToMM",
        args: [BigInt(trancheId), shares, senior, payout, deadline, signature],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  const sellNoteToMM = useCallback(
    async (
      note: Address,
      noteId: number,
      principal: bigint,
      payout: bigint,
      deadline: bigint,
      signature: `0x${string}`,
    ) => {
      const hash = await writeGuarded({
        address: note,
        abi: protectedNoteAbi,
        functionName: "sellToMM",
        args: [BigInt(noteId), principal, payout, deadline, signature],
      });
      return wait(hash);
    },
    [wait, writeGuarded],
  );

  return {
    buy,
    claim,
    createMarket,
    resolve,
    voidMarket,
    depositBasket,
    settleBasket,
    redeemBasket,
    depositTranche,
    settleTranche,
    redeemTranche,
    depositNote,
    settleNote,
    redeemNote,
    sellBasketToMM,
    sellTrancheToMM,
    sellNoteToMM,
  };
}
