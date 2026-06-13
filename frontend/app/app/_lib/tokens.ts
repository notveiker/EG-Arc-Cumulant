/**
 * Re-export of the single design-token source (`@/lib/tokens`), which carries the
 * Tidal palette + fonts + format helpers. Ported files import `./_lib/tokens`
 * (relative); this keeps one source of truth so the theme can't drift.
 */
export * from "@/lib/tokens";
