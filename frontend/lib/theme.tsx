"use client";

/**
 * Theme system for Cumulant. `<html data-theme>` drives every
 * surface via the CSS variables in app/layout.tsx; localStorage persists it; an inline
 * bootstrap script applies it before hydration to avoid a flash.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { C, FD, EASE } from "./tokens";

export type Theme = "light" | "dark";
const STORAGE_KEY = "cumulant.theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    if (typeof document === "undefined") return;
    const fromDom = (document.documentElement.dataset.theme as Theme | undefined) ?? null;
    const fromStorage = (() => {
      try {
        return localStorage.getItem(STORAGE_KEY) as Theme | null;
      } catch {
        return null;
      }
    })();
    const resolved: Theme =
      fromStorage === "light" || fromStorage === "dark"
        ? fromStorage
        : fromDom === "light" || fromDom === "dark"
          ? fromDom
          : "dark";
    document.documentElement.dataset.theme = resolved;
    const id = window.setTimeout(() => setThemeState(resolved), 0);
    return () => window.clearTimeout(id);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = t;
      try {
        localStorage.setItem(STORAGE_KEY, t);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) return { theme: "dark", setTheme: () => {}, toggle: () => {} };
  return ctx;
}

export const THEME_BOOTSTRAP_SCRIPT = `
(function(){try{
  var k = ${JSON.stringify(STORAGE_KEY)};
  var t = null;
  try { t = localStorage.getItem(k); } catch(e) {}
  if (t !== 'light' && t !== 'dark') { t = 'dark'; }
  document.documentElement.setAttribute('data-theme', t);
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();
`;

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isLight = theme === "light";
  const label = isLight ? "Switch to dark theme" : "Switch to light theme";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      style={{
        height: 32,
        width: 32,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: 6,
        border: `0.5px solid ${C.border}`,
        background: "transparent",
        color: C.textSecondary,
        cursor: "pointer",
        fontFamily: FD,
        fontSize: 12,
        transition: `all 0.15s ${EASE}`,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.color = C.textPrimary;
        (e.currentTarget as HTMLElement).style.borderColor = C.borderHover;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color = C.textSecondary;
        (e.currentTarget as HTMLElement).style.borderColor = C.border;
      }}
    >
      {isLight ? (
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        </svg>
      )}
    </button>
  );
}
