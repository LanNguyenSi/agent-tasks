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
//
// Lives in components/task-detail/ alongside ReviewPanel/TaskHeader/etc.
// (fix-round 1, MED-5): the spec (authored in May) named
// components/task/ImprovementPanel.tsx, but that directory did not exist
// yet at spec time — task-detail/ is where every other TaskDetail sub-panel
// lives. Moved here deliberately; documented in the PR body as an intentional
// spec deviation, not an oversight.

import { useEffect, useState } from "react";
import { deriveNextActions, type QualityFinding } from "@/lib/confidence";
import type { TaskConfidenceDetail } from "@/lib/api";
import ConfidenceBadge from "@/components/ConfidenceBadge";

const SEVERITY_ORDER = ["blocking", "warning", "info"] as const;

const SEVERITY_LABEL: Record<QualityFinding["severity"], string> = {
  blocking: "Blocking",
  warning: "Warning",
  info: "Info",
};

// Human-readable labels for the fixed M3 risk-modifier names
// (backend/src/lib/confidence.ts RISK_MODIFIER_NAMES, verified against
// batch18/m3-risk-modifiers commit 49b4afc). Optional/best-effort: an
// unrecognized name (a modifier the backend adds later) still renders via
// its own raw string below — nothing is invented for it.
const RISK_MODIFIER_LABELS: Record<string, string> = {
  touchesAuth: "Touches auth",
  touchesDatabase: "Touches database",
  touchesPersonalData: "Touches personal data",
  productionImpact: "Production impact",
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
 * warning). Either state is togglable by click, and resyncs to the new
 * default whenever the pass/fail verdict itself changes underneath an
 * already-rendered panel (fix-round 1, MED-4) — e.g. after a task edit
 * causes the page to refetch `confidence` and the task flips from failing
 * to passing or back. The resync is scoped to `passes` alone, not the whole
 * `confidence` object, so an edit that leaves the pass/fail verdict
 * unchanged (e.g. one finding's wording changes but the task still fails)
 * does NOT clobber a state the user manually toggled.
 */
export default function ImprovementPanel({ confidence }: { confidence: TaskConfidenceDetail }) {
  const { score, threshold, blocking, findings, triggeredRiskModifiers } = confidence;
  const passes = score >= threshold && !blocking;
  const [open, setOpen] = useState(!passes);

  useEffect(() => {
    setOpen(!passes);
  }, [passes]);

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
        aria-controls="ip-body"
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
        <div id="ip-body" className="ip-body">
          {hasRiskModifiers && (
            <div className="ip-section">
              <p className="ip-subheading">Triggered risk modifiers</p>
              <ul className="ip-risk-list">
                {triggeredRiskModifiers!.map((name) => (
                  <li key={name} className="ip-risk-item">
                    <code className="ip-findings-code">{name}</code>
                    {RISK_MODIFIER_LABELS[name] && (
                      <span className="ip-risk-label">{RISK_MODIFIER_LABELS[name]}</span>
                    )}
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
