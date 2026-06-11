// GovernanceModeField: bordered selectable option cards for the governance
// mode radio group. Extracted from settings/page.tsx.
// Geometry in .gov-option / .gov-option--selected / .gov-option-* in globals.css.

import type { ReactNode } from "react";

export type GovernanceMode =
  | "REQUIRES_DISTINCT_REVIEWER"
  | "AWAITS_CONFIRMATION"
  | "AUTONOMOUS";

interface OptionDef {
  value: GovernanceMode;
  label: string;
  description: ReactNode;
}

const OPTIONS: OptionDef[] = [
  {
    value: "REQUIRES_DISTINCT_REVIEWER",
    label: "Requires distinct reviewer",
    description: (
      <>
        Dual-control. <code>review → done</code> requires a different user or
        agent than the task&apos;s claimant to hold the review lock (via{" "}
        <code>POST /tasks/:id/review/claim</code>). Self-merge attempts are
        blocked upstream. Team admins can still bypass with a forced transition.
      </>
    ),
  },
  {
    value: "AWAITS_CONFIRMATION",
    label: "Awaits human confirmation",
    description: (
      <>
        Agent may self-merge, but every human on the team receives a{" "}
        <code>self_merge_notice</code> signal when the task reaches{" "}
        <code>done</code>. Gives visibility without blocking the flow. Use this
        when you trust the agent day-to-day but want a record you can audit
        asynchronously.
      </>
    ),
  },
  {
    value: "AUTONOMOUS",
    label: "Autonomous",
    description: (
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
            <span className="gov-option-label">{opt.label}</span>
            <span className="gov-option-desc">{opt.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
