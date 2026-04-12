"use client";

/**
 * TransitionsTable — read-only view + editable matrix of workflow
 * transitions (from/to dropdowns, label, required role, gate
 * checkboxes).
 *
 * Dumb component: parent owns the draft and mutation handlers.
 * Unknown rule names (rules stored on a transition that aren't in
 * the current `rules` catalog) are rendered as red pills so admins
 * can see them — forward-compat preservation is handled by the
 * parent's `toggleRule` mutator.
 */

import type { WorkflowDefinition, WorkflowRule, WorkflowTransition } from "../../../../lib/api";
import { ROLE_OPTIONS } from "../../../../lib/workflow-draft";
import { Button } from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import { inlineInput, inlineSelect, linkButton, pill, td, th } from "./styles";

export interface TransitionsTableProps {
  def: WorkflowDefinition;
  rules: WorkflowRule[];
  /** Lookup from rule id → display label, pre-computed by the parent. */
  ruleLabelById: Map<string, string>;
  canEdit: boolean;
  saving: boolean;
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
  onAddTransition,
  onRemoveTransition,
  onUpdateTransitionField,
  onToggleRule,
}: TransitionsTableProps) {
  return (
    <Card style={{ marginTop: "var(--space-4)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: "var(--space-3)",
        }}
      >
        <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700 }}>Transitions</h2>
        {canEdit && (
          <Button type="button" variant="secondary" onClick={onAddTransition} disabled={saving}>
            + Add transition
          </Button>
        )}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th style={th}>From</th>
              <th style={th}>To</th>
              <th style={th}>Label</th>
              <th style={th}>Required role</th>
              <th style={th}>Gates (requires)</th>
              {canEdit && <th style={th}></th>}
            </tr>
          </thead>
          <tbody>
            {def.transitions.map((t, i) => {
              const activeRequires = t.requires ?? [];
              return (
                <tr
                  key={`transition-${i}`}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <td style={td}>
                    {canEdit ? (
                      <select
                        value={t.from}
                        onChange={(e) => onUpdateTransitionField(i, "from", e.target.value)}
                        disabled={saving}
                        style={inlineSelect}
                      >
                        {def.states.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <code>{t.from}</code>
                    )}
                  </td>
                  <td style={td}>
                    {canEdit ? (
                      <select
                        value={t.to}
                        onChange={(e) => onUpdateTransitionField(i, "to", e.target.value)}
                        disabled={saving}
                        style={inlineSelect}
                      >
                        {def.states.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <code>{t.to}</code>
                    )}
                  </td>
                  <td style={td}>
                    {canEdit ? (
                      <input
                        type="text"
                        value={t.label ?? ""}
                        onChange={(e) => onUpdateTransitionField(i, "label", e.target.value)}
                        disabled={saving}
                        placeholder="(optional)"
                        style={inlineInput}
                      />
                    ) : (
                      t.label ?? "—"
                    )}
                  </td>
                  <td style={td}>
                    {canEdit ? (
                      <select
                        value={t.requiredRole ?? "any"}
                        onChange={(e) =>
                          onUpdateTransitionField(i, "requiredRole", e.target.value)
                        }
                        disabled={saving}
                        style={inlineSelect}
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : t.requiredRole && t.requiredRole !== "any" ? (
                      t.requiredRole
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={td}>
                    {canEdit ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                        {rules.map((r) => (
                          <label
                            key={r.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.4rem",
                              fontSize: "var(--text-xs)",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={activeRequires.includes(r.id)}
                              onChange={(e) => onToggleRule(i, r.id, e.target.checked)}
                              disabled={saving}
                            />
                            <span>{r.label}</span>
                            <code style={{ color: "var(--muted)" }}>({r.id})</code>
                          </label>
                        ))}
                        {activeRequires
                          .filter((r) => !rules.some((x) => x.id === r))
                          .map((r) => (
                            <span
                              key={r}
                              style={{
                                ...pill,
                                background: "rgba(239, 68, 68, 0.15)",
                                color: "#dc2626",
                              }}
                            >
                              {r} (unknown)
                            </span>
                          ))}
                      </div>
                    ) : activeRequires.length > 0 ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                        {activeRequires.map((r) => (
                          <span key={r} style={pill}>
                            {ruleLabelById.get(r) ?? r}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>none</span>
                    )}
                  </td>
                  {canEdit && (
                    <td style={{ ...td, width: "1%", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => onRemoveTransition(i)}
                        disabled={saving}
                        style={{ ...linkButton, color: "#dc2626" }}
                        title="Remove transition"
                      >
                        ✕
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {def.transitions.length === 0 && (
              <tr>
                <td
                  colSpan={canEdit ? 6 : 5}
                  style={{
                    ...td,
                    color: "var(--muted)",
                    textAlign: "center",
                    padding: "var(--space-3)",
                  }}
                >
                  No transitions defined. Tasks will not be able to change status.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
