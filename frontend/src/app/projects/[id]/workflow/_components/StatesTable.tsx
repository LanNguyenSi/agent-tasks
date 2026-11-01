"use client";

/**
 * StatesTable v2: uses the ui/Table primitive.
 *
 * The parent owns the draft and the mutation handlers; this component
 * renders and forwards user actions via the callback props. Its only own
 * state is view state for the name inputs: the text of a name that fails the
 * backend's name rules (shown with its error, never forwarded, so the draft
 * and the transitions that follow a rename always hold a valid name) and the
 * focus to restore after a row was added or removed.
 */

import { useEffect, useRef, useState } from "react";
import type { WorkflowDefinition, WorkflowState } from "../../../../../lib/api";
import { Button } from "../../../../../components/ui/Button";
import Card from "../../../../../components/ui/Card";
import { Table, type ColumnDef } from "../../../../../components/ui/Table";
import { SkeletonList } from "../../../../../components/ui/Skeleton";
import {
  RESERVED_STATE_NAMES,
  STATE_NAME_MAX_LENGTH,
  WORKFLOW_INITIAL_STATE,
  validateStateName,
} from "./stateRules";

// Row shape: WorkflowState enriched with its position index.
type StateRow = WorkflowState & { _index: number };

export interface StatesTableProps {
  def: WorkflowDefinition;
  canEdit: boolean;
  saving: boolean;
  loading?: boolean;
  expandedInstructions: Set<number>;
  onAddState: () => void;
  onRemoveState: (index: number) => void;
  onUpdateStateField: <K extends keyof WorkflowState>(
    index: number,
    field: K,
    value: WorkflowState[K],
  ) => void;
  onToggleInstructionsExpanded: (index: number) => void;
}

function withoutIndex(names: Record<number, string>, index: number): Record<number, string> {
  if (!(index in names)) return names;
  const next = { ...names };
  delete next[index];
  return next;
}

