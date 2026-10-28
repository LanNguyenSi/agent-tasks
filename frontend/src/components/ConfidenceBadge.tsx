"use client";

// Spec-completeness badge: shows a named
// short score ("Spec 96", no "/100") so the value is recognisable and never
// confused with task priority; the tier words are `complete` / `partial` /
// `thin`, never low/medium/high. The badge is a role="img" whose aria-label
// carries the score, tier and the full tooltip explanation (readable without
// hover, so on touch too); the `title` stays as the hover tooltip and
// accessible description. The tier encoding is not color-only.
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

  // role="img": a bare span may not carry aria-label (axe
  // aria-prohibited-attr). The name carries the whole explanation the title
  // shows, so a touch screen reader reads it without hover; the title stays
  // as the pointer-hover tooltip and accessible description.
  return (
    <span
      role="img"
      tabIndex={tabIndex}
      title={getConfidenceTooltip(threshold)}
      aria-label={`Spec ${score}, ${TIER_LABEL[tier]}. ${getConfidenceTooltip(threshold)}`}
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
