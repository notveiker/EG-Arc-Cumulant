/**
 * MM secondary-market quoting (Cumulant / Arc).
 *
 * The protocol acts as a market-maker: it QUOTES a bid for a pre-settlement
 * position (basket shares, tranche senior/junior shares, or note principal) and
 * signs that quote with the vault owner key. The seller then calls the vault's
 * `sellToMM(...)` on-chain with the signature; the contract recovers the signer,
 * checks it equals `owner()`, pays the seller from the MM reserve, and warehouses
 * the position to settlement. This file is the OFF-CHAIN half: price + sign. The
 * buy (deposit) and the sell (sellToMM) both still settle on-chain — only the
 * quoting/pricing is simulated here, exactly as the rest of the venue's marks are.
 *
 * Pricing is per-product (the brief: "a market maker quoting prices depending on
 * the product"). Every product mints 1:1, so par is 1 USDC/unit; the MM bids a
 * product-specific spread below par reflecting risk and the cost of warehousing
 * the position until settlement. The mark, spread and payout are all surfaced so
 * the UI can explain the fill.
 */
import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { publicClient } from "../chain.js";
import {
  resolveBundleToOnchain,
  resolveBundleToNote,
  resolveBundleToTranche,
} from "./onchain.js";
import { basketVaultAbi } from "../abi/BasketVault.js";
import { trancheVaultAbi } from "../abi/TrancheVault.js";
import { protectedNoteAbi } from "../abi/ProtectedNote.js";
import { explorerAddress } from "../config.js";

const USDC_DECIMALS = 6;
const ONE_USDC = 1_000_000n;
const BPS = 10_000n;
/** Signed quotes are valid for this long; `sellToMM` reverts QuoteExpired after. */
const QUOTE_TTL_SECONDS = 300;

export type ProductKind = "basket" | "tranche" | "note";
export type TrancheKind = "senior" | "junior";

/**
 * MM bid in bps of par per product (the fraction of $1/unit the MM pays for an
 * early exit). Riskier / longer-to-warehouse positions get a deeper discount; the
 * junior tranche absorbs first losses, so it trades furthest below par.
 */
const MM_BID_BPS: Record<string, number> = {
  basket: 9_750, //            2.50% below par — basket of binaries, warehousing risk
  note: 9_900, //              1.00% — principal-protected, trades near par
  "tranche-senior": 9_850, //  1.50% — senior slice, low risk
  "tranche-junior": 9_000, // 10.00% — first-loss slice, deepest discount
};

export interface SignedQuote {
  productType: ProductKind;
  trancheKind: TrancheKind | null;
  /** Vault CONTRACT ADDRESS the seller calls `sellToMM` on. */
  vault: Address;
  /** On-chain product id (basketId / trancheId / noteId). */
  productId: number;
  seller: Address;
  /** Position size being sold, 6dp base units (string, == the `shares`/`principal` arg). */
  size6dp: string;
  size_usdc: number;
  /** MM payout, 6dp base units (string, == the signed `payout`). */
  payout6dp: string;
  payout_usdc: number;
  /** Per-unit par mark and the per-unit bid the MM is paying. */
  mark_per_unit: number;
  bid_per_unit: number;
  spread_bps: number;
  /** Unix seconds the quote expires (the signed `deadline`). */
  deadline: number;
  /** EIP-191 (personal_sign) signature over the contract digest, by the vault owner. */
  signature: Hex;
  /** The raw 32-byte digest that was signed (for debugging / verification). */
  digest: Hex;
  chainId: number;
  /** Current MM reserve in the vault, display USDC (the payout cannot exceed this). */
  reserve_usdc: number;
  explorerUrl: string;
}

function toRaw(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
}
function fromRaw(raw: bigint): number {
  return Number(raw) / 10 ** USDC_DECIMALS;
}

/** Read the seller's on-chain position size (6dp) for the resolved product. */
async function readBalance(
  productType: ProductKind,
  vault: Address,
  productId: number,
  owner: Address,
  trancheKind: TrancheKind,
): Promise<bigint> {
  if (productType === "basket") {
    return (await publicClient.readContract({
      address: vault,
      abi: basketVaultAbi,
      functionName: "sharesOf",
      args: [BigInt(productId), owner],
    })) as bigint;
  }
  if (productType === "tranche") {
    const [senior, junior] = (await publicClient.readContract({
      address: vault,
      abi: trancheVaultAbi,
      functionName: "sharesOf",
      args: [BigInt(productId), owner],
    })) as [bigint, bigint];
    return trancheKind === "senior" ? senior : junior;
  }
  return (await publicClient.readContract({
    address: vault,
    abi: protectedNoteAbi,
    functionName: "principalOf",
    args: [BigInt(productId), owner],
  })) as bigint;
}

/** Read a vault's current MM reserve (6dp). */
async function readReserve(productType: ProductKind, vault: Address): Promise<bigint> {
  const abi =
    productType === "basket"
      ? basketVaultAbi
      : productType === "tranche"
        ? trancheVaultAbi
        : protectedNoteAbi;
  return (await publicClient.readContract({
    address: vault,
    abi,
    functionName: "mmReserve",
  })) as bigint;
}

/**
 * Build the EXACT digest each vault's `sellToMM` recovers against. The tuple
 * order mirrors the Solidity `keccak256(abi.encode(...))` verbatim:
 *   basket:  (chainId, vault, basketId,  seller, shares,    payout, deadline)
 *   tranche: (chainId, vault, trancheId, seller, shares, senior, payout, deadline)
 *   note:    (chainId, vault, noteId,    seller, principal, payout, deadline)
 */
