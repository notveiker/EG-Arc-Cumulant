import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { ACTIVE_CHAIN, arcTestnet, anvil } from "./chains";

// WalletConnect project id — read straight from the env with NO baked-in demo
// fallback. The app's default wallet layer is Dynamic; this RainbowKit config is
// the fallback path, so an empty id is acceptable (WalletConnect simply won't
// init). Never ship a placeholder id — warn loudly instead so it's obvious the
// env is unset rather than silently using a fake "CUMULANT_DEMO" project.
const wcProjectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";
if (!wcProjectId && typeof window !== "undefined") {
  console.warn(
    "[wagmi] NEXT_PUBLIC_WC_PROJECT_ID is unset — WalletConnect (mobile QR) will not " +
      "initialize. Injected wallets still work; set a real id from https://cloud.reown.com.",
  );
}

/** Shared wagmi config (used by Providers and by imperative write helpers). */
export const wagmiConfig = getDefaultConfig({
  appName: "Cumulant",
  projectId: wcProjectId,
  chains: ACTIVE_CHAIN.id === anvil.id ? [anvil, arcTestnet] : [arcTestnet, anvil],
  ssr: true,
});
