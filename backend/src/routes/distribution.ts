/**
 * Distribution-markets router (Cumulant on Circle Arc).
 *
 * Mounted at `/api/distribution` by the Wire phase (index.ts). Exposes TWO
 * surfaces, both returning RAW JSON (no { ok, data } envelope) to match the
 * ported frontend distribution clients:
 *
 *   DISCRETE  — live Polymarket-derived launch candidates + USDC quoting:
 *     GET  /health
 *     GET  /candidates            -> { candidates, funnel, fetched_at }
 *     GET  /templates             -> backward-compatible alias of /candidates
 *     POST /quote                 -> { quote }
 *     POST /launch-plan           -> { plan }
 *
 *   CONTINUOUS — Normal(mu,sigma) distribution markets, constant-L2 AMM:
 *     GET  /continuous/markets            -> { markets }
 *     POST /continuous/seed-liquidity     -> { market_id, pool_liquidity_usdc, seeded_usdc }
 *     POST /continuous/seed-all           -> { count, seeded }
 *     POST /continuous/quote              -> ContinuousQuote (+ market_id/question/unit)
 *     POST /continuous/open/prepare       -> PreparedOpen (thin resolver, no tx bytes)
 *     POST /continuous/open/confirm       -> { confirmed, position }
 *     POST /continuous/settle             -> SettleResult
 *     POST /continuous/close              -> CloseResult
 *     GET  /continuous/positions/:owner   -> { positions }
 *
 * On Arc users sign their own txs client-side; the only place a hash matters is
 * `/continuous/open/confirm`, which RECORDS a position keyed by a client-provided
 * EVM tx hash that the continuous service verifies landed on-chain. `prepare` is
 * a thin resolver returning the quote + the treasury/USDC the client should pay.
 */
import { Router, type Request, type Response } from 'express';
import {
  buildDistributionLaunchPlan,
  discoverDistributionCandidates,
  quoteDistributionCandidate,
  DistributionInputError,
} from '../services/distribution.js';
import {
  listContinuousMarkets,
  listContinuousMarketsLive,
  quoteContinuous,
  prepareContinuousOpen,
  confirmContinuousOpen,
  listContinuousPositions,
  settleContinuousPosition,
  closeContinuousPosition,
  seedLiquidity,
  seedAllRandom,
} from '../services/distribution-continuous.js';
import { resolverAuthorized, verifyWalletAuth } from '../services/auth.js';

const router = Router();

// ── Input helpers ────────────────────────────────────────────────────────────

/** An EVM address: 0x + 40 hex chars. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** An EVM tx hash: 0x + 64 hex chars (the 66-char "0x…" string the task spec describes). */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function numberQuery(req: Request, key: string): number | undefined {
  const value = req.query[key];
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function bodyNumber(req: Request, key: string): number {
  const n = Number(req.body?.[key]);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
}

function bodyWeights(req: Request): number[] {
  const raw = req.body?.weights;
  if (!Array.isArray(raw)) throw new Error('weights must be an array');
  if (!raw.every((w: unknown) => Number.isFinite(Number(w)))) {
    throw new Error('weights must be finite numbers');
  }
  return raw.map(Number);
}

function bodyString(req: Request, ...keys: string[]): string {
  for (const k of keys) {
    const v = req.body?.[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/** Validate + normalise an EVM wallet address from the request body. */
function bodyAddress(req: Request, key = 'wallet_address'): string {
  const owner = bodyString(req, key).trim();
  if (!ADDRESS_RE.test(owner)) throw new Error('wallet_address (0x + 40 hex) is required');
  return owner;
}

/**
 * Sanitised error responder — never leaks a stack trace. Honors a
 * DistributionInputError's status code; everything else is a 400 with the
 * error's own message (services throw plain, user-safe messages).
 */
function errorResponse(res: Response, err: unknown): Response {
  if (err instanceof DistributionInputError) {
    return res.status(err.status).json({ error: err.message });
  }
  const message =
    err instanceof Error && typeof err.message === 'string' && err.message.length > 0
      ? err.message
      : 'Unknown distribution market error';
  return res.status(400).json({ error: message });
}

// ===========================================================================
// DISCRETE distribution markets (live Polymarket discovery + USDC quoting)
// ===========================================================================

router.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    product: 'distribution-markets',
    mode: 'dynamic-live-discovery',
    source: 'polymarket-gamma-and-clob',
  });
});

