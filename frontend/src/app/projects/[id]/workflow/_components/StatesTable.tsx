"use client";

/**
 * StatesTable v2: uses the ui/Table primitive.
 *
 * Dumb component: the parent owns the draft, the validation, and the
 * mutation handlers. This component only renders and forwards user
 * actions via the callback props. No local state beyond what the
 * parent passes.
 */

import type { WorkflowDefinition, WorkflowState } from "../../../../../lib/api";
import { Button } from "../../../../../components/ui/Button";
import Card from "../../../../../components/ui/Card";
import { Table, type ColumnDef } from "../../../../../components/ui/Table";
import { SkeletonList } from "../../../../../components/ui/Skeleton";

// Row shape: WorkflowState enriched with its position index.
type StateRow = WorkflowState & { _index: number };

export interface StatesTableProps {
  def: WorkflowDefinition;
  canEdit: boolean;
  /** When true, add/rename/remove/set-initial/toggle-terminal are blocked. */
  statesLocked: boolean;
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
  onSetInitialState: (name: string) => void;
  onToggleInstructionsExpanded: (index: number) => void;
}

export function StatesTable({
  def,
  canEdit,
  statesLocked,
  saving,
  loading,
  expandedInstructions,
  onAddState,
  onRemoveState,
  onUpdateStateField,
  onSetInitialState,
  onToggleInstructionsExpanded,
}: StatesTableProps) {
  const canEditStateStructure = canEdit && !statesLocked;

  const rows: StateRow[] = def.states.map((s, i) => ({ ...s, _index: i }));

  const columns: ColumnDef<StateRow>[] = [
    {
      key: "name",
      header: "Name",
      sortable: false,
      width: "160px",
      render: (row) =>
        canEditStateStructure ? (
          <input
            type="text"
            className="wf-inline-input"
            value={row.name}
            onChange={(e) => onUpdateStateField(row._index, "name", e.target.value)}
            disabled={saving}
            aria-label={`State name for row ${row._index + 1}`}
          />
        ) : (
          <code className="wf-code-ref">{row.name}</code>
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
      render: (row) =>
        canEditStateStructure ? (
          <input
            type="checkbox"
            checked={row.terminal}
            onChange={(e) => onUpdateStateField(row._index, "terminal", e.target.checked)}
            disabled={saving}
            aria-label={`Mark state ${row.name} as terminal`}
          />
        ) : row.terminal ? (
          <span className="wf-code-ref">yes</span>
        ) : (
          <span className="wf-muted-text">—</span>
        ),
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

  if (canEditStateStructure) {
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
          onClick={() => onRemoveState(row._index)}
          disabled={saving}
          title={`Remove state ${row.name}`}
          aria-label={`Remove state ${row.name}`}
        >
          ✕
        </button>
      ),
    });
  }

  return (
    <Card className="wf-table-section">
      <div className="wf-table-header">
        <h2 className="wf-table-title">States</h2>
        {canEditStateStructure && (
          <Button type="button" variant="secondary" size="sm" onClick={onAddState} disabled={saving}>
            + Add state
          </Button>
        )}
      </div>

      {statesLocked && (
        <p className="wf-table-hint">
          The state vocabulary is fixed system-wide ({def.states.map((s) => s.name).join(", ")}).
          Add, rename, and remove are not available. Labels and agent instructions stay editable.
        </p>
      )}

      <div className="wf-initial-row">
        <span>Initial state:</span>
        {canEditStateStructure ? (
          <select
            className="wf-inline-select"
            value={def.initialState}
            onChange={(e) => onSetInitialState(e.target.value)}
            disabled={saving}
            aria-label="Initial state"
          >
            {def.states.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        ) : (
          <code className="wf-code-ref">{def.initialState}</code>
        )}
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
