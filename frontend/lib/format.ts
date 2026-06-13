/** Format a 6-decimal USDC base-unit string/bigint as a $ amount. */
export function fmtUsdc(raw: string | bigint, opts: { decimals?: number } = {}): string {
  const v = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const d = opts.decimals ?? 2;
  const whole = v / 1_000_000n;
  const frac = v % 1_000_000n;
  const num = Number(whole) + Number(frac) / 1_000_000;
  return num.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function pct(p: number): string {
  return `${(p * 100).toFixed(0)}%`;
}

export function shortAddr(a?: string): string {
  if (!a) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function timeUntil(unix: number): string {
  const ms = unix * 1000 - Date.now();
  if (ms <= 0) return "closed";
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d`;
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs > 0) return `${hrs}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** USDC has 6 decimals; convert a human $ amount to base units. */
export function toUsdcUnits(amount: string | number): bigint {
  const n = typeof amount === "number" ? amount : parseFloat(amount || "0");
  if (!isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.round(n * 1_000_000));
}