router.get('/candidates', async (req, res) => {
  try {
    const result = await discoverDistributionCandidates({
      limit: numberQuery(req, 'limit') ?? 12,
      minVolumeUsd: numberQuery(req, 'min_volume'),
      minDepthUsd: numberQuery(req, 'min_depth'),
      minDays: numberQuery(req, 'min_days'),
      maxDays: numberQuery(req, 'max_days'),
      forceRefresh: req.query.refresh === 'true',
    });
    res.json(result);
  } catch (err) {
    errorResponse(res, err);
  }
});

// Backward-compatible alias. This now returns live launch candidates, not
// hardcoded templates.
router.get('/templates', async (req, res) => {
  try {
    const result = await discoverDistributionCandidates({
      limit: numberQuery(req, 'limit') ?? 12,
      minVolumeUsd: numberQuery(req, 'min_volume'),
      minDepthUsd: numberQuery(req, 'min_depth'),
      minDays: numberQuery(req, 'min_days'),
      maxDays: numberQuery(req, 'max_days'),
      forceRefresh: req.query.refresh === 'true',
    });
    res.json({ ...result, templates: result.candidates });
  } catch (err) {
    errorResponse(res, err);
  }
});

router.post('/quote', async (req, res) => {
  try {
    const quote = await quoteDistributionCandidate({
      candidateId: bodyString(req, 'candidate_id', 'market_id'),
      weights: bodyWeights(req),
      collateralUsdc: bodyNumber(req, 'collateral_usdc'),
    });
    res.json({ quote });
  } catch (err) {
    errorResponse(res, err);
  }
});

router.post('/launch-plan', async (req, res) => {
  try {
    const plan = await buildDistributionLaunchPlan(bodyString(req, 'candidate_id'));
    res.json({ plan });
  } catch (err) {
    errorResponse(res, err);
  }
});

// ===========================================================================
// CONTINUOUS distribution markets (Normal mu/sigma, constant-L2 AMM)
// ===========================================================================

router.get('/continuous/markets', async (_req, res) => {
  try {
    // Live Polymarket-derived forwards (cached); falls back to synthetic.
    res.json({ markets: await listContinuousMarketsLive() });
  } catch {
    res.json({ markets: listContinuousMarkets() });
  }
});

