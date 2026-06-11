"use client";

/**
 * TransitionsTable v2 — uses the ui/Table primitive.
 *
 * Gates render as toggle chips (active = tinted) with the rule's
 * description in a Tooltip, replacing the old checkbox + code rows.
 *
 * Dumb component: parent owns the draft and mutation handlers.
 * Unknown rule names (IDs stored on a transition that aren't in the
 * current rules catalog) render as danger-tinted chips so admins can
 * see them.
 */

import { useEffect } from "react";
import type { WorkflowDefinition, WorkflowRule, WorkflowTransition } from "../../../../../lib/api";
import { ROLE_OPTIONS } from "../../../../../lib/workflow-draft";
import { Button } from "../../../../../components/ui/Button";
import Card from "../../../../../components/ui/Card";
import { Table, type ColumnDef } from "../../../../../components/ui/Table";
import { Tooltip } from "../../../../../components/ui/Tooltip";
import { SkeletonList } from "../../../../../components/ui/Skeleton";

// Row shape: WorkflowTransition enriched with its position index.
type TransitionRow = WorkflowTransition & { _index: number };

export interface TransitionsTableProps {
  def: WorkflowDefinition;
  rules: WorkflowRule[];
  /** Lookup from rule id → display label, pre-computed by the parent. */
  ruleLabelById: Map<string, string>;
  canEdit: boolean;
  saving: boolean;
  loading?: boolean;
  /** Index of the transition to scroll into view and highlight. */
  highlightedIndex: number | null;
  onAddTransition: () => void;
  onRemoveTransition: (index: number) => void;
  onUpdateTransitionField: <K extends keyof WorkflowTransition>(
    index: number,
    field: K,
    value: WorkflowTransition[K],
  ) => void;
  onToggleRule: (transitionIndex: number, ruleId: string, on: boolean) => void;
}

export function TransitionsTable({
  def,
  rules,
  ruleLabelById,
  canEdit,
  saving,
  loading,
  highlightedIndex,
  onAddTransition,
  onRemoveTransition,
  onUpdateTransitionField,
  onToggleRule,
}: TransitionsTableProps) {
  // Scroll the highlighted row into view whenever highlightedIndex changes.
  useEffect(() => {
    if (highlightedIndex === null) return;
    const el = document.getElementById(`transition-row-${highlightedIndex}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlightedIndex]);

  const rows: TransitionRow[] = def.transitions.map((t, i) => ({ ...t, _index: i }));

  const stateNames = def.states.map((s) => s.name);

  const columns: ColumnDef<TransitionRow>[] = [
    {
      key: "from",
      header: "From",
      sortable: false,
      width: "120px",
      render: (row) =>
        canEdit ? (
          <select
            className="wf-inline-select"
            value={row.from}
            onChange={(e) => onUpdateTransitionField(row._index, "from", e.target.value)}
            disabled={saving}
            aria-label={`From state for transition ${row._index + 1}`}
          >
            {stateNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        ) : (
          <code className="wf-code-ref">{row.from}</code>
        ),
    },
    {
      key: "to",
      header: "To",
      sortable: false,
      width: "120px",
      render: (row) =>
        canEdit ? (
          <select
            className="wf-inline-select"
            value={row.to}
            onChange={(e) => onUpdateTransitionField(row._index, "to", e.target.value)}
            disabled={saving}
            aria-label={`To state for transition ${row._index + 1}`}
          >
            {stateNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        ) : (
          <code className="wf-code-ref">{row.to}</code>
        ),
    },
    {
      key: "label",
      header: "Label",
      sortable: false,
      render: (row) =>
        canEdit ? (
          <input
            type="text"
            className="wf-inline-input"
            value={row.label ?? ""}
            onChange={(e) => onUpdateTransitionField(row._index, "label", e.target.value)}
            disabled={saving}
            placeholder="(optional)"
            aria-label={`Label for transition ${row._index + 1}`}
          />
        ) : (
          <span>{row.label ?? "—"}</span>
        ),
    },
    {
      key: "requiredRole",
      header: "Required role",
      sortable: false,
      width: "130px",
      render: (row) =>
        canEdit ? (
          <select
            className="wf-inline-select"
            value={row.requiredRole ?? "any"}
            onChange={(e) => onUpdateTransitionField(row._index, "requiredRole", e.target.value)}
            disabled={saving}
            aria-label={`Required role for transition ${row._index + 1}`}
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <span>
            {row.requiredRole && row.requiredRole !== "any" ? row.requiredRole : "—"}
          </span>
        ),
    },
    {
      key: "requires",
      header: "Gates",
      sortable: false,
      render: (row) => {
        const activeRequires = row.requires ?? [];

        if (canEdit) {
          return (
            <div className="wf-gate-chips">
              {rules.map((r) => {
                const active = activeRequires.includes(r.id);
                return (
                  <Tooltip key={r.id} content={r.description}>
                    <button
                      type="button"
                      className={[
                        "wf-gate-chip",
                        active ? "wf-gate-chip--active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => onToggleRule(row._index, r.id, !active)}
                      disabled={saving}
                      aria-pressed={active}
                    >
                      {r.label}
                    </button>
                  </Tooltip>
                );
              })}
              {/* Unknown rule IDs not in the catalog */}
              {activeRequires
                .filter((ruleId) => !rules.some((x) => x.id === ruleId))
                .map((ruleId) => (
                  <span key={ruleId} className="wf-gate-chip wf-gate-chip--unknown">
                    {ruleId} (unknown)
                  </span>
                ))}
            </div>
          );
        }

        // Read-only: show active gates as tinted chips.
        if (activeRequires.length === 0) {
          return <span className="wf-muted-text">none</span>;
        }

        return (
          <div className="wf-gate-chips">
            {activeRequires.map((ruleId) => {
              const rule = rules.find((r) => r.id === ruleId);
              return (
                <Tooltip key={ruleId} content={rule?.description ?? ruleId}>
                  <span className="wf-gate-chip-readonly">
                    {ruleLabelById.get(ruleId) ?? ruleId}
                  </span>
                </Tooltip>
              );
            })}
          </div>
        );
      },
    },
  ];

  if (canEdit) {
    columns.push({
      key: "_actions",
      header: "",
      sortable: false,
      width: "40px",
      align: "center",
      render: (row) => (
        <button
          type="button"
          className="wf-danger-btn"
          onClick={() => onRemoveTransition(row._index)}
          disabled={saving}
          title={`Remove transition ${row.from} → ${row.to}`}
          aria-label={`Remove transition ${row.from} to ${row.to}`}
        >
          ✕
        </button>
      ),
    });
  }

  return (
    <Card className="wf-table-section">
      <div className="wf-table-header">
        <h2 className="wf-table-title">Transitions</h2>
        {canEdit && (
          <Button type="button" variant="secondary" size="sm" onClick={onAddTransition} disabled={saving}>
            + Add transition
          </Button>
        )}
      </div>

      {loading ? (
        <SkeletonList rows={5} rowHeight="2.5rem" label="Loading transitions" />
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => `transition-${row._index}`}
          rowId={(row) => `transition-row-${row._index}`}
          rowClassName={(row) =>
            row._index === highlightedIndex ? "wf-row-highlight" : undefined
          }
          emptyLabel="No transitions defined. Tasks will not be able to change status."
        />
      )}
    </Card>
  );
}
