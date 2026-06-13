import type { Address } from "viem";
import { formatUnits } from "viem";
import { predictionMarketAbi } from "./abi/PredictionMarket.js";
import { basketVaultAbi } from "./abi/BasketVault.js";
import { trancheVaultAbi } from "./abi/TrancheVault.js";
import { protectedNoteAbi } from "./abi/ProtectedNote.js";
import { erc20Abi } from "./abi/erc20.js";
import { publicClient } from "./chain.js";
import { requireContracts } from "./config.js";

const USDC_DECIMALS = 6;
export const SIDE = { None: 0, Yes: 1, No: 2 } as const;
export const SIDE_LABEL = ["NONE", "YES", "NO"] as const;

function usdc(v: bigint) {
  return { raw: v.toString(), usd: formatUnits(v, USDC_DECIMALS) };
}

// ── Markets ──────────────────────────────────────────────────────────────────

export async function getMarketCount(): Promise<number> {
  const { predictionMarket } = requireContracts();
  const n = await publicClient.readContract({
    address: predictionMarket,
    abi: predictionMarketAbi,
    functionName: "marketCount",
  });
  return Number(n);
}

export async function getMarket(id: number) {
  const { predictionMarket } = requireContracts();
  const [m, impliedBps] = await Promise.all([
    publicClient.readContract({
      address: predictionMarket,
      abi: predictionMarketAbi,
      functionName: "getMarket",
      args: [BigInt(id)],
    }),
    publicClient.readContract({
      address: predictionMarket,
      abi: predictionMarketAbi,
      functionName: "impliedYesBps",
      args: [BigInt(id)],
    }),
  ]);
  return {
    id,
    question: m.question,
    closeTime: Number(m.closeTime),
    resolvedAt: Number(m.resolvedAt),
    outcome: SIDE_LABEL[m.outcome] ?? "NONE",
    resolved: m.resolved,
    voided: m.voided,
    creator: m.creator,
    yesStake: usdc(m.yesStake),
    noStake: usdc(m.noStake),
    totalStake: usdc(m.yesStake + m.noStake),
    impliedYesProbability: Number(impliedBps) / 10_000,
  };
}

export async function getMarkets() {
  const n = await getMarketCount();
  return Promise.all(Array.from({ length: n }, (_, i) => getMarket(i)));
}

// ── Baskets ──────────────────────────────────────────────────────────────────

export async function getBasketCount(): Promise<number> {
  const { basketVault } = requireContracts();
  const n = await publicClient.readContract({
    address: basketVault,
    abi: basketVaultAbi,
    functionName: "basketCount",
  });
  return Number(n);
}

export async function getBasket(id: number) {
  const { basketVault } = requireContracts();
  const [b, legs, mark] = await Promise.all([
    publicClient.readContract({
      address: basketVault,
      abi: basketVaultAbi,
      functionName: "getBasket",
      args: [BigInt(id)],
    }),
    publicClient.readContract({
      address: basketVault,
      abi: basketVaultAbi,
      functionName: "getLegs",
      args: [BigInt(id)],
    }),
    publicClient
      .readContract({
        address: basketVault,
        abi: basketVaultAbi,
        functionName: "markToWin",
        args: [BigInt(id)],
      })
      .catch(() => 0n),
  ]);
  return {
    id,
    name: b.name,
    totalShares: usdc(b.totalShares),
    recovered: usdc(b.recovered),
    settled: b.settled,
    creator: b.creator,
    markToWin: usdc(mark),
    legs: legs.map((l) => ({
      marketId: Number(l.marketId),
      side: SIDE_LABEL[l.side] ?? "NONE",
      weightBps: l.weightBps,
      weightPct: l.weightBps / 100,
    })),
  };
}

export async function getBaskets() {
  const n = await getBasketCount();
  return Promise.all(Array.from({ length: n }, (_, i) => getBasket(i)));
}

// ── Tranches ─────────────────────────────────────────────────────────────────

export async function getTrancheCount(): Promise<number> {
  const { trancheVault } = requireContracts();
  const n = await publicClient.readContract({
    address: trancheVault,
    abi: trancheVaultAbi,
    functionName: "trancheCount",
  });
  return Number(n);
}

export async function getTranche(id: number) {
  const { trancheVault } = requireContracts();
  const [t, legs] = await Promise.all([
    publicClient.readContract({
      address: trancheVault,
      abi: trancheVaultAbi,
      functionName: "getTranche",
      args: [BigInt(id)],
    }),
    publicClient.readContract({
      address: trancheVault,
      abi: trancheVaultAbi,
      functionName: "getLegs",
      args: [BigInt(id)],
    }),
  ]);
  return {
    id,
    name: t.name,
    seniorCouponBps: t.seniorCouponBps,
    seniorCouponPct: t.seniorCouponBps / 100,
    seniorPrincipal: usdc(t.seniorPrincipal),
    juniorPrincipal: usdc(t.juniorPrincipal),
    settled: t.settled,
    recovered: usdc(t.recovered),
    seniorPot: usdc(t.seniorPot),
    juniorPot: usdc(t.juniorPot),
    creator: t.creator,
    legs: legs.map((l) => ({
      marketId: Number(l.marketId),
      side: SIDE_LABEL[l.side] ?? "NONE",
      weightBps: l.weightBps,
      weightPct: l.weightBps / 100,
    })),
  };
}

