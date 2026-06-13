import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";

// Load the repo-root `.env` first (a developer's local secrets / overrides),
// then `.env.shared` (committed, non-secret defaults like the chain) — dotenv
// does NOT override already-set vars, so `.env`
// always wins and `.env.shared` only fills the gaps. This lets a fresh clone run
// with zero local config.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
loadEnv({ path: resolve(repoRoot, ".env") });
loadEnv({ path: resolve(repoRoot, ".env.shared") });

export type ChainKey = "arc" | "local";

const CHAIN: ChainKey = (process.env.CUMULANT_CHAIN as ChainKey) || "arc";

const ARC = {
  key: "arc" as const,
  chainId: 5042002,
  name: "Arc Testnet",
  rpcUrl: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network",
  explorer: process.env.ARC_EXPLORER_URL || "https://testnet.arcscan.app",
  usdc: (process.env.USDC_ADDRESS ||
    "0x3600000000000000000000000000000000000000") as Address,
};

const LOCAL = {
  key: "local" as const,
  chainId: 31337,
  name: "Anvil",
  rpcUrl: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545",
  explorer: "",
  usdc: "" as Address, // resolved from the local deployment file
};

interface Deployment {
  predictionMarket: Address;
  basketVault: Address;
  trancheVault: Address;
  protectedNote: Address;
  usdc: Address;
  resolver: Address;
}

/** Empty/whitespace env values are treated as unset. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/**
 * Resolve deployed addresses. The per-chain deployment file is the source of truth (so the
 * local chain never accidentally uses the Arc addresses from the shared .env); env vars only
 * fill in keys the file doesn't provide.
 */
function resolveDeployment(chainId: number): Partial<Deployment> {
  const fromEnv = stripUndefined({
    predictionMarket: env("PREDICTION_MARKET_ADDRESS") as Address | undefined,
    basketVault: env("BASKET_VAULT_ADDRESS") as Address | undefined,
    trancheVault: env("TRANCHE_VAULT_ADDRESS") as Address | undefined,
    protectedNote: env("PROTECTED_NOTE_ADDRESS") as Address | undefined,
  });

  const file = resolve(repoRoot, "contracts/deployments", `${chainId}.json`);
  if (existsSync(file)) {
    const json = JSON.parse(readFileSync(file, "utf8")) as Partial<Deployment>;
    return { ...fromEnv, ...stripUndefined(json) }; // file wins
  }
  return fromEnv;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v != null && v !== ""),
  ) as Partial<T>;
}

const base = CHAIN === "local" ? LOCAL : ARC;
const deployment = resolveDeployment(base.chainId);

// ---------------------------------------------------------------------------
// Supabase passthrough.
//
// Persistence is OPTIONAL and degrades gracefully: when SUPABASE_URL /
// SUPABASE_SERVICE_KEY are unset (or placeholders), `supabaseConfigured` is
// false, the db client is null, and every query becomes a safe no-op so the
// backend still boots and serves on-chain + Polymarket data.
// ---------------------------------------------------------------------------
const supabaseUrl = env("SUPABASE_URL") || "";
// Server-side writes use the service-role key; the anon key is accepted as a
// read-only fallback so a misnamed env still partially works.
const supabaseServiceKey =
  env("SUPABASE_SERVICE_KEY") || env("SUPABASE_ANON_KEY") || "";

function isSupabasePlaceholder(url: string, key: string): boolean {
  if (!url || !key) return true;
  if (url.includes("placeholder") || url.includes("your_supabase")) return true;
  if (key.startsWith("placeholder") || key.startsWith("your_supabase"))
    return true;
  return false;
}

const supabaseConfigured = !isSupabasePlaceholder(
  supabaseUrl,
  supabaseServiceKey,
);