function buildDigest(args: {
  productType: ProductKind;
  vault: Address;
  productId: number;
  seller: Address;
  size: bigint;
  senior: boolean;
  payout: bigint;
  deadline: bigint;
  chainId: number;
}): Hex {
  const { productType, vault, productId, seller, size, senior, payout, deadline, chainId } = args;
  if (productType === "tranche") {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "address" },
          { type: "uint256" },
          { type: "address" },
          { type: "uint256" },
          { type: "bool" },
          { type: "uint256" },
          { type: "uint256" },
        ],
        [BigInt(chainId), vault, BigInt(productId), seller, size, senior, payout, deadline],
      ),
    );
  }
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [BigInt(chainId), vault, BigInt(productId), seller, size, payout, deadline],
    ),
  );
}

/**
 * Quote + sign a pre-settlement MM bid for `owner`'s position. Resolves the
 * synthetic bundle id to a real on-chain product, reads the owner's balance,
 * clamps the requested size to it, prices a per-product bid below par, ensures
 * the MM reserve covers the payout, and returns a signature the seller submits to
 * `sellToMM`.
 */
export async function quoteSellToMM(args: {
  bundleId: string;
  productType: ProductKind;
  owner: string;
  size_usdc: number;
  trancheKind?: TrancheKind;
  nowSeconds?: number;
}): Promise<SignedQuote> {
  if (!config.resolverKey) {
    throw new Error("MM signing key not configured (DEPLOYER_PRIVATE_KEY unset)");
  }
  const seller = args.owner as Address;
  const trancheKind: TrancheKind = args.trancheKind === "junior" ? "junior" : "senior";

  // 1. Resolve the bundle → on-chain (vault, productId).
  let vault: Address;
  let productId: number;
  let explorerUrl: string;
  if (args.productType === "basket") {
    const ref = await resolveBundleToOnchain(args.bundleId);
    if (ref.basketId === null) throw new Error("bundle does not map to an on-chain basket");
    vault = ref.vaultAddress as Address;
    productId = ref.basketId;
    explorerUrl = ref.explorerUrl;
  } else if (args.productType === "tranche") {
    const ref = await resolveBundleToTranche(args.bundleId);
    if (!ref) throw new Error("bundle does not map to an on-chain tranche");
    vault = ref.vault as Address;
    productId = ref.trancheId;
    explorerUrl = ref.explorerUrl;
  } else {
    const ref = await resolveBundleToNote(args.bundleId);
    if (!ref) throw new Error("bundle does not map to an on-chain note");
    vault = ref.vault as Address;
    productId = ref.noteId;
    explorerUrl = ref.explorerUrl;
  }

  // 2. Read the seller's balance; clamp the requested size to it.
  const balance = await readBalance(args.productType, vault, productId, seller, trancheKind);
  if (balance <= 0n) throw new Error("no position to sell for this owner");
  let size = args.size_usdc > 0 ? toRaw(args.size_usdc) : balance;
  if (size > balance) size = balance;
  if (size <= 0n) throw new Error("sell size must be positive");

  // 3. Price the per-product bid below par.
  const bidKey =
    args.productType === "tranche" ? `tranche-${trancheKind}` : args.productType;
  const bidBps = BigInt(MM_BID_BPS[bidKey] ?? 9_500);
  const payout = (size * bidBps) / BPS;

  // 4. Ensure the MM reserve covers the payout (the contract reverts ReserveTooLow otherwise).
  const reserve = await readReserve(args.productType, vault);
  if (payout > reserve) {
    throw new Error(
      `MM reserve too low for this size (need ${fromRaw(payout)} USDC, have ${fromRaw(reserve)})`,
    );
  }

  // 5. Sign the quote (EIP-191 personal_sign over the contract digest).
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const deadline = BigInt(now + QUOTE_TTL_SECONDS);
  const digest = buildDigest({
    productType: args.productType,
    vault,
    productId,
    seller,
    size,
    senior: trancheKind === "senior",
    payout,
    deadline,
    chainId: config.chainId,
  });
  const account = privateKeyToAccount(config.resolverKey);
  const signature = await account.signMessage({ message: { raw: digest } });

  const markPerUnit = 1; // par: every product mints 1 unit per USDC
  return {
    productType: args.productType,
    trancheKind: args.productType === "tranche" ? trancheKind : null,
    vault,
    productId,
    seller,
    size6dp: size.toString(),
    size_usdc: fromRaw(size),
    payout6dp: payout.toString(),
    payout_usdc: fromRaw(payout),
    mark_per_unit: markPerUnit,
    bid_per_unit: Number(bidBps) / Number(BPS),
    spread_bps: Number(BPS - bidBps),
    deadline: Number(deadline),
    signature,
    digest,
    chainId: config.chainId,
    reserve_usdc: fromRaw(reserve),
    explorerUrl: explorerUrl || (vault ? explorerAddress(vault) : ""),
  };
}

/** Public, read-only view of each vault's MM reserve (for UI/debugging). */
export async function getMmReserves(): Promise<{
  basket: number | null;
  tranche: number | null;
  note: number | null;
}> {
  const read = async (t: ProductKind, addr?: string) => {
    if (!addr) return null;
    try {
      return fromRaw(await readReserve(t, addr as Address));
    } catch {
      return null;
    }
  };
  const [basket, tranche, note] = await Promise.all([
    read("basket", config.basketVault),
    read("tranche", config.trancheVault),
    read("note", config.protectedNote),
  ]);
  return { basket, tranche, note };
}
