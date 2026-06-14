import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import { isAddress, getAddress } from "viem";
import { config, explorerTx } from "./config.js";
import { publicClient, resolverWallet, resolverAddress } from "./chain.js";
import { predictionMarketAbi } from "./abi/PredictionMarket.js";
import {
  getMarkets,
  getMarket,
  getBaskets,
  getBasket,
  getTranches,
  getTranche,
  getNotes,
  getNote,
  getPortfolio,
  getMarketCount,
  getBasketCount,
  getTrancheCount,
  getNoteCount,
  SIDE,
} from "./contracts.js";
import { getCuratedMarkets, getCuratedFunnel, refreshCurated } from "./services/markets-curated.js";
import { getLiveRawMarkets } from "./services/markets-live.js";
import { supabaseEnabled } from "./db/supabase.js";
import { startCronJobs } from "./services/cron.js";

// Product routers (each exported default from its file). On Arc there are NO
// backend-built transactions for user actions — users sign client-side. The
// `/prepare` endpoints are thin resolvers (return basket/tranche/note id + the
// vault CONTRACT ADDRESS to call); the `/confirm` endpoints RECORD a ledger row
// keyed by a client-provided EVM tx HASH. The only server signing stays in the
// resolver routes below.
import depositRouter from "./routes/deposit.js";
import ppnRouter from "./routes/ppn.js";
import portfolioRouter from "./routes/portfolio.js";
import vaultsRouter from "./routes/vaults.js";
import navRouter from "./routes/nav.js";
import distributionRouter from "./routes/distribution.js";
import marketsRouter from "./routes/markets.js";
import bundlesRouter from "./routes/bundles.js";
import flowRouter from "./routes/flow.js";
import faucetRouter from "./routes/faucet.js";
import mmRouter from "./routes/mm.js";
// (receipts/audit-trail feature removed upstream — mirrors Cumulant b205d60)

const app = express();
app.disable("x-powered-by");
app.use(helmet()); // security headers
app.use(express.json()); // bound request bodies

// CORS — treat localhost and 127.0.0.1 as the same dev host. The browser may load the
// frontend from either, and without this every cross-origin fetch fails ("backend not working").
const expandLoopback = (origins: string[]): string[] => {
  const out = new Set<string>();
  for (const o of origins) {
    out.add(o);
    if (o.includes("//localhost")) out.add(o.replace("//localhost", "//127.0.0.1"));
    else if (o.includes("//127.0.0.1")) out.add(o.replace("//127.0.0.1", "//localhost"));
  }
  return [...out];
};
const allowedOrigins = expandLoopback(config.frontendOrigins);
const isLoopback = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / same-origin / server-to-server
      if (allowedOrigins.length === 0) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // Always allow loopback origins in any environment — the dev host varies.
      if (isLoopback(origin)) return cb(null, true);
      // Reject by disallowing the CORS headers (cb(null,false)) rather than throwing — a thrown
      // error would hit Express's default handler and leak a stack trace / source path.
      return cb(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Rate limiting: a generous default for reads, a strict cap on the mutating resolver route.
app.use(
  rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false }),
);
const resolverLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

const ok = <T>(res: express.Response, data: T) => res.json({ ok: true, data });
const fail = (res: express.Response, status: number, error: string) =>
  res.status(status).json({ ok: false, error });

/** Sanitize errors so internal RPC/viem details never leak to clients. */
function safeError(e: unknown): string {
  if (!(e instanceof Error)) return "internal error";
  // Surface a contract revert reason if present (useful, safe UX); otherwise stay generic.
  const m = /(reverted|revert reason|custom error|execution reverted)[:.]?\s*([^\n]*)/i.exec(
    e.message,
  );
  if (m) return `transaction reverted: ${m[2]?.slice(0, 160) || ""}`.trim();
  const first = e.message.split("\n")[0]?.slice(0, 160) ?? "internal error";
  // Drop anything that looks like an internal URL / version / request dump.
  return /https?:\/\/|viem@|Request Arguments|0x[0-9a-f]{40,}/i.test(first)
    ? "internal error"
    : first;
}

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e: unknown) => {
      console.error(`[${req.method} ${req.path}]`, e); // full detail server-side only
      fail(res, 500, safeError(e));
    });

// ── Meta ─────────────────────────────────────────────────────────────────────

/** Public chain + contract config for the frontend to bootstrap from. */
app.get("/api/config", (_req, res) =>
  ok(res, {
    chain: config.chain,
    chainId: config.chainId,
    chainName: config.chainName,
    rpcUrl: config.rpcUrl,
    explorer: config.explorer,
    usdc: config.usdc,
    predictionMarket: config.predictionMarket ?? null,
    basketVault: config.basketVault ?? null,
    trancheVault: config.trancheVault ?? null,
    protectedNote: config.protectedNote ?? null,
    resolver: resolverAddress() ?? config.resolver ?? null,
    deployed: Boolean(
      config.predictionMarket &&
        config.basketVault &&
        config.trancheVault &&
        config.protectedNote,
    ),
  }),
);

