"use client";

import React from "react";
import { C, FM, trancheColor } from "@/lib/tokens";
import { betaShapeMatching } from "@/lib/tranche-stats";

/**
 * Outcome-distribution chart for a risk slice: a moment-matched Beta density of
 * the basket's terminal NAV, with the area beneath it shaded into the SENIOR
 * (paid first, low-outcome) and JUNIOR (first-loss / leveraged residual,
 * high-outcome) slices, split at the senior/junior boundary. A teal NAV line
 * marks the expected outcome. Mirrors the predecessor app's tranche viz.
 */
export function TrancheCurve({
  nav,
  sigma,
  seniorShare,
  height = 300,
}: {
  nav: number;
  sigma: number;
  seniorShare: number; // senior principal / total, in [0,1]
  height?: number;
}) {
  const W = 760;
  const H = height;
  const padL = 16;
  const padR = 16;
  const padT = 22;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseline = padT + plotH;

  const mu = Math.max(0.001, Math.min(0.999, nav));
  const sig = Math.max(0.01, sigma);
  const lo = Math.max(0, mu - 3 * sig);
  const hi = Math.min(1, mu + 3 * sig);
  const span = Math.max(0.01, hi - lo);

  const shape = betaShapeMatching(mu, sig);
  const N = 240;
  const xOf = (val: number) => padL + (plotW * (Math.max(lo, Math.min(hi, val)) - lo)) / span;
  const raw: Array<{ x: number; val: number; d: number }> = [];
  let maxD = 0;
  for (let i = 0; i <= N; i++) {
    const val = lo + (span * i) / N;
    const d = shape(val);
    if (d > maxD) maxD = d;
    raw.push({ x: padL + (plotW * i) / N, val, d });
  }
  const yOf = (d: number) => padT + (1 - d / Math.max(1e-9, maxD)) * plotH;
  const pts = raw.map((p) => ({ x: p.x, val: p.val, y: yOf(p.d) }));

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

  // Senior occupies the low-outcome slice (paid first); junior the high-outcome residual.
  const k = Math.max(lo + span * 0.05, Math.min(hi - span * 0.05, lo + span * Math.max(0.05, Math.min(0.95, seniorShare))));
  const areaPath = (a: number, b: number) => {
    const slice = pts.filter((p) => p.val >= a - 1e-9 && p.val <= b + 1e-9);
    if (slice.length === 0) return "";
    let d = `M ${xOf(a).toFixed(2)} ${baseline.toFixed(2)} `;
    for (const p of slice) d += `L ${p.x.toFixed(2)} ${p.y.toFixed(2)} `;
    d += `L ${xOf(b).toFixed(2)} ${baseline.toFixed(2)} Z`;
    return d;
  };

  const senior = trancheColor("senior");
  const junior = trancheColor("junior");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Outcome distribution by tranche" style={{ display: "block" }}>
      <defs>
        <linearGradient id="trc-senior" gradientUnits="userSpaceOnUse" x1="0" y1={padT} x2="0" y2={baseline}>
          <stop offset="0%" stopColor={senior} stopOpacity="0.55" />
          <stop offset="55%" stopColor={senior} stopOpacity="0.18" />
          <stop offset="100%" stopColor={senior} stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id="trc-junior" gradientUnits="userSpaceOnUse" x1="0" y1={padT} x2="0" y2={baseline}>
          <stop offset="0%" stopColor={junior} stopOpacity="0.55" />
          <stop offset="55%" stopColor={junior} stopOpacity="0.18" />
          <stop offset="100%" stopColor={junior} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* baseline */}
      <line x1={padL} x2={W - padR} y1={baseline} y2={baseline} stroke={C.border} strokeWidth="1" opacity="0.7" />

      {/* tranche slice fills */}
      <path d={areaPath(lo, k)} fill="url(#trc-senior)" />
      <path d={areaPath(k, hi)} fill="url(#trc-junior)" />

      {/* density line */}
      <path d={linePath} fill="none" stroke={C.textPrimary} strokeWidth="1.5" strokeOpacity="0.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

      {/* boundary line */}
      <line x1={xOf(k)} x2={xOf(k)} y1={padT} y2={baseline} stroke={C.textMuted} strokeWidth="1" strokeDasharray="3 4" opacity="0.6" />

      {/* NAV line */}
      <line x1={xOf(mu)} x2={xOf(mu)} y1={padT} y2={baseline} stroke={C.tealLight} strokeWidth="1.4" opacity="0.9" />
      <text x={xOf(mu)} y={padT - 7} textAnchor="middle" fontFamily={FM} fontSize="11" fill={C.tealLight} fontWeight={500}>
        NAV {(mu * 100).toFixed(1)}%
      </text>

      {/* x-axis ticks: window edges + the senior/junior boundary */}
      {[
        { v: lo, label: `${(lo * 100).toFixed(0)}%`, anchor: "start" as const, fill: C.textMuted },
        { v: k, label: `${(k * 100).toFixed(0)}%`, anchor: "middle" as const, fill: senior },
        { v: hi, label: `${(hi * 100).toFixed(0)}%`, anchor: "end" as const, fill: C.textMuted },
      ].map((t, i) => (
        <text key={i} x={xOf(t.v)} y={baseline + 18} textAnchor={t.anchor} fontFamily={FM} fontSize="10" fill={t.fill} opacity="0.9">
          {t.label}
        </text>
      ))}
    </svg>
  );
}
