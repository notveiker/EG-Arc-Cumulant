"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { C, FD } from "@/lib/tokens";
import { ThemeToggle } from "@/lib/theme";

const NAV_LEFT = [
  { id: "portfolio", label: "Portfolio", href: "/app/portfolio" },
  { id: "basket", label: "Market Baskets", href: "/app/basket" },
  { id: "tranche", label: "Risk Slices", href: "/app/tranche" },
  { id: "ppn", label: "Protected Notes", href: "/app/ppn" },
  { id: "distribution", label: "Distribution Markets", href: "/app/distribution" },
  { id: "docs", label: "About", href: "/app/docs" },
];

export function CumulantMark({ size = 24 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        display: "inline-grid",
        placeItems: "center",
        background: `linear-gradient(145deg, ${C.tealLight}22, ${C.blue}12)`,
        border: `0.5px solid ${C.tealLight}55`,
        boxShadow: `0 0 18px ${C.tealLight}18`,
        flexShrink: 0,
      }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.72} height={size * 0.72} fill="none">
        <rect x="3" y="14" width="2.6" height="5" rx="1" fill={C.tealLight} fillOpacity="0.45" />
        <rect x="7.2" y="9.5" width="2.6" height="9.5" rx="1" fill={C.tealLight} fillOpacity="0.7" />
        <rect x="11.4" y="5" width="2.6" height="14" rx="1" fill={C.tealLight} />
        <rect x="15.6" y="9.5" width="2.6" height="9.5" rx="1" fill={C.blue} fillOpacity="0.75" />
        <rect x="19.8" y="14" width="1.2" height="5" rx="0.6" fill={C.blue} fillOpacity="0.5" />
      </svg>
    </span>
  );
}

export function Header() {
  const pathname = usePathname();

  return (
    <>
      <style
        // Opaque so React doesn't hydrate-diff the CSS text node. Fonts are already
        // loaded via the <link> in app/layout.tsx, so no @import is needed here.
        dangerouslySetInnerHTML={{ __html: `.cm-nav-link:hover { color: ${C.textPrimary} !important; }` }}
      />
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          background: C.headerBg,
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          borderBottom: `0.5px solid ${C.border}`,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 24px",
          gap: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24, flex: 1, minWidth: 0 }}>
          <Link
            href="/"
            aria-label="Cumulant home"
            style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none", flexShrink: 0 }}
          >
            <CumulantMark />
            <span style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, fontFamily: FD, letterSpacing: "0.14em" }}>
              CUMULANT
            </span>
          </Link>

          <nav
            style={{
              display: "flex",
              alignItems: "center",
              gap: 18,
              overflowX: "auto",
              whiteSpace: "nowrap",
              scrollbarWidth: "none",
            }}
          >
            {NAV_LEFT.map((n) => {
              const active = pathname === n.href || pathname?.startsWith(`${n.href}/`);
              return (
                <Link
                  key={n.id}
                  href={n.href}
                  className="cm-nav-link"
                  style={{
                    position: "relative",
                    padding: "4px 0",
                    fontSize: 13,
                    fontWeight: 400,
                    fontFamily: FD,
                    letterSpacing: "0.01em",
                    textDecoration: "none",
                    color: active ? C.textPrimary : C.textSecondary,
                    transition: "color 0.15s linear",
                  }}
                >
                  {n.label}
                  {active && (
                    <span style={{ position: "absolute", left: 0, right: 0, bottom: -18, height: 1, background: C.tealLight }} />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <ThemeToggle />
          <ConnectButton />
        </div>
      </header>
    </>
  );
}

export function PageFrame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main
      style={{
        minHeight: "calc(100vh - 56px)",
        width: "100%",
        overflowX: "hidden",
        padding: "36px min(40px, 6vw) 60px",
        maxWidth: wide ? 1760 : 1440,
        margin: "0 auto",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: `radial-gradient(ellipse 80% 50% at 50% -10%, ${C.pageGlow} 0%, transparent 70%)`,
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
    </main>
  );
}