app.get(
  "/api/health",
  wrap(async (_req, res) => {
    const deployed = Boolean(
      config.predictionMarket &&
        config.basketVault &&
        config.trancheVault &&
        config.protectedNote,
    );
    const blockNumber = await publicClient.getBlockNumber().catch(() => null);
    let markets = 0;
    let baskets = 0;
    let tranches = 0;
    let notes = 0;
    if (deployed) {
      [markets, baskets, tranches, notes] = await Promise.all([
        getMarketCount().catch(() => 0),
        getBasketCount().catch(() => 0),
        getTrancheCount().catch(() => 0),
        getNoteCount().catch(() => 0),
      ]);
    }
    ok(res, {
      status: blockNumber != null ? "ok" : "degraded",
      chain: config.chainName,
      chainId: config.chainId,
      blockNumber: blockNumber?.toString() ?? null,
      contractsDeployed: deployed,
      supabaseConfigured: config.supabaseConfigured,
      markets,
      baskets,
      tranches,
      notes,
      resolverConfigured: Boolean(config.resolverKey),
    });
  }),
);

// ── Markets ──────────────────────────────────────────────────────────────────
// The ported frontend's live-baskets fetches GET /api/markets?active=true and
// expects the Polymarket Gamma shape ({ markets: RawMarket[] } with outcomePrices,
// volume, tokens, event_id, …). So the bare /api/markets route serves the LIVE
// Polymarket feed; the on-chain market list moved to /api/markets/onchain.

// RAW { markets } (no { ok, data } envelope) — the ported live-baskets reads
// `body.markets` directly, matching the upstream Polymarket feed shape.
app.get(
  "/api/markets",
  wrap(async (_req, res) => res.json({ markets: await getLiveRawMarkets() })),
);

// On-chain (Arc) market list — formerly at /api/markets. Registered before
// "/api/markets/:id" so "onchain" isn't matched as an id.
app.get(
  "/api/markets/onchain",
  wrap(async (_req, res) => ok(res, await getMarkets())),
);

// Curated live market book from Polymarket (Cumulant pattern). Registered before
// "/api/markets/:id" so "curated" isn't matched as an id.
app.get(
  "/api/markets/curated",
  wrap(async (_req, res) => ok(res, await getCuratedMarkets())),
);
app.get("/api/markets/curated/stats", (_req, res) => ok(res, getCuratedFunnel()));

// Raw live market feed for the client-side basket assembler (Cumulant pattern).
app.get(
  "/api/markets/live",
  wrap(async (_req, res) => ok(res, { markets: await getLiveRawMarkets() })),
);

app.get(
  "/api/markets/:id(\\d+)",
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return fail(res, 400, "bad market id");
    const count = await getMarketCount();
    if (id >= count) return fail(res, 404, "unknown market");
    ok(res, await getMarket(id));
  }),
);

// Markets router supplies the remaining Polymarket subpaths (/orderbooks,
// /search/:query, and the Gamma /:conditionId lookup). Mounted AFTER the explicit
// handlers above so those (/, /onchain, /curated, /curated/stats, /live, numeric
// /:id) win and the router only fills in what isn't already served.
app.use("/api/markets", marketsRouter);

// ── Baskets ──────────────────────────────────────────────────────────────────

app.get(
  "/api/baskets",
  wrap(async (_req, res) => ok(res, await getBaskets())),
);

app.get(
  "/api/baskets/:id",
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return fail(res, 400, "bad basket id");
    const count = await getBasketCount();
    if (id >= count) return fail(res, 404, "unknown basket");
    ok(res, await getBasket(id));
  }),
);

// ── Tranches ─────────────────────────────────────────────────────────────────

app.get(
  "/api/tranches",
  wrap(async (_req, res) => ok(res, await getTranches())),
);

app.get(
  "/api/tranches/:id",
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return fail(res, 400, "bad tranche id");
    if (id >= (await getTrancheCount())) return fail(res, 404, "unknown tranche");
    ok(res, await getTranche(id));
  }),
);

// ── Protected notes ──────────────────────────────────────────────────────────

app.get(
  "/api/notes",
  wrap(async (_req, res) => ok(res, await getNotes())),
);

app.get(
  "/api/notes/:id",
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return fail(res, 400, "bad note id");
    if (id >= (await getNoteCount())) return fail(res, 404, "unknown note");
    ok(res, await getNote(id));
  }),
);

