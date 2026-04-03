"use client";

import type { ReactNode } from "react";

type AlertTone = "info" | "success" | "warning" | "danger";

interface AlertBannerProps {
  tone?: AlertTone;
  title?: string;
  children: ReactNode;
  className?: string;
}

const TONE_CLASS: Record<AlertTone, string> = {
  info: "alert-info",
  success: "alert-success",
  warning: "alert-warning",
  danger: "alert-danger",
};

export default function AlertBanner({
  tone = "info",
  title,
  children,
  className,
}: AlertBannerProps) {
  return (
    <div className={["alert-banner", TONE_CLASS[tone], className].filter(Boolean).join(" ")}>
      {title && <p className="alert-title">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

