"use client";

/**
 * StatesTable — read-only view + editable matrix of workflow states.
 *
 * Dumb component: the parent owns the draft, the validation, and the
 * mutation handlers. This component only renders and forwards user
 * actions via the callback props. No local state beyond what the
 * parent passes.
 *
 * The parent's `expandedInstructions: Set<number>` is row-index-based
 * (not name-based) so renaming a state doesn't silently collapse an
 * open textarea — see the rename propagation comment in page.tsx for
 * background.
 */

import type { WorkflowDefinition, WorkflowState } from "../../../../lib/api";
import { Button } from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import { inlineInput, linkButton, td, th } from "./styles";

export interface StatesTableProps {
  def: WorkflowDefinition;
  canEdit: boolean;
  // The state vocabulary is fixed system-wide: {open, in_progress,
  // review, done}. Add / rename / remove / set-initial / toggle-terminal
  // are all gated off independently of `canEdit`. Per-state `label` and
  // `agentInstructions` stay editable when `canEdit` is true — they are
  // display customization, not structural.
  statesLocked: boolean;
  saving: boolean;
  expandedInstructions: Set<number>;
  onAddState: () => void;
  onRemoveState: (index: number) => void;
  onUpdateStateField: <K extends keyof WorkflowState>(
    index: number,
    field: K,
    value: WorkflowState[K],
  ) => void;
  onSetInitialState: (name: string) => void;
  onToggleInstructionsExpanded: (index: number) => void;
}

export function StatesTable({
  def,
  canEdit,
  statesLocked,
  saving,
  expandedInstructions,
  onAddState,
  onRemoveState,
  onUpdateStateField,
  onSetInitialState,
  onToggleInstructionsExpanded,
}: StatesTableProps) {
  const canEditStateStructure = canEdit && !statesLocked;
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
        <h2 style={{ fontSize: "var(--text-base)", fontWeight: 700 }}>States</h2>
        {canEditStateStructure && (
          <Button type="button" variant="secondary" onClick={onAddState} disabled={saving}>
            + Add state
          </Button>
        )}
      </div>

      {statesLocked && (
        <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginBottom: "var(--space-3)" }}>
          The state vocabulary is fixed system-wide ({def.states.map((s) => s.name).join(", ")}).
          Add, rename, and remove are not available. Labels and agent instructions stay editable.
        </p>
      )}

      <div style={{ marginBottom: "var(--space-3)" }}>
        <label
          style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginRight: "0.5rem" }}
        >
          Initial state:
        </label>
        {canEditStateStructure ? (
          <select
            value={def.initialState}
            onChange={(e) => onSetInitialState(e.target.value)}
            disabled={saving}
            style={{ padding: "0.25rem 0.5rem", fontSize: "var(--text-sm)" }}
          >
            {def.states.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <code>{def.initialState}</code>
        )}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th style={th}>Name</th>
              <th style={th}>Label</th>
              <th style={th}>Terminal</th>
              <th style={th}>Agent instructions</th>
              {canEditStateStructure && <th style={th}></th>}
            </tr>
          </thead>
          <tbody>
            {def.states.map((s, i) => {
              const isExpanded = expandedInstructions.has(i);
              return (
                <tr
                  key={`${i}-${s.name}`}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <td style={td}>
                    {canEditStateStructure ? (
                      <input
                        type="text"
                        value={s.name}
                        onChange={(e) => onUpdateStateField(i, "name", e.target.value)}
                        disabled={saving}
                        style={inlineInput}
                      />
                    ) : (
                      <code>{s.name}</code>
                    )}
                  </td>
                  <td style={td}>
                    {canEdit ? (
                      <input
                        type="text"
                        value={s.label}
                        onChange={(e) => onUpdateStateField(i, "label", e.target.value)}
                        disabled={saving}
                        style={inlineInput}
                      />
                    ) : (
                      s.label
                    )}
                  </td>
                  <td style={td}>
                    {canEditStateStructure ? (
                      <input
                        type="checkbox"
                        checked={s.terminal}
                        onChange={(e) => onUpdateStateField(i, "terminal", e.target.checked)}
                        disabled={saving}
                      />
                    ) : s.terminal ? (
                      "yes"
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ ...td, maxWidth: "360px" }}>
                    {canEdit ? (
                      isExpanded ? (
                        <div>
                          <textarea
                            value={s.agentInstructions ?? ""}
                            onChange={(e) =>
                              onUpdateStateField(i, "agentInstructions", e.target.value)
                            }
                            disabled={saving}
                            rows={4}
                            style={{
                              width: "100%",
                              fontSize: "var(--text-xs)",
                              fontFamily: "inherit",
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => onToggleInstructionsExpanded(i)}
                            style={linkButton}
                          >
                            Collapse
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onToggleInstructionsExpanded(i)}
                          style={{ ...linkButton, textAlign: "left", width: "100%" }}
                        >
                          {s.agentInstructions
                            ? s.agentInstructions.split("\n")[0]?.slice(0, 80) +
                              (s.agentInstructions.length > 80 ? "…" : "")
                            : "Add instructions…"}
                        </button>
                      )
                    ) : (
                      <span style={{ color: "var(--muted)" }}>
                        {s.agentInstructions
                          ? s.agentInstructions.split("\n")[0]?.slice(0, 80) +
                            (s.agentInstructions.length > 80 ? "…" : "")
                          : "—"}
                      </span>
                    )}
                  </td>
                  {canEditStateStructure && (
                    <td style={{ ...td, width: "1%", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        onClick={() => onRemoveState(i)}
                        disabled={saving}
                        style={{ ...linkButton, color: "#dc2626" }}
                        title="Remove state"
                      >
                        ✕
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
