/**
 * Lightweight basket-outcome statistics for the Risk Slices distribution chart.
 *
 * A basket's terminal NAV is the weighted sum of independent Bernoulli legs, so
 * its first two moments are closed-form:
 *   nav (μ) = Σ wᵢ·pᵢ
 *   σ²      = Σ wᵢ²·pᵢ·(1 − pᵢ)
 * We then fit a Beta(α,β) with those moments to draw a bounded [0,1] outcome
 * density (falling back to a Normal when the variance exceeds Beta's support).
 * This is the same moment-matched curve the predecessor app shaded by tranche.
 */

export interface BasketStat {
  nav: number;
  sigma: number;
}

export type LegLike = { weightPct: number; side: "YES" | "NO" | "NONE"; impliedYes: number };

/** Compute (nav, sigma) for a basket of weighted YES/NO legs against live odds. */
export function basketStat(legs: LegLike[]): BasketStat {
  const raw = legs.map((l) => Math.max(0, l.weightPct));
  const wSum = raw.reduce((a, b) => a + b, 0) || 1;
  let mu = 0;
  let variance = 0;
  for (let i = 0; i < legs.length; i++) {
    const w = raw[i] / wSum;
    const yes = Math.max(0.001, Math.min(0.999, legs[i].impliedYes));
    const p = legs[i].side === "NO" ? 1 - yes : yes;
    mu += w * p;
    variance += w * w * p * (1 - p);
  }
  if (legs.length === 0) {
    return { nav: 0.5, sigma: 0.08 };
  }
  return {
    nav: Math.max(0.001, Math.min(0.999, mu)),
    sigma: Math.max(0.01, Math.sqrt(Math.max(1e-8, variance))),
  };
}

function stdNormalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

// Lanczos approximation for ln Γ(x), x > 0.
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/** Moment-matched Beta(α,β) density on (0,1); falls back to Normal when invalid. */
export function betaShapeMatching(mu: number, sigma: number): (x: number) => number {
  const m = Math.max(0.001, Math.min(0.999, mu));
  const v = Math.max(1e-6, sigma * sigma);
  const denom = m * (1 - m);
  if (v >= denom) {
    return (x: number) => stdNormalPdf((x - m) / sigma) / sigma;
  }
  const s = denom / v - 1;
  const alpha = m * s;
  const beta = (1 - m) * s;
  const logB = logBeta(alpha, beta);
  return (x: number) => {
    if (x <= 0 || x >= 1) return 0;
    return Math.exp((alpha - 1) * Math.log(x) + (beta - 1) * Math.log(1 - x) - logB);
  };
}
