/**
 * Shared visual tokens for the Cumulant app shell — a teal/iris palette on Circle Arc.
 *
 * Two-tier palette:
 *   1. Surface / text / border tokens resolve to CSS custom properties that flip
 *      between light/dark mode (defined in app/layout.tsx).
 *   2. Accent colors stay as literal hex so `${C.tealLight}44` alpha-concat works.
 */
export const C = {
  // Theme-reactive surfaces.
  bg: "var(--c-bg)",
  surface: "var(--c-surface)",
  card: "var(--c-card)",
  cardHover: "var(--c-card-hover)",
  cardGradient: "var(--c-card-gradient)",
  cardGradientHover: "var(--c-card-gradient-hover)",
  cardGradientStrong: "var(--c-card-gradient-strong)",
  panelGradient: "var(--c-panel-gradient)",
  border: "var(--c-border)",
  borderHover: "var(--c-border-hover)",
  borderStrong: "var(--c-border-strong)",
  edgeFade: "var(--c-edge-fade)",

  // Theme-reactive text.
  textPrimary: "var(--c-text-primary)",
  textSecondary: "var(--c-text-secondary)",
  textMuted: "var(--c-text-muted)",
  textStrong: "var(--c-text-strong)",
  textSubtle: "var(--c-text-subtle)",
  textDim: "var(--c-text-dim)",

  // Chrome.
  headerBg: "var(--c-header-bg)",
  pageGlow: "var(--c-page-glow)",

  // Accent colors — Cumulant teal/iris. Hex so alpha concatenation works.
  teal: "#3DD6C4",
  tealLight: "#4FE3D0",
  tealBg: "#06231f",
  amber: "#E0A12E",
  amberBg: "#1c1300",
  coral: "#F2647B",
  coralBg: "#1c0a0d",
  green: "#36C28B",
  greenBg: "#06231a",
  red: "#F2647B",
  redBg: "#1f0a0d",
  violet: "#8b5cf6",
  violetBg: "#15091c",
  blue: "#6B8BFF",
  blueBg: "#0b1430",
} as const;

export const FS = "'Inter', system-ui, sans-serif";
export const FD = "'Inter', system-ui, sans-serif";
export const FM = "'JetBrains Mono', 'SF Mono', Menlo, monospace";
export const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:13201";

// USDC balance a fresh portfolio starts with. Real balance comes from the
// connected Arc wallet once read on-chain; until then a session starts at zero.
export const INITIAL_USDC = 0;

export function tc(tier: number): string {
  return tier === 90 ? C.teal : tier === 70 ? C.amber : C.coral;
}

export function tl(daysLeft: number): "This week" | "This month" | "Long term" {
  return daysLeft <= 20 ? "This week" : daysLeft <= 50 ? "This month" : "Long term";
}

export function trancheColor(kind: "senior" | "mezzanine" | "junior"): string {
  // Risk ramp (on-brand teal→amber→coral): senior (safe, paid first) = teal — the app's
  // signature accent, matching riskTierColor — mezzanine = amber, junior (first loss) = coral.
  return kind === "senior" ? C.teal : kind === "mezzanine" ? C.amber : C.coral;
}

export function lightenColor(hex: string, amount = 0.25): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const nr = Math.min(255, Math.round(r + (255 - r) * amount));
  const ng = Math.min(255, Math.round(g + (255 - g) * amount));
  const nb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${nr.toString(16).padStart(2, "0")}${ng.toString(16).padStart(2, "0")}${nb.toString(16).padStart(2, "0")}`;
}

export function darkenColor(hex: string, amount = 0.2): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const nr = Math.max(0, Math.round(r * (1 - amount)));
  const ng = Math.max(0, Math.round(g * (1 - amount)));
  const nb = Math.max(0, Math.round(b * (1 - amount)));
  return `#${nr.toString(16).padStart(2, "0")}${ng.toString(16).padStart(2, "0")}${nb.toString(16).padStart(2, "0")}`;
}

/** Deterministic illustrative price/NAV series (≈40 pts) converging on `target`.
 *  Stable per `seed` so a card's chart doesn't reshuffle on every render. Until an
 *  on-chain indexer provides real history, this gives each surface a clean chart. */
export function historySeries(seed: number, target: number, n = 44): number[] {
  let s = (seed * 2654435761) % 2147483647 || 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: number[] = [];
  let v = target * (0.86 + rnd() * 0.1);
  for (let i = 0; i < n; i++) {
    const pull = (target - v) * 0.08;
    v += pull + (rnd() - 0.5) * target * 0.06;
    out.push(v);
  }
  out[n - 1] = target;
  return out;
}

export function fmtUsd(n: number, digits = 0): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
