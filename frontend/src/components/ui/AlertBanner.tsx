"use client";

import type { ReactNode } from "react";

type AlertTone = "info" | "success" | "warning" | "danger";

interface AlertBannerProps {
  tone?: AlertTone;
  title?: string;
  children: ReactNode;
  className?: string;
  /** When provided, renders a dismiss (×) button that calls this. */
  onDismiss?: () => void;
}

const TONE_CLASS: Record<AlertTone, string> = {
  info: "alert-info",
  success: "alert-success",
  warning: "alert-warning",
  danger: "alert-danger",
};

// Map tone to an ARIA live-region role so a dynamically shown banner is
// announced. danger/warning are assertive (role=alert); info/success are
// polite (role=status). role implies the matching aria-live, so no extra
// attribute is needed.
const TONE_ROLE: Record<AlertTone, "alert" | "status"> = {
  info: "status",
  success: "status",
  warning: "alert",
  danger: "alert",
};

export default function AlertBanner({
  tone = "info",
  title,
  children,
  className,
  onDismiss,
}: AlertBannerProps) {
  return (
    <div role={TONE_ROLE[tone]} className={["alert-banner", TONE_CLASS[tone], className].filter(Boolean).join(" ")}>
      {onDismiss && (
        <button type="button" className="alert-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
      {title && <p className="alert-title">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

