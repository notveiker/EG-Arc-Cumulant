import React from "react";
import { SandboxProvider } from "./_lib/demo-state";

/**
 * Authenticated-app shell layout.
 *
 * Wraps every page under /app in the SandboxProvider so the portfolio,
 * basket, tranche, and PPN pages all share one in-memory demo state.
 * The root <html>/<body> stays at `../layout.tsx`; this one only
 * renders children.
 */
export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  return <SandboxProvider>{children}</SandboxProvider>;
}
