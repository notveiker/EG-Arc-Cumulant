import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { ACTIVE_CHAIN } from "./chains";

/**
 * Shared wagmi config (used by Providers and by imperative write helpers).
 * Only the ACTIVE chain is registered, so a wallet connected to any other
 * network surfaces RainbowKit's "Wrong network" state instead of silently
 * letting the user sign against the wrong chain.
 */
export const wagmiConfig = getDefaultConfig({
  appName: "Cumulant",
  projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "CUMULANT_DEMO",
  chains: [ACTIVE_CHAIN],
  ssr: true,
});
