"use client";

// Collapsible filter row: appears below the PageHeader when the Filter
// button is toggled. Shows scope, done-visibility, and label selectors.
// Geometry in .db-filter-bar and related classes in globals.css.

import type { DoneVisibility } from "../../lib/dashboardPrefs";
import Select from "../ui/Select";

type Scope = "all" | "mine" | "overdue" | "unassigned";

interface FilterToolbarProps {
  taskScope: Scope;
  onScopeChange: (scope: Scope) => void;
  doneVisibility: DoneVisibility;
  onDoneVisibilityChange: (v: DoneVisibility) => void;
  labels: string[];
  labelFilter: string | null;
  onLabelFilterChange: (label: string | null) => void;
  hiddenDoneCount: number;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}

const SCOPE_OPTIONS = [
  { value: "all", label: "All tasks" },
  { value: "mine", label: "Assigned to me" },
  { value: "overdue", label: "Overdue" },
  { value: "unassigned", label: "Unassigned" },
];

const DONE_OPTIONS = [
  { value: "recent", label: "Recent" },
  { value: "all", label: "All" },
  { value: "none", label: "None" },
];

export default function FilterToolbar({
  taskScope,
  onScopeChange,
  doneVisibility,
  onDoneVisibilityChange,
  labels,
  labelFilter,
  onLabelFilterChange,
  hiddenDoneCount,
  hasActiveFilters,
  onClearFilters,
}: FilterToolbarProps) {
  return (
    <div className="db-filter-bar">
      <div className="db-filter-group">
        <span className="db-filter-label">Scope</span>
        <Select
          ariaLabel="Scope"
          value={taskScope}
          onChange={(v) => onScopeChange(v as Scope)}
          options={SCOPE_OPTIONS}
        />
      </div>

      <div className="db-filter-group">
        <span className="db-filter-label">Done</span>
        <Select
          ariaLabel="Done visibility"
          value={doneVisibility}
          onChange={(v) => onDoneVisibilityChange(v as DoneVisibility)}
          options={DONE_OPTIONS}
        />
        {hiddenDoneCount > 0 && doneVisibility !== "all" && (
          <button
            type="button"
            className="btn-link"
            onClick={() => onDoneVisibilityChange("all")}
          >
            Show {hiddenDoneCount} hidden
          </button>
        )}
      </div>

      {labels.length > 0 && (
        <div className="db-filter-group">
          <span className="db-filter-label">Labels</span>
          <Select
            ariaLabel="Labels"
            value={labelFilter ?? ""}
            onChange={(v) => onLabelFilterChange(v || null)}
            options={[
              { value: "", label: "All labels" },
              ...labels.map((l) => ({ value: l, label: l })),
            ]}
          />
        </div>
      )}

      {hasActiveFilters && (
        <button
          type="button"
          className="filter-chip filter-chip-clear db-filter-clear"
          onClick={onClearFilters}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