/** Seed simulated AMM liquidity into a market's pool. ADMIN ONLY — mutates pool state. */
router.post('/continuous/seed-liquidity', (req, res) => {
  try {
    if (!resolverAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const marketId = bodyString(req, 'market_id');
    if (!marketId) throw new Error('market_id is required');
    res.json(seedLiquidity(marketId, bodyNumber(req, 'amount_usdc')));
  } catch (err) {
    errorResponse(res, err);
  }
});

/** Seed a random 5–6 figure position into every market pool at once. ADMIN ONLY. */
router.post('/continuous/seed-all', (req, res) => {
  try {
    if (!resolverAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    res.json(seedAllRandom());
  } catch (err) {
    errorResponse(res, err);
  }
});

router.post('/continuous/quote', (req, res) => {
  try {
    const marketId = bodyString(req, 'market_id');
    if (!marketId) throw new Error('market_id is required');
    res.json(
      quoteContinuous({
        marketId,
        targetMu: bodyNumber(req, 'target_mu'),
        targetSigma: bodyNumber(req, 'target_sigma'),
        collateralUsdc: bodyNumber(req, 'collateral_usdc'),
      }),
    );
  } catch (err) {
    errorResponse(res, err);
  }
});

/**
 * Thin resolver: returns the quote + the treasury address and USDC token the
 * client should transfer. There are NO server-built tx bytes on Arc — the
 * client constructs + signs the USDC transfer itself.
 */
router.post('/continuous/open/prepare', async (req, res) => {
  try {
    const owner = bodyAddress(req);
    const marketId = bodyString(req, 'market_id');
    if (!marketId) throw new Error('market_id is required');
    res.json(
      await prepareContinuousOpen({
        owner,
        marketId,
        targetMu: bodyNumber(req, 'target_mu'),
        targetSigma: bodyNumber(req, 'target_sigma'),
        collateralUsdc: bodyNumber(req, 'collateral_usdc'),
      }),
    );
  } catch (err) {
    errorResponse(res, err);
  }
});

/**
 * Record the position after the wallet executed the on-chain escrow. The client
 * supplies the EVM tx hash; the continuous service verifies it landed on-chain.
 */
router.post('/continuous/open/confirm', async (req, res) => {
  try {
    const owner = bodyAddress(req);
    const marketId = bodyString(req, 'market_id');
    if (!marketId) throw new Error('market_id is required');
    const hash = bodyString(req, 'tx_hash', 'signature').trim();
    if (!TX_HASH_RE.test(hash)) {
      throw new Error('tx_hash (0x + 64 hex) is required');
    }
    const position = await confirmContinuousOpen({
      owner,
      marketId,
      targetMu: bodyNumber(req, 'target_mu'),
      targetSigma: bodyNumber(req, 'target_sigma'),
      collateralUsdc: bodyNumber(req, 'collateral_usdc'),
      tx_hash: hash,
    });
    res.json({ confirmed: true, position });
  } catch (err) {
    errorResponse(res, err);
  }
});

/** Settle a position: the realized net (g(x*)-f(x*)) is computed + recorded. */
router.post('/continuous/settle', async (req, res) => {
  try {
    const owner = bodyAddress(req);
    const positionId = bodyString(req, 'position_id');
    if (!positionId) throw new Error('position_id is required');
    // AUTH: owner+position_id in the body is NOT authentication. The caller must
    // prove control of `owner` with a wallet signature (fail-closed on Arc).
    const authed = await verifyWalletAuth({
      owner,
      action: 'distribution-settle',
      ref: positionId,
      deadline: Number(req.body?.deadline) || undefined,
      signature: bodyString(req, 'signature') || undefined,
    });
    if (!authed) return res.status(401).json({ error: 'unauthorized: wallet signature required' });
    res.json(await settleContinuousPosition({ owner, positionId }));
  } catch (err) {
    errorResponse(res, err);
  }
});

/**
 * Sell/close a position before settlement: unwind through the AMM (mark-to-f
 * minus maker fee + price-impact slippage). The net is tracked off-chain.
 */
router.post('/continuous/close', async (req, res) => {
  try {
    const owner = bodyAddress(req);
    const positionId = bodyString(req, 'position_id');
    if (!positionId) throw new Error('position_id is required');
    const authed = await verifyWalletAuth({
      owner,
      action: 'distribution-close',
      ref: positionId,
      deadline: Number(req.body?.deadline) || undefined,
      signature: bodyString(req, 'signature') || undefined,
    });
    if (!authed) return res.status(401).json({ error: 'unauthorized: wallet signature required' });
    res.json(await closeContinuousPosition({ owner, positionId }));
  } catch (err) {
    errorResponse(res, err);
  }
});

router.get('/continuous/positions/:owner', (req, res) => {
  try {
    const owner = String(req.params.owner ?? '').trim();
    if (!ADDRESS_RE.test(owner)) throw new Error('owner (0x + 40 hex) is required');
    res.json({ positions: listContinuousPositions(owner) });
  } catch (err) {
    errorResponse(res, err);
  }
});

export default router;
