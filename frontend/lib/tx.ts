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
 * Wallet-signed actions against the Cumulant contracts. Every function here is signed by
 * the connected user's own wallet — the backend never signs trades. Approvals are handled
 * inline (approve → action), and each call resolves once the final tx is mined.
 */
export function useCumulant() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

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
      const hash = await writeContractAsync({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    },
    [address, publicClient, writeContractAsync],
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
      const hash = await writeContractAsync({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "buy",
        args: [BigInt(marketId), side, amount],
      });
      return wait(hash);
    },
    [ensureAllowance, wait, writeContractAsync],
  );

  const claim = useCallback(
    async (pm: Address, marketId: number) => {
      const hash = await writeContractAsync({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "claim",
        args: [BigInt(marketId)],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  const createMarket = useCallback(
    async (pm: Address, question: string, closeTime: number) => {
      const hash = await writeContractAsync({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "createMarket",
        args: [question, BigInt(closeTime)],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  const resolve = useCallback(
    async (pm: Address, marketId: number, side: Side) => {
      const hash = await writeContractAsync({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "resolve",
        args: [BigInt(marketId), side],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  const voidMarket = useCallback(
    async (pm: Address, marketId: number) => {
      const hash = await writeContractAsync({
        address: pm,
        abi: predictionMarketAbi,
        functionName: "voidMarket",
        args: [BigInt(marketId)],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  const depositBasket = useCallback(
    async (vault: Address, usdc: Address, basketId: number, amount: bigint) => {
      await ensureAllowance(usdc, vault, amount);
      const hash = await writeContractAsync({
        address: vault,
        abi: basketVaultAbi,
        functionName: "deposit",
        args: [BigInt(basketId), amount],
      });
      return wait(hash);
    },
    [ensureAllowance, wait, writeContractAsync],
  );

  const settleBasket = useCallback(
    async (vault: Address, basketId: number) => {
      const hash = await writeContractAsync({
        address: vault,
        abi: basketVaultAbi,
        functionName: "settle",
        args: [BigInt(basketId)],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  const redeemBasket = useCallback(
    async (vault: Address, basketId: number, shares: bigint) => {
      const hash = await writeContractAsync({
        address: vault,
        abi: basketVaultAbi,
        functionName: "redeem",
        args: [BigInt(basketId), shares],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  // ── Tranches ──────────────────────────────────────────────────────────────

  const depositTranche = useCallback(
    async (vault: Address, usdc: Address, trancheId: number, amount: bigint, senior: boolean) => {
      await ensureAllowance(usdc, vault, amount);
      const hash = await writeContractAsync({
        address: vault,
        abi: trancheVaultAbi,
        functionName: "deposit",
        args: [BigInt(trancheId), amount, senior],
      });
      return wait(hash);
    },
    [ensureAllowance, wait, writeContractAsync],
  );

  const settleTranche = useCallback(
    async (vault: Address, trancheId: number) => {
      const hash = await writeContractAsync({
        address: vault,
        abi: trancheVaultAbi,
        functionName: "settle",
        args: [BigInt(trancheId)],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  const redeemTranche = useCallback(
    async (vault: Address, trancheId: number, shares: bigint, senior: boolean) => {
      const hash = await writeContractAsync({
        address: vault,
        abi: trancheVaultAbi,
        functionName: "redeem",
        args: [BigInt(trancheId), shares, senior],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  // ── Protected notes ───────────────────────────────────────────────────────

  const depositNote = useCallback(
    async (note: Address, usdc: Address, noteId: number, amount: bigint) => {
      await ensureAllowance(usdc, note, amount);
      const hash = await writeContractAsync({
        address: note,
        abi: protectedNoteAbi,
        functionName: "deposit",
        args: [BigInt(noteId), amount],
      });
      return wait(hash);
    },
    [ensureAllowance, wait, writeContractAsync],
  );

  const settleNote = useCallback(
    async (note: Address, noteId: number) => {
      const hash = await writeContractAsync({
        address: note,
        abi: protectedNoteAbi,
        functionName: "settle",
        args: [BigInt(noteId)],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
  );

  const redeemNote = useCallback(
    async (note: Address, noteId: number) => {
      const hash = await writeContractAsync({
        address: note,
        abi: protectedNoteAbi,
        functionName: "redeem",
        args: [BigInt(noteId)],
      });
      return wait(hash);
    },
    [wait, writeContractAsync],
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
  };
}
