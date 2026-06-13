"use client";

import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * `<ConnectModal trigger={…}>` shim — now backed by Dynamic. Lets a primary action
 * (Buy / Deposit / Deploy) open Dynamic's login/auth flow inline on click, so a
 * not-yet-connected user is prompted to log in (email / social / passkey / wallet)
 * without a separate "Connect Wallet" button. The `open` / `onOpenChange` props are
 * accepted for compatibility (Dynamic owns its own modal state).
 */
export function ConnectModal({
  trigger,
  open: _open,
  onOpenChange,
}: {
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { setShowAuthFlow } = useDynamicContext();
  const fire = (orig?: (e: unknown) => void) => (e: unknown) => {
    orig?.(e);
    onOpenChange?.(true);
    setShowAuthFlow(true);
  };
  if (isValidElement(trigger)) {
    const el = trigger as ReactElement<{ onClick?: (e: unknown) => void }>;
    return cloneElement(el, { onClick: fire(el.props.onClick) });
  }
  return (
    <span style={{ display: "contents", cursor: "pointer" }} onClick={fire()}>
      {trigger}
    </span>
  );
}

export default ConnectModal;
