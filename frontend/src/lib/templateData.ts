import type { TemplateData, TaskType } from "./confidence";

/** The string-editor values the TaskDetail form holds in local state, plus the
 *  taskType select. One entry per editable templateData key. */
export interface TemplateDataEdits {
  goal: string;
  acceptanceCriteria: string;
  context: string;
  constraints: string;
  scope: string;
  outOfScope: string;
  dependencies: string;
  risk: string;
  agentPrompt: string;
  taskType: TaskType | "";
}

// The string-valued templateData keys, in editor order. `as const` keeps the
// element type to these 9 literals (not the wider `keyof` intersection, which
// would also admit `taskType`/`prefers` and break the string assignment below).
const STRING_KEYS = [
  "goal",
  "acceptanceCriteria",
  "context",
  "constraints",
  "scope",
  "outOfScope",
  "dependencies",
  "risk",
  "agentPrompt",
] as const;

/**
 * Reconstruct the COMPLETE templateData object to persist on Save.
 *
 * Root-cause fix for the Save data-loss: the backend PATCH replaces the whole
 * templateData JSON column with whatever the client sends (a deliberate,
 * predictable contract — create does the same, and `null` clears it). The old
 * handleSaveTask rebuilt the object from only the four rendered editors, so any
 * key the editor never reads — `prefers` (no editor), `taskType`, and the new
 * executability fields, plus any field a producer set via MCP — was silently
 * wiped on every human Save.
 *
 * The fix keeps the simple backend contract and makes the CLIENT send the full
 * object: seed from the existing stored templateData (carrying through
 * `prefers` and any field without an editor), then apply each editor value —
 * a non-empty trimmed value SETS the key, an empty value DELETES it (so
 * blanking a textarea correctly clears that field under the full-replace
 * write, which a shallow backend merge could not do). Returns `null` when the
 * result is empty, matching the prior "no templateData" semantics.
 *
 * Note: all editor state MUST be seeded from `existing` for every key
 * (including fields the project template gates off), so an unrendered-but-set
 * field round-trips through its seeded state untouched.
 */
export function buildSavedTemplateData(
  existing: TemplateData | null,
  edits: TemplateDataEdits,
): TemplateData | null {
  const out: TemplateData = { ...(existing ?? {}) };

  for (const key of STRING_KEYS) {
    const trimmed = edits[key].trim();
    if (trimmed) out[key] = trimmed;
    else delete out[key];
  }

  if (edits.taskType !== "") out.taskType = edits.taskType;
  else delete out.taskType;

  return Object.keys(out).length > 0 ? out : null;
}
