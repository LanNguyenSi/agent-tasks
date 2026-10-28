/**
 * The task states an API input or filter accepts, derived from the workflow.
 *
 * A status that reaches the API (create, PATCH, the status filters) used to be
 * checked against a fixed list of the four built-in names. The names a task can
 * hold are the states of its own effective workflow, plus the two names that sit
 * outside every workflow definition: `backlog` (the unpromoted draft) and
 * `abandoned` (the sink a creator abandon writes). This file builds that list
 * from a definition, so a workflow with other state names is accepted by the
 * same inputs, and an unknown name is still refused with the message and shape
 * the fixed list produced.
 *
 * With the built-in workflow the list is `backlog, open, in_progress, review,
 * done` (+ `abandoned` where the input takes it), exactly the old enum.
 */

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  BACKLOG_STATE,
  defaultWorkflowDefinition,
  resolveProjectEffectiveDefinition,
  sanitizeStoredDefinition,
  type WorkflowDefinitionShape,
} from "./default-workflow.js";
import { loadWorkflowRows } from "./workflow-status-filter.js";

/** The sink a creator abandon writes; no workflow definition declares it. */
export const ABANDONED_STATE = "abandoned";

type ProjectWorkflowReader = Pick<Prisma.TransactionClient, "workflow">;

function stateNames(def: WorkflowDefinitionShape): string[] {
  // A stored definition that cannot be read contributes nothing: the inputs
  // then fall back to what the other definitions in scope (or backlog and
  // abandoned alone) allow, and the workflow API does not accept such a
  // definition in the first place.
  if (!def || !Array.isArray(def.states)) return [];
  return def.states.map((s) => s?.name).filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * `backlog`, then the names in `names` (first appearance order, without the two
 * reserved names), then `abandoned` when `withAbandoned`. `backlog` and
 * `abandoned` are always allowed by the inputs that list them; a stored
 * definition that still names `backlog` (see sanitizeStoredDefinition) does not
 * list it twice.
 */
export function statusVocabulary(names: Iterable<string>, opts: { withAbandoned: boolean }): string[] {
  const seen = new Set<string>([BACKLOG_STATE, ABANDONED_STATE]);
  const out: string[] = [BACKLOG_STATE];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (opts.withAbandoned) out.push(ABANDONED_STATE);
  return out;
}

/** The statuses one task's (or one project's) effective definition allows. */
export function statusVocabularyOf(def: WorkflowDefinitionShape, opts: { withAbandoned: boolean }): string[] {
  return statusVocabulary(stateNames(def), opts);
}

/**
 * The statuses a status filter on one project accepts: the states of the
 * project's default workflow (the built-in one when it has no default row) and
 * of every other workflow row of the project, because a task pinned to such a
 * row lives in the project too. One query for the project's rows.
 */
export async function projectStatusFilterVocabulary(
  db: ProjectWorkflowReader,
  projectId: string,
): Promise<string[]> {
  const rows = await loadWorkflowRows(db, { projectId });
  const defaultRow = rows.find((r) => r.isDefault);
  const defaultDef = defaultRow
    ? sanitizeStoredDefinition(defaultRow.definition, { workflowId: defaultRow.id, projectId })
    : defaultWorkflowDefinition();
  const names = [...stateNames(defaultDef)];
  for (const row of rows) {
    if (row === defaultRow) continue;
    names.push(...stateNames(sanitizeStoredDefinition(row.definition, { workflowId: row.id, projectId })));
  }
  return statusVocabulary(names, { withAbandoned: true });
}

/**
 * The statuses a team-wide status filter accepts: the built-in states (a project
 * without a default row resolves to them) and the states of every workflow row
 * of the team's projects. A filter is a read, so a name that exists in some
 * project of the team and not in another only narrows the result, it cannot
 * write a status the task's own workflow lacks. One query for the rows.
 */
export async function teamStatusFilterVocabulary(db: ProjectWorkflowReader, teamId: string): Promise<string[]> {
  const rows = await loadWorkflowRows(db, { project: { teamId } });
  const names = [...stateNames(defaultWorkflowDefinition())];
  for (const row of rows) {
    names.push(...stateNames(sanitizeStoredDefinition(row.definition, { workflowId: row.id, projectId: row.projectId })));
  }
  return statusVocabulary(names, { withAbandoned: true });
}

/**
 * The statuses a create accepts for a new task of `projectId`: the states of
 * `workflowDefinition` when the task is pinned to a workflow, else the
 * project's effective default; no `abandoned` (a task is never created
 * abandoned).
 */
export async function createStatusVocabulary(
  db: ProjectWorkflowReader,
  projectId: string,
  workflowId: string | undefined,
): Promise<string[]> {
  if (workflowId) {
    const pinned = await db.workflow.findFirst({ where: { id: workflowId, projectId }, select: { id: true, definition: true } });
    if (pinned) {
      return statusVocabularyOf(sanitizeStoredDefinition(pinned.definition, { workflowId, projectId }), { withAbandoned: false });
    }
    // A workflowId that is not this project's is refused by the caller's own
    // check with its own message; the status is judged on the project default.
  }
  return statusVocabularyOf(await resolveProjectEffectiveDefinition(projectId, db), { withAbandoned: false });
}

/**
 * The zod error a status outside `allowed` produces: the same issue, with the
 * same message ("Invalid option: expected one of ..."), the old fixed enum
 * produced on `status`. Null when `value` is allowed.
 */
export function statusInputError(allowed: readonly string[], value: unknown): z.ZodError | null {
  const result = z
    .object({ status: z.enum(allowed as [string, ...string[]]) })
    .safeParse({ status: value });
  return result.success ? null : result.error;
}

/**
 * The 400 body `zValidate` sends for a failed body validation (see
 * lib/z-validate.ts), built from `error`, with `prefix` put in front of each
 * issue path (a batch import reports `tasks.<index>.status`).
 */
export function statusInputErrorBody(error: z.ZodError, prefix: (string | number)[] = []) {
  return {
    success: false as const,
    error: {
      issues: error.issues.map((issue) => ({ ...issue, path: [...prefix, ...issue.path] })),
      name: "ZodError" as const,
    },
  };
}
