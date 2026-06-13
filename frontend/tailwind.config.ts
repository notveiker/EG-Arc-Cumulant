import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          900: "#0B0E14", // page
          850: "#0F131B",
          800: "#141926", // card
          700: "#1B2233", // raised
          600: "#252E42", // border
        },
        teal: { DEFAULT: "#3DD6C4", dim: "#2BA89A" },
        iris: { DEFAULT: "#6B8BFF", dim: "#4F6BD6" },
        good: "#36C28B",
        bad: "#F2647B",
        muted: "#8A94A8",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 30px -12px rgba(0,0,0,0.6)",
      },
    },
  },
  plugins: [],
} satisfies Config;
