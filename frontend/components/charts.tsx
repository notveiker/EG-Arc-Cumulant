"use client";
/**
 * Shared chart + card primitives — the Cumulant
 * surfaces use the exact same graphs (Sparkline), metric tiles and pills.
 */
import React, { useEffect, useRef, useState } from "react";
import { C, FM, FS, FD, EASE, lightenColor, darkenColor } from "@/lib/tokens";

export function Sparkline({
  data,
  color,
  height = 48,
  width,
}: {
  data: number[];
  color: string;
  height?: number;
  width?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    if (width !== undefined) return;
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.max(1, Math.round(entries[0].contentRect.width));
      setMeasured(w);
    });
    ro.observe(el);
    setMeasured(Math.max(1, Math.round(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, [width]);

  const renderWidth = width ?? measured;

  useEffect(() => {
    const c = ref.current;
    if (!c || !renderWidth) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = renderWidth * dpr;
    c.height = height * dpr;
    c.style.width = renderWidth + "px";
    c.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderWidth, height);
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 0.01;
    const pad = 3;
    const pts = data.map((v, i) => ({
      x: pad + (i / (data.length - 1)) * (renderWidth - pad * 2),
      y: pad + (1 - (v - min) / range) * (height - pad * 2),
    }));
    const big = height >= 80;
    const last = pts[pts.length - 1];

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const m = { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
      ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, m.x, m.y);
    }
    ctx.lineTo(last.x, last.y);
    ctx.lineTo(last.x, height);
    ctx.lineTo(pts[0].x, height);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad, 0, height);
    grad.addColorStop(0, color + (big ? "30" : "20"));
    grad.addColorStop(1, color + "00");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const m = { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
      ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, m.x, m.y);
    }
    ctx.lineTo(last.x, last.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = big ? 2 : 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (big) {
      ctx.shadowColor = color + "66";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.shadowOffsetY = 0;

    if (big) {
      ctx.beginPath();
      ctx.arc(last.x, last.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }, [data, color, height, renderWidth]);

  return (
    <div ref={wrapRef} style={{ display: "block", width: "100%", height: height + "px", position: "relative" }}>
      <canvas ref={ref} style={{ display: "block" }} />
    </div>
  );
}

/** SVG area chart with a real Y-axis (gridlines + value labels) — for the surface detail panels.
 *  The series is an illustrative path (no on-chain history indexer yet); the y-axis anchors it to
 *  a readable scale so the line isn't floating. Width is measured so the SVG stays crisp. */
export function AreaChart({
  data,
  color,
  height = 150,
  unit = "%",
}: {
  data: number[];
  color: string;
  height?: number;
  unit?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(1, Math.round(e[0].contentRect.width))));
    ro.observe(el);
    setW(Math.max(1, Math.round(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);

  // A percentage axis (NAV is a probability) must stay within 0–100; clamp the series + bounds.
  const series = unit === "%" ? data.map((v) => Math.max(0, Math.min(100, v))) : data;
  const n = series.length;
  // Guard: an empty series would make Math.min/max return ±Infinity and produce a NaN path.
  if (n === 0) return <div ref={wrapRef} style={{ width: "100%", height }} />;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const lo = Math.max(unit === "%" ? 0 : -Infinity, min - span * 0.14);
  const hi = Math.min(unit === "%" ? 100 : Infinity, max + span * 0.14);
  const padL = 42, padR = 10, padT = 10, padB = 14;
  const W = w ?? 600;
  const plotW = Math.max(1, W - padL - padR);
  const plotH = height - padT - padB;
  const X = (i: number) => padL + (i / (n - 1)) * plotW;
  const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

  const pts = series.map((v, i) => [X(i), Y(v)] as const);
  let line = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < n; i++) {
    const mx = (pts[i - 1][0] + pts[i][0]) / 2;
    const my = (pts[i - 1][1] + pts[i][1]) / 2;
    line += ` Q ${pts[i - 1][0].toFixed(1)} ${pts[i - 1][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  line += ` L ${pts[n - 1][0].toFixed(1)} ${pts[n - 1][1].toFixed(1)}`;
  const area = `${line} L ${X(n - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L ${X(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;
  const ticks = [0, 1, 2, 3].map((k) => lo + (hi - lo) * (k / 3));
  const gid = `ac-${color.replace("#", "")}-${height}`;

  return (
    <div ref={wrapRef} style={{ width: "100%", height }}>
      {w && (
        <svg width={w} height={height} style={{ display: "block" }} role="img" aria-label="NAV chart">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((tv, k) => (
            <g key={k}>
              <line
                x1={padL} x2={W - padR} y1={Y(tv)} y2={Y(tv)}
                stroke={C.border} strokeWidth="1"
                strokeDasharray={k === 0 ? undefined : "2 4"} opacity={k === 0 ? 0.9 : 0.5}
              />
              <text x={padL - 8} y={Y(tv) + 3} textAnchor="end" fill={C.textMuted} fontFamily={FM} fontSize="9">
                {tv.toFixed(tv >= 100 ? 0 : 1)}{unit}
              </text>
            </g>
          ))}
          <path d={area} fill={`url(#${gid})`} />
          <path
            d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 4px ${color}55)` }}
          />
          <circle cx={X(n - 1)} cy={Y(series[n - 1])} r="3.2" fill={color} />
        </svg>
      )}
    </div>
  );
}

export function PulseGauge({ prob, color, size = 56 }: { prob: number; color: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    c.style.width = size + "px";
    c.style.height = size + "px";
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(79, 227, 208, 0.12)";
    ctx.lineCap = "round";
    ctx.stroke();
    const endAngle = Math.PI * 0.75 + (prob / 100) * Math.PI * 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.75, endAngle);
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.stroke();
  }, [prob, color, size]);
  return <canvas ref={ref} />;
}

function polarToCartesian(cx: number, cy: number, r: number, angleRad: number) {
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}
function arcPath(cx: number, cy: number, rOuter: number, rInner: number, startAngle: number, endAngle: number) {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const start = polarToCartesian(cx, cy, rOuter, startAngle);
  const end = polarToCartesian(cx, cy, rOuter, endAngle);
  const startIn = polarToCartesian(cx, cy, rInner, endAngle);
  const endIn = polarToCartesian(cx, cy, rInner, startAngle);
  return `M ${start.x} ${start.y} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${end.x} ${end.y} L ${startIn.x} ${startIn.y} A ${rInner} ${rInner} 0 ${largeArc} 0 ${endIn.x} ${endIn.y} Z`;
}

export function SvgDonut({
  data,
  size,
  activeId,
  onHover,
  isEmpty,
}: {
  data: { id: string; value: number; color: string }[];
  size: number;
  activeId: string | null;
  onHover: (id: string | null) => void;
  isEmpty?: boolean;
}) {
  const PAD = 32;
  const TOTAL = size + PAD * 2;
  const cx = TOTAL / 2;
  const cy = TOTAL / 2;
  const baseR = size * 0.355;
  const thickness = size * 0.11;
  const gap = 0.024;

  if (isEmpty || data.length === 0) {
    return (
      <svg width={TOTAL} height={TOTAL} style={{ display: "block" }}>
        <circle cx={cx} cy={cy} r={baseR + thickness / 2} fill="none" stroke="rgba(79, 227, 208, 0.08)" strokeWidth={thickness} opacity={0.5} />
        <circle cx={cx} cy={cy} r={baseR - 1} fill={C.surface} stroke="rgba(79, 227, 208, 0.08)" strokeWidth={0.5} />
      </svg>
    );
  }

  const total = data.reduce((s, d) => s + d.value, 0);
  type Slice = { id: string; value: number; color: string; start: number; end: number };
  const slices: Slice[] = data.reduce<Slice[]>((acc, d) => {
    const start = acc.length ? acc[acc.length - 1].end : -Math.PI / 2;
    const span = (d.value / total) * Math.PI * 2;
    acc.push({ ...d, start, end: start + span });
    return acc;
  }, []);

  return (
    <svg width={TOTAL} height={TOTAL} style={{ display: "block" }} onMouseLeave={() => onHover(null)}>
      <defs>
        {slices.map((s) => (
          <linearGradient key={`grad-${s.id}`} id={`grad-${s.id}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={lightenColor(s.color, 0.25)} />
            <stop offset="50%" stopColor={s.color} />
            <stop offset="100%" stopColor={darkenColor(s.color, 0.18)} />
          </linearGradient>
        ))}
        <radialGradient id="innerFrost" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#15201c" stopOpacity="1" />
          <stop offset="70%" stopColor={C.card} stopOpacity="1" />
          <stop offset="100%" stopColor="#0b1310" stopOpacity="1" />
        </radialGradient>
      </defs>
      {slices.map((s) => {
        const isActive = activeId === s.id;
        const isNone = activeId === null;
        const midAngle = (s.start + s.end) / 2;
        const offsetDist = isActive ? 6 : 0;
        const ox = Math.cos(midAngle) * offsetDist;
        const oy = Math.sin(midAngle) * offsetDist;
        const outerR = baseR + thickness + (isActive ? 8 : 0);
        const innerR = baseR - (isActive ? 1 : 0);
        const adjStart = s.start + gap / 2;
        const adjEnd = s.end - gap / 2;
        return (
          <g
            key={s.id}
            transform={`translate(${ox} ${oy})`}
            style={{ opacity: isNone ? 1 : isActive ? 1 : 0.18, transition: `opacity 0.35s ${EASE}, transform 0.4s ${EASE}`, cursor: "pointer" }}
            onMouseEnter={() => onHover(s.id)}
          >
            <path d={arcPath(cx, cy, outerR, innerR, adjStart, adjEnd)} fill={`url(#grad-${s.id})`} style={{ transition: `d 0.4s ${EASE}` }} />
            <path d={arcPath(cx, cy, outerR, outerR - 2, adjStart, adjEnd)} fill={lightenColor(s.color, 0.45)} opacity="0.5" />
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={baseR - 1} fill="url(#innerFrost)" />
      <circle cx={cx} cy={cy} r={baseR - 1} fill="none" stroke="rgba(79, 227, 208, 0.1)" strokeWidth="0.5" opacity="0.6" />
    </svg>
  );
}

export function MetricTile({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ background: C.cardGradient, border: `0.5px solid ${C.border}`, borderRadius: 14, padding: "16px 18px", position: "relative", overflow: "hidden", backdropFilter: "blur(10px)" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1.5, background: `linear-gradient(to right, transparent, ${color || C.tealLight}66, transparent)`, opacity: 0.6 }} />
      <div style={{ position: "absolute", top: -40, right: -40, width: 120, height: 120, borderRadius: "50%", background: `radial-gradient(circle, ${color || C.tealLight}15 0%, transparent 65%)`, pointerEvents: "none" }} />
      <div style={{ fontSize: 9.5, color: C.textMuted, fontFamily: FM, letterSpacing: "0.13em", textTransform: "uppercase", marginBottom: 9, position: "relative" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: color ?? C.textPrimary, fontFamily: FD, letterSpacing: "-0.01em", position: "relative", fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FS, marginTop: 6, position: "relative" }}>{sub}</div>}
    </div>
  );
}

export function Pill({ children, active, onClick, color }: { children: React.ReactNode; active: boolean; onClick: () => void; color?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "7px 16px",
        borderRadius: 100,
        border: `0.5px solid ${active ? color || C.tealLight : C.border}`,
        background: active ? `${color || C.tealLight}15` : C.surface,
        color: active ? color || C.tealLight : C.textSecondary,
        fontSize: 12,
        fontFamily: FD,
        cursor: "pointer",
        transition: `all 0.2s ${EASE}`,
        fontWeight: active ? 500 : 400,
        boxShadow: active ? `0 0 16px ${color || C.tealLight}20` : "none",
        letterSpacing: "0.01em",
      }}
    >
      {children}
    </button>
  );
}
