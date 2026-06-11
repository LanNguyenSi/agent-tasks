"use client";

// Confidence score badge. Keyboard-reachable (tabIndex=0) with visible
// qualifier text ("ready" / "fair" / "low") so the encoding is not
// color-only. De-inlined: colors live in .confidence-badge--* CSS classes.
//
// When rendered inside a <button> or other interactive element, pass
// tabIndex={-1} to avoid a nested-interactive violation.

interface ConfidenceBadgeProps {
  score: number;
  size?: "sm" | "md";
  /** Override the tab index. Default is 0 (keyboard-reachable). */
  tabIndex?: number;
}

type Tier = "ready" | "fair" | "low";

function getTier(score: number): Tier {
  if (score > 70) return "ready";
  if (score >= 40) return "fair";
  return "low";
}

const TIER_LABEL: Record<Tier, string> = {
  ready: "ready",
  fair: "fair",
  low: "low",
};

export default function ConfidenceBadge({ score, size = "sm", tabIndex = 0 }: ConfidenceBadgeProps) {
  const tier = getTier(score);

  return (
    <span
      tabIndex={tabIndex}
      aria-label={`Confidence: ${score}/100, ${TIER_LABEL[tier]}`}
      className={[
        "status-chip",
        "confidence-badge",
        `confidence-badge--${tier}`,
        `confidence-badge--${size}`,
      ].join(" ")}
    >
      {score}/100, {TIER_LABEL[tier]}
    </span>
  );
}