export function StatesTable({
  def,
  canEdit,
  saving,
  loading,
  expandedInstructions,
  onAddState,
  onRemoveState,
  onUpdateStateField,
  onToggleInstructionsExpanded,
}: StatesTableProps) {
  // Text of a name input whose value fails the name rules, by row index.
  const [invalidNames, setInvalidNames] = useState<Record<number, string>>({});
  const nameInputs = useRef(new Map<number, HTMLInputElement>());
  const headerRef = useRef<HTMLDivElement>(null);
  // Focus target after an add or remove: applied once the definition has the
  // expected row count (a refused removal leaves the count, and the focus, alone).
  const pendingFocus = useRef<{ index: number; statesAfter: number } | null>(null);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    if (def.states.length !== pending.statesAfter) return;
    const target =
      nameInputs.current.get(pending.index) ??
      headerRef.current?.querySelector<HTMLButtonElement>("button");
    target?.focus();
  });

  function handleAdd() {
    pendingFocus.current = { index: def.states.length, statesAfter: def.states.length + 1 };
    setInvalidNames({});
    onAddState();
  }

  function handleRemove(index: number) {
    const statesAfter = def.states.length - 1;
    pendingFocus.current = { index: Math.min(index, statesAfter - 1), statesAfter };
    setInvalidNames({});
    onRemoveState(index);
  }

  function handleNameChange(index: number, value: string) {
    if (validateStateName(value, def, index) !== null) {
      setInvalidNames((prev) => ({ ...prev, [index]: value }));
      return;
    }
    setInvalidNames((prev) => withoutIndex(prev, index));
    if (value !== def.states[index]?.name) onUpdateStateField(index, "name", value);
  }

  function handleNameBlur(index: number) {
    setInvalidNames((prev) => withoutIndex(prev, index));
  }

  const rows: StateRow[] = def.states.map((s, i) => ({ ...s, _index: i }));

  const columns: ColumnDef<StateRow>[] = [
    {
      key: "name",
      header: "Name",
      sortable: false,
      width: "160px",
      render: (row) => {
        // The initial state is pinned to `open` by the engine: it can be
        // neither renamed nor removed, so its name is never an input.
        if (!canEdit || row.name === WORKFLOW_INITIAL_STATE) {
          return <code className="wf-code-ref">{row.name}</code>;
        }
        const shown = invalidNames[row._index] ?? row.name;
        const error =
          row._index in invalidNames ? validateStateName(shown, def, row._index) : null;
        const errorId = `state-name-error-${row._index}`;
        return (
          <div>
            <input
              type="text"
              className="wf-inline-input"
              value={shown}
              onChange={(e) => handleNameChange(row._index, e.target.value)}
              onBlur={() => handleNameBlur(row._index)}
              disabled={saving}
              maxLength={STATE_NAME_MAX_LENGTH + 1}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              aria-label={`State name for row ${row._index + 1}`}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? errorId : undefined}
              ref={(el) => {
                if (el) nameInputs.current.set(row._index, el);
                else nameInputs.current.delete(row._index);
              }}
            />
            {error !== null && (
              <p id={errorId} role="alert" className="wf-table-hint">
                {error}
              </p>
            )}
          </div>
        );
      },
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
            value={row.label}
            onChange={(e) => onUpdateStateField(row._index, "label", e.target.value)}
            disabled={saving}
            aria-label={`Label for state ${row.name}`}
          />
        ) : (
          <span>{row.label}</span>
        ),
    },
    {
      key: "terminal",
      header: "Terminal",
      sortable: false,
      width: "80px",
      align: "center",
      render: (row) => {
        if (!canEdit) {
          return row.terminal ? (
            <span className="wf-code-ref">yes</span>
          ) : (
            <span className="wf-muted-text">—</span>
          );
        }
        // A task created in a terminal state could never be claimed, so the
        // initial state cannot be marked terminal (it can still be unmarked,
        // to repair a stored definition that has it).
        const fixed = row.name === def.initialState && !row.terminal;
        const reasonId = `state-terminal-reason-${row._index}`;
        return (
          <>
            <input
              type="checkbox"
              checked={row.terminal}
              onChange={(e) => onUpdateStateField(row._index, "terminal", e.target.checked)}
              disabled={saving || fixed}
              aria-label={`Mark state ${row.name} as terminal`}
              aria-describedby={fixed ? reasonId : undefined}
            />
            {fixed && (
              <span id={reasonId} className="sr-only">
                {row.name} is the initial state: a task created in a terminal state could never be claimed.
              </span>
            )}
          </>
        );
      },
    },
    {
      key: "agentInstructions",
      header: "Agent instructions",
      sortable: false,
      render: (row) => {
        const isExpanded = expandedInstructions.has(row._index);
        if (!canEdit) {
          return (
            <span className="wf-muted-text">
              {row.agentInstructions
                ? row.agentInstructions.split("\n")[0]?.slice(0, 80) +
                  (row.agentInstructions.length > 80 ? "…" : "")
                : "—"}
            </span>
          );
        }
        if (isExpanded) {
          return (
            <div>
              <textarea
                className="wf-instructions-textarea"
                value={row.agentInstructions ?? ""}
                onChange={(e) => onUpdateStateField(row._index, "agentInstructions", e.target.value)}
                disabled={saving}
                rows={4}
                aria-label={`Agent instructions for state ${row.name}`}
              />
              <button
                type="button"
                className="wf-link-btn"
                onClick={() => onToggleInstructionsExpanded(row._index)}
              >
                Collapse
              </button>
            </div>
          );
        }
        return (
          <button
            type="button"
            className="wf-link-btn wf-link-btn--expand"
            onClick={() => onToggleInstructionsExpanded(row._index)}
          >
            {row.agentInstructions
              ? row.agentInstructions.split("\n")[0]?.slice(0, 80) +
                (row.agentInstructions.length > 80 ? "…" : "")
              : "Add instructions…"}
          </button>
        );
      },
    },
  ];

  if (canEdit) {
    columns.push({
      key: "_actions",
      header: "Remove",
      headerVisuallyHidden: true,
      sortable: false,
      width: "40px",
      align: "center",
      render: (row) => {
        // Every task starts in the initial state, so it cannot be removed.
        const fixed = row.name === def.initialState;
        const reasonId = `state-remove-reason-${row._index}`;
        return (
          <>
            <button
              type="button"
              className="wf-danger-btn"
              onClick={() => handleRemove(row._index)}
              disabled={saving || fixed}
              title={`Remove state ${row.name}`}
              aria-label={`Remove state ${row.name}`}
              aria-describedby={fixed ? reasonId : undefined}
            >
              ✕
            </button>
            {fixed && (
              <span id={reasonId} className="sr-only">
                {row.name} is the initial state: every task starts there, so it cannot be removed.
              </span>
            )}
          </>
        );
      },
    });
  }

  return (
    <Card className="wf-table-section">
      <div className="wf-table-header" ref={headerRef}>
        <h2 className="wf-table-title">States</h2>
        {canEdit && (
          <Button type="button" variant="secondary" size="sm" onClick={handleAdd} disabled={saving}>
            + Add state
          </Button>
        )}
      </div>

      {canEdit && (
        <p className="wf-table-hint">
          Names use lowercase letters, digits and underscores (at most {STATE_NAME_MAX_LENGTH}).{" "}
          {RESERVED_STATE_NAMES.join(" and ")} are reserved. Renaming a state updates its
          transitions. Tasks in a state you rename or remove are not moved: move them first.
        </p>
      )}

      <div className="wf-initial-row">
        <span>Initial state:</span>
        <code className="wf-code-ref">{def.initialState}</code>
        {canEdit && <span>(fixed: every task starts in {WORKFLOW_INITIAL_STATE})</span>}
      </div>

      {loading ? (
        <SkeletonList rows={4} rowHeight="2.5rem" label="Loading states" />
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => `state-${row._index}`}
          emptyLabel="No states defined."
          className="table-wrapper--late-stack"
        />
      )}
    </Card>
  );
}
