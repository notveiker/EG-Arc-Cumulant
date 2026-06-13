import "./globals.css";
import Script from "next/script";
import { Providers } from "./providers";
import { ThemeProvider, THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

export const metadata = {
  title: "Cumulant · Structured Predictions on Arc",
  description:
    "Cumulant carves prediction-market outcome distributions into structured payoffs — baskets, tranches and protected notes — collateralized and settled in USDC on Circle Arc.",
  icons: { icon: "/cumulant-mark.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap"
          rel="stylesheet"
        />
        <Script
          id="theme-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
        <style
          // Rendered as opaque HTML so React doesn't hydrate-diff the CSS text node.
          // (JSX <style>{`…`}</style> mismatches because the server HTML-encodes the
          // quotes in the CSS while the browser DOM decodes them — the "1 error" badge.)
          dangerouslySetInnerHTML={{ __html: `
          :root {
            --font-sans: 'Inter', system-ui, sans-serif;
            --font-mono: 'JetBrains Mono', ui-monospace, monospace;

            --c-bg: #0a0e16;
            --c-surface: #0e131d;
            --c-card: #121826;
            --c-card-hover: #18212f;
            --c-card-gradient: linear-gradient(135deg, rgba(18,24,38,0.72) 0%, rgba(10,14,22,0.86) 100%);
            --c-card-gradient-hover: linear-gradient(160deg, rgba(24,33,47,0.94) 0%, rgba(12,17,28,0.96) 100%);
            --c-card-gradient-strong: linear-gradient(135deg, rgba(18,24,38,0.88) 0%, rgba(10,14,22,0.96) 100%);
            --c-panel-gradient: linear-gradient(180deg, rgba(18,24,38,0.9) 0%, rgba(10,14,22,0.96) 100%);
            --c-border: rgba(79,227,208,0.10);
            --c-border-hover: rgba(79,227,208,0.22);
            --c-border-strong: rgba(79,227,208,0.30);
            --c-text-primary: #ecf2f1;
            --c-text-secondary: #8ba0a6;
            --c-text-muted: #56666b;
            --c-text-strong: #d8dee0;
            --c-text-subtle: #a6b3b6;
            --c-text-dim: #8d9a9e;
            --c-header-bg: rgba(10,14,22,0.84);
            --c-page-glow: rgba(61,214,196,0.12);
            --c-scrollbar-thumb: rgba(79,227,208,0.18);
            --c-scrollbar-thumb-hover: rgba(79,227,208,0.34);
            --c-edge-fade: #0a0e16;
          }

          [data-theme="light"] {
            --c-bg: #f3f6f6;
            --c-surface: #ffffff;
            --c-card: #ffffff;
            --c-card-hover: #eef2f2;
            --c-card-gradient: #ffffff;
            --c-card-gradient-hover: #f9fbfb;
            --c-card-gradient-strong: #ffffff;
            --c-panel-gradient: #ffffff;
            --c-border: rgba(20,160,144,0.22);
            --c-border-hover: rgba(20,160,144,0.45);
            --c-border-strong: rgba(20,160,144,0.35);
            --c-text-primary: #0b1413;
            --c-text-secondary: #46565a;
            --c-text-muted: #8795a0;
            --c-text-strong: #0b1413;
            --c-text-subtle: #2c3a3a;
            --c-text-dim: #46565a;
            --c-header-bg: rgba(243,246,246,0.88);
            --c-page-glow: rgba(20,160,144,0.14);
            --c-scrollbar-thumb: rgba(20,160,144,0.26);
            --c-scrollbar-thumb-hover: rgba(20,160,144,0.46);
            --c-edge-fade: #f3f6f6;
          }

          *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
          html, body {
            background: var(--c-bg);
            color: var(--c-text-primary);
            font-family: 'Inter', system-ui, sans-serif;
            -webkit-font-smoothing: antialiased;
            transition: background-color 0.2s ease, color 0.2s ease;
            overflow-x: hidden;
          }
          ::-webkit-scrollbar { width: 4px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: var(--c-scrollbar-thumb); border-radius: 2px; }
          ::-webkit-scrollbar-thumb:hover { background: var(--c-scrollbar-thumb-hover); }
          a { color: inherit; }
          input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
          input[type=range] { accent-color: #3DD6C4; }
        ` }}
        />
      </head>
      <body>
        <ThemeProvider>
          <Providers>{children}</Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