export async function getTranches() {
  const n = await getTrancheCount();
  return Promise.all(Array.from({ length: n }, (_, i) => getTranche(i)));
}

// ── Protected notes ──────────────────────────────────────────────────────────

export async function getNoteCount(): Promise<number> {
  const { protectedNote } = requireContracts();
  const n = await publicClient.readContract({
    address: protectedNote,
    abi: protectedNoteAbi,
    functionName: "noteCount",
  });
  return Number(n);
}

export async function getNote(id: number) {
  const { protectedNote } = requireContracts();
  const [note, projected] = await Promise.all([
    publicClient.readContract({
      address: protectedNote,
      abi: protectedNoteAbi,
      functionName: "getNote",
      args: [BigInt(id)],
    }),
    publicClient
      .readContract({
        address: protectedNote,
        abi: protectedNoteAbi,
        functionName: "projectedCoupon",
        args: [BigInt(id)],
      })
      .catch(() => 0n),
  ]);
  return {
    id,
    name: note.name,
    marketId: Number(note.marketId),
    side: SIDE_LABEL[note.side] ?? "NONE",
    issuerUpside: usdc(note.issuerUpside),
    principal: usdc(note.principal),
    coupon: usdc(note.coupon),
    projectedCoupon: usdc(projected),
    settled: note.settled,
    issuer: note.issuer,
  };
}

export async function getNotes() {
  const n = await getNoteCount();
  return Promise.all(Array.from({ length: n }, (_, i) => getNote(i)));
}

// ── Portfolio ────────────────────────────────────────────────────────────────

/**
 * Map [0, n) through `task` with at most `limit` calls in flight, so a large
 * fan-out (e.g. 318 market position reads) doesn't burst the Arc RPC into
 * dropping requests — the cause of intermittent 500s on /api/portfolio.
 */
async function mapPooled<T>(n: number, limit: number, task: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(n);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < n; i = next++) {
      out[i] = await task(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(n, 1)) }, worker));
  return out;
}

export async function getPortfolio(address: Address) {
  const { predictionMarket, basketVault, trancheVault, protectedNote, usdc: usdcAddr } =
    requireContracts();
  const [balance, marketCount, basketCount, trancheCount, noteCount] = await Promise.all([
    publicClient.readContract({
      address: usdcAddr,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
    getMarketCount(),
    getBasketCount(),
    getTrancheCount(),
    getNoteCount(),
  ]);

  const positions = (
    await mapPooled(marketCount, 12, async (i) => {
      const pos = await publicClient.readContract({
        address: predictionMarket,
        abi: predictionMarketAbi,
        functionName: "getPosition",
        args: [BigInt(i), address],
      });
      if (pos.yes === 0n && pos.no === 0n) return null;
      return { marketId: i, yes: usdc(pos.yes), no: usdc(pos.no) };
    })
  ).filter(Boolean);

  const basketHoldings = (
    await mapPooled(basketCount, 12, async (i) => {
      const shares = await publicClient.readContract({
        address: basketVault,
        abi: basketVaultAbi,
        functionName: "sharesOf",
        args: [BigInt(i), address],
      });
      if (shares === 0n) return null;
      return { basketId: i, shares: usdc(shares) };
    })
  ).filter(Boolean);

  const trancheHoldings = (
    await mapPooled(trancheCount, 12, async (i) => {
      const [senior, junior] = await publicClient.readContract({
        address: trancheVault,
        abi: trancheVaultAbi,
        functionName: "sharesOf",
        args: [BigInt(i), address],
      });
      if (senior === 0n && junior === 0n) return null;
      return { trancheId: i, senior: usdc(senior), junior: usdc(junior) };
    })
  ).filter(Boolean);

  const noteHoldings = (
    await mapPooled(noteCount, 12, async (i) => {
      const principal = await publicClient.readContract({
        address: protectedNote,
        abi: protectedNoteAbi,
        functionName: "principalOf",
        args: [BigInt(i), address],
      });
      if (principal === 0n) return null;
      return { noteId: i, principal: usdc(principal) };
    })
  ).filter(Boolean);

  return {
    address,
    usdcBalance: usdc(balance),
    marketPositions: positions,
    basketHoldings,
    trancheHoldings,
    noteHoldings,
  };
}
