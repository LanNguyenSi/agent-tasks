// GovernanceModeField: bordered selectable option cards for the governance
// mode radio group. Extracted from settings/page.tsx. Each option leads with
// a plain-language summary; API routes and signal names sit behind "Details".
// Geometry in .gov-option / .gov-option--selected / .gov-option-* in globals.css.

import type { ReactNode } from "react";
import { GOVERNANCE_LABELS, type GovernanceMode } from "../../lib/governance";

export type { GovernanceMode };

interface OptionDef {
  value: GovernanceMode;
  summary: string;
  details: ReactNode;
}

const OPTIONS: OptionDef[] = [
  {
    value: "REQUIRES_DISTINCT_REVIEWER",
    summary:
      "A task can only be completed after someone other than the person or agent who worked on it has reviewed it.",
    details: (
      <>
        Dual-control. <code>review → done</code> requires a different user or
        agent than the task&apos;s claimant to hold the review lock (via{" "}
        <code>POST /tasks/:id/review/claim</code>). Self-merge attempts are
        blocked upstream. Project admins can still bypass with a forced transition.
      </>
    ),
  },
  {
    value: "AWAITS_CONFIRMATION",
    summary:
      "An agent may merge its own work. Every human on the team is notified, so you can check afterwards without blocking the flow.",
    details: (
      <>
        Every human on the team receives a <code>self_merge_notice</code>{" "}
        signal when the task reaches <code>done</code>. Use this when you trust
        the agent day-to-day but want a record you can audit asynchronously.
      </>
    ),
  },
  {
    value: "AUTONOMOUS",
    summary:
      "One person or agent works alone: no review step and no notifications. Only enable this with branch protection on GitHub.",
    details: (
      <>
        Single-actor workflow. No gates, no notifications. Merge still moves
        the task straight to <code>done</code> via the webhook. Branch
        protection rules on GitHub remain the primary safeguard &mdash; do not
        enable without <code>require_pull_request_reviews</code> and at least
        one required status check.
      </>
    ),
  },
];

interface GovernanceModeFieldProps {
  value: GovernanceMode;
  onChange: (value: GovernanceMode) => void;
}

export default function GovernanceModeField({
  value,
  onChange,
}: GovernanceModeFieldProps) {
  return (
    <div>
      {OPTIONS.map((opt) => (
        <label
          key={opt.value}
          className={[
            "gov-option",
            value === opt.value ? "gov-option--selected" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <input
            type="radio"
            name="governanceMode"
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            className="gov-option-radio"
          />
          <span className="gov-option-body">
            <span className="gov-option-label">{GOVERNANCE_LABELS[opt.value]}</span>
            <span className="gov-option-desc">{opt.summary}</span>
            <details className="gov-option-details">
              <summary>Details</summary>
              <span className="gov-option-details-body">{opt.details}</span>
            </details>
          </span>
        </label>
      ))}
    </div>
  );
}
