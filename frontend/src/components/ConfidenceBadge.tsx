"use client";

// Spec-completeness badge: shows a named
// short score ("Spec 96", no "/100") so the value is recognisable and never
// confused with task priority; the tier words are `complete` / `partial` /
// `thin`, never low/medium/high. The `title` tooltip doubles as the
// accessible description (aria-label supplies the name, title the
// description), so the tier encoding is not color-only.
//
// Tiers are threshold-relative: `complete` = score >= threshold, `thin` =
// score below half the threshold, `partial` in between. When the threshold
// is unknown the tier falls back to GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD
// (the same fallback every caller already uses for `project.confidenceThreshold`)
// and the tooltip omits the threshold sentence.
//
// When rendered inside a <button> or other interactive element, pass
// tabIndex={-1} to avoid a nested-interactive violation.

import { GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD } from "../lib/confidence";

interface ConfidenceBadgeProps {
  score: number;
  size?: "sm" | "md";
  /** Override the tab index. Default is 0 (keyboard-reachable). */
  tabIndex?: number;
  /** Effective project threshold for the tier + tooltip. Omit (or pass
   *  null) when the threshold is not known to the caller. */
  threshold?: number | null;
}

export type ConfidenceTier = "complete" | "partial" | "thin";

/** Tier for a spec score against the effective threshold; unknown
 *  threshold falls back to the global default (60). */
export function getConfidenceTier(score: number, threshold?: number | null): ConfidenceTier {
  const effective = threshold ?? GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD;
  if (score >= effective) return "complete";
  if (score >= effective / 2) return "partial";
  return "thin";
}

/** Tooltip text: explains what the score is; names the project threshold
 *  only when it is known. Doubles as the accessible description. */
export function getConfidenceTooltip(threshold?: number | null): string {
  return threshold == null
    ? "How complete the task spec is (0-100)."
    : `How complete the task spec is (0-100). Project threshold: ${threshold}.`;
}

const TIER_LABEL: Record<ConfidenceTier, string> = {
  complete: "complete",
  partial: "partial",
  thin: "thin",
};

export default function ConfidenceBadge({
  score,
  size = "sm",
  tabIndex = 0,
  threshold = null,
}: ConfidenceBadgeProps) {
  const tier = getConfidenceTier(score, threshold);

  return (
    <span
      tabIndex={tabIndex}
      title={getConfidenceTooltip(threshold)}
      aria-label={`Spec ${score}, ${TIER_LABEL[tier]}`}
      className={[
        "status-chip",
        "confidence-badge",
        `confidence-badge--${tier}`,
        `confidence-badge--${size}`,
      ].join(" ")}
    >
      {`Spec ${score}, ${TIER_LABEL[tier]}`}
    </span>
  );
}