// ── Product routers ────────────────────────────────────────────────────────────
// Basket-vault deposit/redeem (prepare = thin resolver, confirm = ledger row by
// EVM tx hash). PPN/tranche notes. Receipts evidence layer. Yield/vault reader.
// Live NAV history. Distribution markets (RAW JSON, no envelope). Portfolio
// composer (POST /construct) + the on-chain GET /:address (on the same mount).
app.use("/api/bundles", bundlesRouter);
app.use("/api/deposit", depositRouter);
app.use("/api/ppn", ppnRouter);
app.use("/api/vaults", vaultsRouter);
app.use("/api/nav", navRouter);
app.use("/api/distribution", distributionRouter);
app.use("/api/portfolio", portfolioRouter);
// Dynamic Flow: HMAC-verified cross-chain deposit settlement → on-chain deposit gate.
app.use("/api/flow", flowRouter);
// Test-USDC faucet: mint 10,000 MockUSDC to a connected wallet (deployer-signed gas).
app.use("/api/faucet", faucetRouter);
// MM secondary market: owner-signed pre-settlement bid quotes for sellToMM (off-chain
// pricing/signing; the user submits the sell on-chain). Buys + sells settle on chain.
app.use("/api/mm", mmRouter);

// ── Resolver (server-owned admin role only) ──────────────────────────────────
// This is the ONLY signing the backend does. User trading is wallet-signed client-side.

function resolverAuthorized(req: express.Request): boolean {
  const secret = process.env.RESOLVER_API_SECRET;
  if (!secret) {
    // No secret configured: allow ONLY on a local dev chain. Never fail open on
    // a public chain (Arc) — an unset secret there must reject, not hand anyone
    // the server-signed resolve/void role.
    return config.chain === "local";
  }
  const provided = req.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Constant-time comparison (equal-length guard first) so the secret can't be
  // recovered via response-timing.
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post(
  "/api/resolver/resolve",
  resolverLimiter,
  wrap(async (req, res) => {
    if (!resolverAuthorized(req)) return fail(res, 401, "unauthorized");
    const wallet = resolverWallet();
    const pm = config.predictionMarket;
    if (!wallet || !pm)
      return fail(res, 503, "resolver key or contracts not configured");

    const { marketId, outcome } = req.body ?? {};
    const id = Number(marketId);
    const side =
      String(outcome).toUpperCase() === "YES"
        ? SIDE.Yes
        : String(outcome).toUpperCase() === "NO"
          ? SIDE.No
          : null;
    if (!Number.isInteger(id) || id < 0) return fail(res, 400, "bad marketId");
    if (side === null) return fail(res, 400, "outcome must be YES or NO");

    const hash = await wallet.writeContract({
      address: pm,
      abi: predictionMarketAbi,
      functionName: "resolve",
      args: [BigInt(id), side],
      chain: wallet.chain,
      account: wallet.account!,
    });
    ok(res, { hash, explorer: explorerTx(hash), marketId: id, outcome });
  }),
);

/** Void a market (liveness escape): settles with no winner so everyone is refunded. */
app.post(
  "/api/resolver/void",
  resolverLimiter,
  wrap(async (req, res) => {
    if (!resolverAuthorized(req)) return fail(res, 401, "unauthorized");
    const wallet = resolverWallet();
    const pm = config.predictionMarket;
    if (!wallet || !pm) return fail(res, 503, "resolver key or contracts not configured");

    const id = Number(req.body?.marketId);
    if (!Number.isInteger(id) || id < 0) return fail(res, 400, "bad marketId");

    const hash = await wallet.writeContract({
      address: pm,
      abi: predictionMarketAbi,
      functionName: "voidMarket",
      args: [BigInt(id)],
      chain: wallet.chain,
      account: wallet.account!,
    });
    ok(res, { hash, explorer: explorerTx(hash), marketId: id, voided: true });
  }),
);

// Unknown routes → JSON 404 (instead of Express's default HTML "Cannot GET ...").
app.use((_req, res) => fail(res, 404, "not found"));

// Final error handler — catches errors thrown by middleware (malformed JSON, oversized body, etc.)
// that bypass the per-route wrap(). Returns a sanitized JSON error, never a stack trace or path.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[unhandled]", err); // full detail server-side only
    const e = err as { type?: string; status?: number; statusCode?: number } | undefined;
    const status =
      e?.type === "entity.too.large"
        ? 413
        : err instanceof SyntaxError || e?.status === 400 || e?.statusCode === 400
          ? 400
          : 500;
    res.status(status).json({ ok: false, error: safeError(err) });
  },
);

// Process-level guards so a stray async rejection can never silently crash the server.
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

app.listen(config.port, () => {
  console.log(
    `Cumulant backend on :${config.port} — chain=${config.chainName} (${config.chainId})` +
      (config.predictionMarket ? "" : "  [contracts not yet deployed]") +
      (supabaseEnabled ? "" : "  [supabase off — on-chain + Polymarket only]"),
  );
  // Warm the curated Polymarket book and refresh it on a timer (no on-chain seeding needed).
  void refreshCurated();
  setInterval(() => void refreshCurated(), 120_000).unref();
  // Cron NAV recorder: warms the vault-price cache always, and schedules the
  // bundle/NAV refresh only when Supabase is configured (no-op otherwise).
  if (supabaseEnabled) startCronJobs();
});

export default app;
