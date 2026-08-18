"use client";

// Improvement panel (task 67526c1c, M4): surfaces the scorer-v2
// `confidence.findings[]` and the derived next actions on the task detail
// page. The data has been in the GET /tasks/:id/instructions API response
// since M1 (PR #245); this is the first place the web frontend renders it.
//
// Pure presentational — takes the already-fetched confidence detail as a
// prop and does no fetching of its own (the tasks/[id] page owns the fetch
// via lib/api.ts#getTaskConfidenceDetail). `nextActions` is not part of that
// API response, so it is derived client-side from `findings` via
// deriveNextActions (lib/confidence.ts), the same faithful mirror of the
// backend's own derivation used elsewhere in this file's sibling,
// CreateConfidencePanel.

import { useState } from "react";
import { deriveNextActions, type QualityFinding } from "../../lib/confidence";
import type { TaskConfidenceDetail } from "../../lib/api";
import ConfidenceBadge from "../ConfidenceBadge";

const SEVERITY_ORDER = ["blocking", "warning", "info"] as const;

const SEVERITY_LABEL: Record<QualityFinding["severity"], string> = {
  blocking: "Blocking",
  warning: "Warning",
  info: "Info",
};

interface FindingsGroup {
  severity: QualityFinding["severity"];
  items: QualityFinding[];
}

/** Findings grouped by severity, blocking first then warning then info; empty groups omitted. */
function groupFindingsBySeverity(findings: QualityFinding[]): FindingsGroup[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    items: findings.filter((f) => f.severity === severity),
  })).filter((group) => group.items.length > 0);
}

/**
 * Renders the score/threshold verdict, the findings grouped by severity, and
 * the top next actions for a task, collapsed or expanded depending on
 * whether the task currently passes.
 *
 * "Passes" mirrors CreateConfidencePanel's definition (score >= threshold
 * AND not blocking): a keystone-blocking task (e.g. no acceptance criteria
 * and no verification path) never reads as passing here even when its raw
 * score alone clears the threshold, since agents cannot claim it either way.
 *
 * Collapse behaviour: a passing task starts collapsed so the panel does not
 * nag on every task that is already in good shape; a failing task starts
 * expanded, with the banner tinted by the worst severity among its findings
 * (a single blocking finding tints the whole banner danger, otherwise
 * warning). Either state is togglable by click.
 */
export default function ImprovementPanel({ confidence }: { confidence: TaskConfidenceDetail }) {
  const { score, threshold, blocking, findings, triggeredRiskModifiers } = confidence;
  const passes = score >= threshold && !blocking;
  const [open, setOpen] = useState(!passes);

  const tone: "pass" | "warning" | "danger" = passes
    ? "pass"
    : findings.some((f) => f.severity === "blocking")
      ? "danger"
      : "warning";

  const nextActions = deriveNextActions(findings);
  const groups = groupFindingsBySeverity(findings);
  const hasRiskModifiers = !!triggeredRiskModifiers && triggeredRiskModifiers.length > 0;
  const isEmpty = groups.length === 0 && nextActions.length === 0 && !hasRiskModifiers;

  return (
    <section className={`ip-root ip-root--${tone}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="ip-toggle"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden="true"
          className={["ip-chevron", open ? "ip-chevron--open" : ""].filter(Boolean).join(" ")}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
        </svg>
        <span className="ip-title">Improvement panel</span>
        <ConfidenceBadge score={score} size="sm" tabIndex={-1} />
        <span className="ip-verdict">
          {passes
            ? `At or above the ${threshold} threshold`
            : `Below the ${threshold} threshold`}
        </span>
      </button>

      {open && (
        <div className="ip-body">
          {hasRiskModifiers && (
            <div className="ip-section">
              <p className="ip-subheading">Triggered risk modifiers</p>
              <ul className="ip-risk-list">
                {triggeredRiskModifiers!.map((m) => (
                  <li key={m.code} className="ip-risk-item">
                    {m.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {groups.length > 0 && (
            <div className="ip-section">
              {groups.map((group) => (
                <div key={group.severity} className="ip-findings-group">
                  <p className={`ip-findings-heading ip-findings-heading--${group.severity}`}>
                    {SEVERITY_LABEL[group.severity]} ({group.items.length})
                  </p>
                  <ul className="ip-findings-list">
                    {group.items.map((f) => (
                      <li key={f.code} className="ip-findings-item">
                        <div className="ip-findings-item-head">
                          <code className="ip-findings-code">{f.code}</code>
                          <span className="ip-findings-message">{f.message}</span>
                        </div>
                        {f.suggestion && <p className="ip-findings-suggestion">{f.suggestion}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {nextActions.length > 0 && (
            <div className="ip-section">
              <p className="ip-subheading">Next actions</p>
              <ol className="ip-next-actions-list">
                {nextActions.map((action) => (
                  <li key={action} className="ip-next-actions-item">
                    {action}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {isEmpty && <p className="ip-empty">No open findings.</p>}
        </div>
      )}
    </section>
  );
}
