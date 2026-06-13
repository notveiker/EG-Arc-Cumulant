import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { ACTIVE_CHAIN, arcTestnet, anvil } from "./chains";

/** Shared wagmi config (used by Providers and by imperative write helpers). */
export const wagmiConfig = getDefaultConfig({
  appName: "Cumulant",
  projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "CUMULANT_DEMO",
  chains: ACTIVE_CHAIN.id === anvil.id ? [anvil, arcTestnet] : [arcTestnet, anvil],
  ssr: true,
});
