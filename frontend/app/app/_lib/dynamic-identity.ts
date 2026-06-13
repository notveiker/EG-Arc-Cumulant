"use client";

/**
 * Dynamic identity — turns the connected wallet into a *person*.
 *
 * Surfaces several Dynamic facets in one place so the UI can show "signed in as
 * alice@email.com" with an embedded wallet, rather than just a hex address:
 *   - useDynamicContext().user  → the human (email / social handle)
 *   - useUserWallets()          → multi-wallet identity (count of linked wallets)
 *   - useIsLoggedIn()           → auth state
 *   - getAuthToken()            → the verified Dynamic JWT, for authenticated backend calls
 *
 * All reads are defensive (user fields vary by login method) so this stays type-safe
 * and renders harmlessly (logged-out → empty) regardless of which login methods the
 * dashboard has enabled.
 */
import { useDynamicContext, useUserWallets, useIsLoggedIn, getAuthToken } from "@dynamic-labs/sdk-react-core";

export interface DynamicIdentity {
  isLoggedIn: boolean;
  address?: string;
  email?: string;
  /** email → social handle → shortened address. Always something printable when connected. */
  displayName?: string;
  /** how many wallets the user has linked to this Dynamic identity (>1 ⇒ multi-wallet). */
  walletCount: number;
  /** the verified Dynamic JWT, for `Authorization: Bearer` calls to the backend. */
  getToken: () => Promise<string | undefined>;
}

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : undefined);

export function useDynamicIdentity(): DynamicIdentity {
  const { primaryWallet, user } = useDynamicContext();
  const wallets = useUserWallets();
  const isLoggedIn = useIsLoggedIn();

  const address = primaryWallet?.address;
  // User shape varies by login method — read the common identifiers defensively.
  const u = (user ?? {}) as {
    email?: string;
    username?: string;
    alias?: string;
    firstName?: string;
  };
  const email = u.email;
  const social = u.username ?? u.alias ?? u.firstName;
  const displayName = email ?? social ?? short(address);
  const walletCount = Array.isArray(wallets) ? wallets.length : 0;

  return {
    isLoggedIn,
    address,
    email,
    displayName,
    walletCount,
    getToken: async () => {
      try {
        return getAuthToken();
      } catch {
        return undefined;
      }
    },
  };
}