export const config = {
  chain: base.key,
  chainId: base.chainId,
  chainName: base.name,
  rpcUrl: base.rpcUrl,
  explorer: base.explorer,
  usdc: (deployment.usdc || base.usdc) as Address,
  predictionMarket: deployment.predictionMarket as Address | undefined,
  basketVault: deployment.basketVault as Address | undefined,
  trancheVault: deployment.trancheVault as Address | undefined,
  protectedNote: deployment.protectedNote as Address | undefined,
  resolver: deployment.resolver as Address | undefined,
  // The resolver signing key (the only server-owned key). On local, default to Anvil account #0 —
  // the account that `make deploy-local` uses as deployer + resolver and that holds the seeded
  // MockUSDC. On Arc, use the real funded deployer key.
  resolverKey: (base.key === "local"
    ? env("LOCAL_RESOLVER_PRIVATE_KEY") ||
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    : env("DEPLOYER_PRIVATE_KEY")) as `0x${string}` | undefined,
  port: Number(process.env.BACKEND_PORT || 13201),
  // Comma-separated allowlist; defaults to the local frontend dev origin.
  frontendOrigins: (process.env.FRONTEND_URL || "http://localhost:13200")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // --- Supabase persistence (optional; null-safe) ---
  supabaseUrl,
  supabaseServiceKey,
  supabaseConfigured,

  // --- Polymarket Gamma upstream ---
  polymarketApiUrl:
    env("POLYMARKET_API_URL") || "https://clob.polymarket.com",
  polymarketGammaUrl:
    env("POLYMARKET_GAMMA_URL") || "https://gamma-api.polymarket.com",

  // --- Receipts / evidence uploads ---
  // Raw bytes + JSON metadata land here (mirrors Cumulant backend/uploads).
  uploadsDir: env("UPLOADS_DIR") || resolve(repoRoot, "backend/uploads"),
  maxUploadBytes: Number(env("MAX_UPLOAD_BYTES") || 8 * 1024 * 1024), // 8 MB/file

  // --- Protocol fees & spreads (bps unless noted) ---
  // Identical financial constants to the Cumulant backend; only the gas/chain
  // layer differs. fees in bps are divided by FEE_BPS_DENOM (10_000).
  fees: {
    // Off-chain structuring fee charged on basket deposits (decimal, 0.5%).
    structuringFee: 0.005,
    // Basket vault deposit / redeem fees (bps).
    vaultDepositBps: 50, // 0.50%
    vaultRedeemBps: 30, // 0.30%
    // Distribution-market maker fee (bps) — taken on open + settle.
    distributionMakerBps: 30, // 0.30%
    // Tranche protocol fee per kind (bps) — scaled by duration at quote time.
    trancheProtocolBps: { senior: 25, mezzanine: 35, junior: 50 } as Record<
      "senior" | "mezzanine" | "junior",
      number
    >,
    // Market-maker spread / underwriting clamps (bps).
    mmSpreadMaxBps: 300,
    underwritingMaxBps: 200,
    // Underwriter cost-of-capital (decimal, annualised).
    underwritingCostOfCapital: 0.15,
  },
  // Shared denominator so callers never re-hardcode 10_000.
  feeBpsDenom: 10_000,

  // --- Misc thresholds ---
  // Hard cap on portfolio composer capital (USD).
  capitalCapUsd: 100_000,
  // Default protected-note maturity when the client omits one (days).
  defaultMaturityDays: 30,
} as const;

if (!config.supabaseConfigured) {
  console.warn(
    "[config] Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY unset or placeholder) — " +
      "DB queries are safe no-ops; on-chain + Polymarket data still served.",
  );
}

export function explorerTx(hash: string): string {
  return config.explorer ? `${config.explorer}/tx/${hash}` : hash;
}

export function explorerAddress(addr: string): string {
  return config.explorer ? `${config.explorer}/address/${addr}` : addr;
}

export interface DeployedAddresses {
  predictionMarket: Address;
  basketVault: Address;
  trancheVault: Address;
  protectedNote: Address;
  usdc: Address;
}

/** Returns the core deployed addresses, narrowed to non-nullable, or throws a clear error. */
export function requireContracts(): DeployedAddresses {
  if (
    !config.predictionMarket ||
    !config.basketVault ||
    !config.trancheVault ||
    !config.protectedNote
  ) {
    throw new Error(
      `Cumulant contracts not configured for chain "${config.chain}" (${config.chainId}). ` +
        `Run the deploy script to write contracts/deployments/${config.chainId}.json.`,
    );
  }
  return {
    predictionMarket: config.predictionMarket,
    basketVault: config.basketVault,
    trancheVault: config.trancheVault,
    protectedNote: config.protectedNote,
    usdc: config.usdc,
  };
}
