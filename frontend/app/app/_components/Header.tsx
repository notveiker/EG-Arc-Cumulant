"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { UsdcBalancePill } from "./UsdcBalancePill";
import { FaucetButton } from "./FaucetButton";
import { C, FD } from "../_lib/tokens";
import { ThemeToggle } from "../_lib/theme";

const NAV_LEFT = [
  { id: "portfolio", label: "Portfolio",      href: "/app/portfolio" },
  { id: "basket",    label: "Market Baskets", href: "/app/basket" },
  { id: "tranche",   label: "Risk Slices",    href: "/app/tranche" },
  { id: "ppn",       label: "Protected Notes", href: "/app/ppn" },
  { id: "distribution", label: "Distribution Markets", href: "/app/distribution" },
  { id: "docs",      label: "About",          href: "/app/docs" },
];

function CumulantMark() {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} fill="none" aria-hidden style={{ flexShrink: 0 }}>
      <line x1="7" y1="7.5" x2="17" y2="16.5" stroke={C.textPrimary} strokeWidth="1.4" opacity="0.25" />
      <circle cx="7" cy="7.5" r="2.5" fill={C.textPrimary} />
      <circle cx="12" cy="12" r="2.5" fill="#2E5A52" />
      <circle cx="17" cy="16.5" r="2.5" fill={C.textPrimary} />
    </svg>
  );
}

export function Header() {
  const pathname = usePathname();

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap');
        .cumulant-nav-link:hover { color: ${C.textPrimary} !important; }
      ` }} />
      <header style={{
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
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24, flex: 1, minWidth: 0 }}>
          <Link href="/" aria-label="Cumulant home" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none", flexShrink: 0 }}>
            <CumulantMark />
            <span style={{ fontSize: 13, fontWeight: 500, color: C.textPrimary, fontFamily: FD, letterSpacing: "0.2em" }}>
              CUMULANT
            </span>
          </Link>

          <nav style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            overflowX: "auto",
            whiteSpace: "nowrap",
            scrollbarWidth: "none",
          }}>
            {NAV_LEFT.map((n) => {
              const active = pathname === n.href || (n.href !== "/app" && pathname?.startsWith(n.href));
              return (
                <Link
                  key={n.id}
                  href={n.href}
                  className="cumulant-nav-link"
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
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: -18,
                        height: 1,
                        background: C.tealLight,
                      }}
                    />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <ThemeToggle />
          <FaucetButton />
          <UsdcBalancePill />
          <ConnectButton variant="header" />
        </div>
      </header>
    </>
  );
}

export function PageFrame({
  children,
  wide = false,
  zoom,
}: {
  children: React.ReactNode;
  wide?: boolean;
  /** Optional content scale (e.g. 0.8) for pages that read large at 100%. */
  zoom?: number;
}) {
  return (
    <main style={{
      minHeight: "calc(100vh - 56px)",
      width: "100%",
      overflowX: "hidden",
      padding: "36px min(40px, 6vw) 60px",
      maxWidth: wide ? 1760 : 1440,
      margin: "0 auto",
      position: "relative",
      ...(zoom ? ({ zoom } as React.CSSProperties) : {}),
    }}>
      <div style={{
        position: "fixed",
        inset: 0,
        background: `radial-gradient(ellipse 80% 50% at 50% -10%, ${C.pageGlow} 0%, transparent 70%)`,
        pointerEvents: "none",
        zIndex: 0,
      }} />
      <div style={{ position: "relative", zIndex: 1 }}>
        {children}
      </div>
    </main>
  );
}
