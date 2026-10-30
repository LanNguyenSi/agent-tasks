// The board's column list, derived from the project's stored workflows.
//
// Columns are the backlog queue (always first, as the board has always shown
// it) followed by the states of the project's workflows: the default
// workflow's states in a stable order (its initial state first, its terminal
// states last, the rest in graph order along the transitions), then the
// states that only occur in the project's other (task-pinned) workflows, in
// the order the workflows are listed. A state named in several workflows is
// one column, listed once, labelled from the first workflow that names it.
//
// Every stored definition is read through sanitizeStoredDefinition (the port
// of the backend reader), so a legacy definition that mentions `backlog` or
// starts there reads exactly like the backend reads it; a `backlog` state in
// a custom list never becomes a second backlog column. A definition that
// cannot be read (anything that makes the backend throw) reads as the built-in
// workflow, like every other reader of the port, and a project whose workflow
// list cannot be read at all (403, network) shows exactly the built-in five.
//
// Invariant: no task is ever invisible. A task whose status matches no column
// (a state of a deleted workflow, or a project whose workflows cannot be read)
// lands in an extra last column titled with the raw state name, so the sum of
// the column counts always equals the number of tasks handed in.
//
// The list is computed once per (workflows, tasks) pair by the board page and
// drives the columns, the jump bar, the grid column count and the list-view
// status chip row.

import type { Task, Workflow } from "./api";
import { STATUS_LABELS, normalizeStatus } from "./status";
import { sanitizeStoredDefinition } from "./workflow-vocabulary";

/** The built-in workflow's pipeline states (backlog is the queue in front). */
const BUILT_IN_STATES: readonly string[] = ["open", "in_progress", "review", "done"];

const BACKLOG_STATE = "backlog";

/** One board column: a workflow state name plus what the view needs. */
export interface BoardColumn {
  /** Raw state name (API form, `[a-z0-9_]+` for workflow states): the id and
   *  the task match. The CSS class normalizes `in_progress` separately. */
  status: string;
  /** Column title: the state's workflow label, else the built-in status name,
   *  else the state name made readable, else (extra column) the raw name. */
  label: string;
  /** Terminal column: carries the Done cap. */
  terminal: boolean;
  /** One of the five built-in states (backlog included): gets the built-in
   *  dot class and badge tone; custom states read as neutral. */
  builtIn: boolean;
}

type SanitizedDefinition = ReturnType<typeof sanitizeStoredDefinition>;

/** A stored definition the backend reader can read. */
function isReadableDefinition(workflow: Workflow): boolean {
  try {
    const def = sanitizeStoredDefinition(workflow.definition);
    return Array.isArray(def?.states) && Array.isArray(def?.transitions) && typeof def.initialState === "string";
  } catch {
    return false;
  }
}

/**
 * The workflow rows the way the board reads them: `null` (or a failed load)
 * means the project's workflows could not be read and the board shows the
 * built-in columns; a list (possibly empty) is the project's workflow rows.
 */
