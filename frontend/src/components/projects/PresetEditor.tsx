// PresetEditor: editable list of task-template presets.
// Extracted from settings/page.tsx.
// Geometry in globals.css (card/surface/form primitives).

import type { TemplatePreset } from "../../lib/api";
import FormField from "../ui/FormField";

interface PresetEditorProps {
  presets: TemplatePreset[];
  onChange: (presets: TemplatePreset[]) => void;
  /** Which template fields are active; determines which preset fields to show */
  showGoal: boolean;
  showAC: boolean;
  showContext: boolean;
  showConstraints: boolean;
}

export default function PresetEditor({
  presets,
  onChange,
  showGoal,
  showAC,
  showContext,
  showConstraints,
}: PresetEditorProps) {
  function updatePreset(idx: number, patch: Partial<TemplatePreset>) {
    const next = [...presets];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  }

  function removePreset(idx: number) {
    onChange(presets.filter((_, i) => i !== idx));
  }

  function addPreset() {
    onChange([...presets, { name: "" }]);
  }

  return (
    <div>
      <p className="proj-section-desc">
        Reusable starting points that pre-fill template fields when creating a
        task.
      </p>
      {presets.map((preset, idx) => (
        <div
          key={idx}
          className="card card--raised card--padding-sm"
          // eslint-disable-next-line no-restricted-syntax
          style={{ marginBottom: "var(--space-3)" }} /* dynamic: stacked list spacing */
        >
          <div
            // eslint-disable-next-line no-restricted-syntax
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }} /* dynamic: row layout */
          >
            <FormField label="Preset name">
              <input
                value={preset.name}
                onChange={(e) => updatePreset(idx, { name: e.target.value })}
                placeholder="e.g. Bug Fix"
                // eslint-disable-next-line no-restricted-syntax
                style={{ fontWeight: 600, fontSize: "var(--text-sm)" }} /* dynamic: intentional weight override */
              />
            </FormField>
            <button
              type="button"
              onClick={() => removePreset(idx)}
              className="btn-ghost btn--box btn--sm"
              // eslint-disable-next-line no-restricted-syntax
              style={{ color: "var(--danger)", marginTop: "var(--space-5)" }} /* dynamic: danger tint on ghost */
              aria-label={`Remove preset ${preset.name || String(idx + 1)}`}
            >
              Remove
            </button>
          </div>
          <div
            // eslint-disable-next-line no-restricted-syntax
            style={{ display: "grid", gap: "var(--space-2)" }} /* dynamic: grid gap */
          >
            <FormField label="Description">
              <textarea
                value={preset.description ?? ""}
                onChange={(e) => updatePreset(idx, { description: e.target.value })}
                placeholder="Short description shown in the create dialog"
                rows={2}
                // eslint-disable-next-line no-restricted-syntax
                style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }} /* dynamic: width/resize */
              />
            </FormField>
            {showGoal && (
              <FormField label="Goal">
                <textarea
                  value={preset.goal ?? ""}
                  onChange={(e) => updatePreset(idx, { goal: e.target.value })}
                  placeholder="Goal"
                  rows={2}
                  // eslint-disable-next-line no-restricted-syntax
                  style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }} /* dynamic: width/resize */
                />
              </FormField>
            )}
            {showAC && (
              <FormField label="Acceptance criteria">
                <textarea
                  value={preset.acceptanceCriteria ?? ""}
                  onChange={(e) => updatePreset(idx, { acceptanceCriteria: e.target.value })}
                  placeholder="Acceptance criteria"
                  rows={2}
                  // eslint-disable-next-line no-restricted-syntax
                  style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }} /* dynamic: width/resize */
                />
              </FormField>
            )}
            {showContext && (
              <FormField label="Context">
                <textarea
                  value={preset.context ?? ""}
                  onChange={(e) => updatePreset(idx, { context: e.target.value })}
                  placeholder="Context"
                  rows={2}
                  // eslint-disable-next-line no-restricted-syntax
                  style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }} /* dynamic: width/resize */
                />
              </FormField>
            )}
            {showConstraints && (
              <FormField label="Constraints">
                <textarea
                  value={preset.constraints ?? ""}
                  onChange={(e) => updatePreset(idx, { constraints: e.target.value })}
                  placeholder="Constraints"
                  rows={2}
                  // eslint-disable-next-line no-restricted-syntax
                  style={{ width: "100%", resize: "vertical", fontSize: "var(--text-xs)" }} /* dynamic: width/resize */
                />
              </FormField>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="filter-chip"
        onClick={addPreset}
        // eslint-disable-next-line no-restricted-syntax
        style={{ marginTop: "var(--space-2)" }} /* dynamic: spacing after preset list */
      >
        + Add preset
      </button>
    </div>
  );
}
