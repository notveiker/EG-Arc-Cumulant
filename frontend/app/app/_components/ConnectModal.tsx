"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * the wallet SDK-compatible `<ConnectModal trigger={…}>` shim, backed by RainbowKit.
 *
 * This uses `wagmi + RainbowKit`'s ConnectModal so a primary
 * action (Buy / Deploy) could open the wallet picker on click without a separate
 * "Connect Wallet" button. On Arc the equivalent is RainbowKit's connect modal:
 * we render the provided `trigger` and open the modal when it's clicked. The
 * `open` / `onOpenChange` props are accepted for compatibility (RainbowKit owns
 * its own modal state).
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
  const { openConnectModal } = useConnectModal();
  const fire = (orig?: (e: unknown) => void) => (e: unknown) => {
    orig?.(e);
    onOpenChange?.(true);
    openConnectModal?.();
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