export function buildBoardColumns(
  workflows: readonly Workflow[] | null | undefined,
  tasks: readonly Pick<Task, "status">[],
): BoardColumn[] {
  const columns: BoardColumn[] = [];
  const seen = new Set<string>();
  // First label wins: the default workflow is processed first.
  const labels = new Map<string, string>();

  const push = (status: string, label: string, terminal: boolean) => {
    // The board renders the backlog column itself, always first; a (legacy)
    // backlog state inside a workflow list is that same column, never a
    // second one.
    if (status === BACKLOG_STATE || seen.has(status)) return;
    seen.add(status);
    columns.push({
      status,
      label,
      terminal,
      builtIn: BUILT_IN_STATES.includes(status),
    });
  };

  // Label order: the five built-in state names always read with the board's
  // own vocabulary (STATUS_LABELS), so the built-in columns keep today's
  // titles even though the stored default workflow labels two of them
  // differently ("In progress", "In review"). Any other state takes the
  // workflow's label when set, else its name made readable.
  const labelFrom = (name: string): string => {
    const builtInLabel = STATUS_LABELS[normalizeStatus(name)];
    if (builtInLabel) return builtInLabel;
    const workflowLabel = labels.get(name);
    if (workflowLabel) return workflowLabel;
    return readableStateName(name);
  };

  // Unreadable list (403, network): exactly the built-in five columns, unknown
  // task statuses notwithstanding get their extra columns below like always.
  const readable = workflows != null;
  // Default workflow first, then the other (task-pinned) workflows in listed
  // order.
  const ordered = readable
    ? [...workflows.filter((w) => w.isDefault), ...workflows.filter((w) => !w.isDefault)]
    : [];

  if (readable) {
    for (const wf of ordered) {
      try {
        for (const state of sanitizeStoredDefinition(wf.definition).states) {
          if (typeof state?.name !== "string" || !state.name || labels.has(state.name)) continue;
          if (typeof state.label === "string" && state.label.trim() !== "") {
            labels.set(state.name, state.label.trim());
          }
        }
      } catch {
        // Unreadable definition: its states carry no workflow label.
      }
    }
  }

  const defaults = ordered.filter((w) => w.isDefault);
  // A readable default row whose states are used; an absent row or an
  // unreadable definition falls back to the built-in pipeline.
  let defaultColumns = false;
  if (defaults.length > 0) {
    for (const wf of defaults) {
      if (!isReadableDefinition(wf)) continue;
      const def: SanitizedDefinition = sanitizeStoredDefinition(wf.definition);
      for (const name of orderStates(def)) push(name, labelFrom(name), isTerminalName(def, name));
      defaultColumns = true;
    }
  }
  if (!defaultColumns) {
    for (const name of BUILT_IN_STATES) push(name, labelFrom(name), name === "done");
  }
  for (const wf of ordered) {
    if (wf.isDefault) continue;
    let names: string[] = [];
    let def: SanitizedDefinition | null = null;
    try {
      def = sanitizeStoredDefinition(wf.definition);
      names = orderStates(def);
    } catch {
      names = [];
    }
    for (const name of names) {
      push(name, labelFrom(name), def !== null && isTerminalName(def, name));
    }
  }

  // Backlog is always the first column (the queue in front of the pipeline).
  seen.add(BACKLOG_STATE);
  columns.unshift({
    status: BACKLOG_STATE,
    label: STATUS_LABELS[normalizeStatus(BACKLOG_STATE)] ?? BACKLOG_STATE,
    terminal: false,
    builtIn: true,
  });

  // No task is ever invisible: any status with no column of its own gets an
  // extra last column titled with the raw state name.
  const extraSeen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.status) || extraSeen.has(task.status)) continue;
    extraSeen.add(task.status);
    columns.push({ status: task.status, label: task.status, terminal: false, builtIn: false });
  }

  return columns;
}

function isTerminalName(def: { states: { name: string; terminal?: boolean }[] }, name: string): boolean {
  return def.states.find((s) => s.name === name)?.terminal === true;
}

/**
 * The definition's states in a stable order: the initial state first (a BFS
 * along the transitions), unreachable states in their listed order behind the
 * reachable ones, and every terminal state last (in the order the walk
 * reached it). Names are `[a-z0-9_]+` and `initialState` is `open` (P5A) and
 * never terminal, so the initial state can never move to the back.
 */
function orderStates(def: SanitizedDefinition): string[] {
  const names = def.states.map((s) => s.name);
  const nameSet = new Set(names);
  const outgoing = new Map<string, string[]>();
  for (const edge of def.transitions) {
    if (!nameSet.has(edge.from) || !nameSet.has(edge.to)) continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }
  const walked: string[] = [];
  const visited = new Set<string>();
  const queue = names.includes(def.initialState) ? [def.initialState] : [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    walked.push(name);
    for (const next of outgoing.get(name) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  // States no edge leads to keep their listed position behind the walked ones.
  const ordered = walked.concat(names.filter((n) => !visited.has(n)));
  const isTerminal = (n: string) => isTerminalName(def, n);
  return [...ordered.filter((n) => !isTerminal(n)), ...ordered.filter((n) => isTerminal(n))];
}

/** `plan` -> `Plan`, `in_review` -> `In review`. */
function readableStateName(name: string): string {
  const spaced = name.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
