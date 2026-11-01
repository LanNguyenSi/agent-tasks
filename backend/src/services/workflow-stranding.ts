/**
 * The stranded-task check shared by every route that replaces the workflow a
 * group of tasks follows: apply-template, reset (DELETE /projects/:id/workflow),
 * PUT /workflows/:id and POST /projects/:id/workflows with `isDefault: true`.
 *
 * Replacing a workflow moves no task. A change blocks (409 `stranded_tasks`,
 * naming the tasks) only on the tasks IT strands: a task whose status is a
 * NON-terminal state of the definition it follows now and is not a state of the
 * definition it follows afterwards. Such a task can still be finished or moved
 * before the change, so the refusal has a way out. Everything else the change
 * leaves as it is, so it never blocks and the 2xx body reports it:
 *
 *   - `backlog` and `abandoned` live outside every workflow and never count.
 *   - A task in a TERMINAL state of the definition it follows now is finished
 *     work that cannot be moved (a terminal task takes no transition, a force
 *     transition and the admin PATCH are refused). Reported as
 *     `terminalOutsideWorkflow`.
 *   - A task whose status is no state of the definition it follows now (a
 *     legacy status, or a terminal task an earlier change left behind) is
 *     already outside; this change does nothing to it, and nothing could move
 *     it onto a state anyway. Reported as `outsideWorkflow`.
 *   Reported tasks keep their status; the board shows a status without a column
 *   in an extra last column titled with the raw status.
 *
 * Which tasks follow which workflow: a task with no `workflowId` follows the
 * project default row (the built-in definition when there is none); a task
 * with a `workflowId` follows that row. The caller names the groups of tasks
 * whose followed definition changes; a group is built only when something
 * changes for it (an identical definition changes nothing and is not checked).
 *
 * Residual, not closed: the check runs inside the project-locked grounding
 * transaction with the task rows locked, but a status writer that read the old
 * workflow before the commit can still land afterwards, because status writers
 * take no project lock and the routes do not bump `statusVersion` of the
 * following tasks. Bumping would have to touch every task row of the project,
 * and `tasks` carries BEFORE UPDATE fences (`prisma/grounding-github-fence.sql`:
 * the hold fence raises for a held task, the GitHub fence checks changed rows),
 * so a bulk bump could fail the whole workflow write for a project with one
 * held task. A task that landed on a dropped status that way is the same
 * stranded task the check refuses for, found by a later check.
 */
import type { Prisma } from "@prisma/client";
import { defaultWorkflowDefinition, sanitizeStoredDefinition, type WorkflowDefinitionShape } from "./default-workflow.js";

type TaskDb = Pick<Prisma.TransactionClient, "task">;

/** At most this many task ids are named in the 409 and in each report list. */
export const STRANDED_TASK_ID_LIMIT = 50;

/** Statuses written by dedicated routes, never workflow states (see `workflowDefinitionSchema`). */
export const RESERVED_STATE_NAMES = ["backlog", "abandoned"] as const;

/** One set of tasks that follows a definition that is about to change. */
export interface FollowerGroup {
  /** `workflowId` values of the tasks in the group; `null` = tasks with no workflow of their own. */
  workflowIds: readonly (string | null)[];
  /** The definition the group follows now. */
  before: WorkflowDefinitionShape;
  /** The definition the group follows once the change commits. */
  after: WorkflowDefinitionShape;
}

export interface StrandedCheck {
  /** Ids sorted ascending, at most STRANDED_TASK_ID_LIMIT + 1 (the extra one says the list is cut). */
  strandedTaskIds: string[];
  /** Terminal tasks whose status the new definition lacks, at most STRANDED_TASK_ID_LIMIT, by id. */
  terminalOutsideWorkflow: { id: string; status: string }[];
  terminalOutsideTruncated: boolean;
  /** Tasks already on a status the followed definition does not have, at most STRANDED_TASK_ID_LIMIT, by id. */
  outsideWorkflow: { id: string; status: string }[];
  outsideTruncated: boolean;
  /** State names of the new definition, one list per group that has stranded tasks (else per group), deduplicated. */
  afterStateLists: string[][];
}

export const NO_STRANDING: StrandedCheck = {
  strandedTaskIds: [],
  terminalOutsideWorkflow: [],
  terminalOutsideTruncated: false,
  outsideWorkflow: [],
  outsideTruncated: false,
  afterStateLists: [],
};

/** The definition a stored row stands for, or the built-in one when the project has no row. */
export function followedDefinition(row: { definition: unknown; id?: string; projectId?: string } | null | undefined): WorkflowDefinitionShape {
  return row
    ? sanitizeStoredDefinition(row.definition, { workflowId: row.id, projectId: row.projectId })
    : defaultWorkflowDefinition();
}

type TaskRef = { id: string; status: string };

const byId = (a: TaskRef, b: TaskRef) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function checkStrandedTasks(db: TaskDb, projectId: string, groups: readonly FollowerGroup[]): Promise<StrandedCheck> {
  const stranded: TaskRef[] = [];
  const terminal: TaskRef[] = [];
  const outside: TaskRef[] = [];
  const lists = new Map<string, { names: string[]; stranded: boolean }>();
  for (const group of groups) {
    const after = group.after.states.map((s) => s.name);
    const afterSet = new Set<string>([...after, ...RESERVED_STATE_NAMES]);
    const beforeOpen = group.before.states.filter((s) => !s.terminal).map((s) => s.name).filter((n) => !afterSet.has(n));
    const beforeDone = group.before.states.filter((s) => s.terminal).map((s) => s.name).filter((n) => !afterSet.has(n));
    const beforeAll = group.before.states.map((s) => s.name);
    const follows = { projectId, OR: group.workflowIds.map((workflowId) => ({ workflowId })) };
    const find = async (status: Prisma.StringFilter): Promise<TaskRef[]> =>
      db.task.findMany({ where: { ...follows, status }, select: { id: true, status: true }, orderBy: { id: "asc" }, take: STRANDED_TASK_ID_LIMIT + 1 });
    // A non-terminal state of the followed definition that the new one lacks: the change strands it.
    const groupStranded = beforeOpen.length > 0 ? await find({ in: beforeOpen }) : [];
    stranded.push(...groupStranded);
    if (beforeDone.length > 0) terminal.push(...await find({ in: beforeDone }));
    outside.push(...await find({ notIn: [...afterSet, ...beforeAll] }));
    const key = after.join("\u0000");
    const seen = lists.get(key);
    lists.set(key, { names: after, stranded: (seen?.stranded ?? false) || groupStranded.length > 0 });
  }
  stranded.sort(byId);
  terminal.sort(byId);
  outside.sort(byId);
  const anyStranded = [...lists.values()].some((l) => l.stranded);
  return {
    strandedTaskIds: stranded.slice(0, STRANDED_TASK_ID_LIMIT + 1).map((t) => t.id),
    terminalOutsideWorkflow: terminal.slice(0, STRANDED_TASK_ID_LIMIT),
    terminalOutsideTruncated: terminal.length > STRANDED_TASK_ID_LIMIT,
    outsideWorkflow: outside.slice(0, STRANDED_TASK_ID_LIMIT),
    outsideTruncated: outside.length > STRANDED_TASK_ID_LIMIT,
    afterStateLists: [...lists.values()].filter((l) => !anyStranded || l.stranded).map((l) => l.names),
  };
}

/** The additive fields every successful response of a guarded route carries. */
export function strandingReportFields(check: StrandedCheck) {
  return {
    terminalOutsideWorkflow: check.terminalOutsideWorkflow,
    terminalOutsideTruncated: check.terminalOutsideTruncated,
    outsideWorkflow: check.outsideWorkflow,
    outsideTruncated: check.outsideTruncated,
  };
}

/**
 * The 409 body of a refused change. `subject` says what was refused, `verb`
 * what it would have done. When the groups of tasks follow different target
 * definitions (a PUT that demotes the default row and changes its definition),
 * one state list per group that has stranded tasks is given.
 */
export function strandedConflictBody(input: { subject: string; verb: string; target: string; check: StrandedCheck }) {
  const ids = input.check.strandedTaskIds;
  const shown = ids.slice(0, STRANDED_TASK_ID_LIMIT);
  const lists = input.check.afterStateLists.map((names) => names.join(", "));
  const states = lists.length > 1 ? `${lists.join(" | ")}; one list per group of tasks` : lists.join("");
  return {
    error: "stranded_tasks" as const,
    message:
      `${input.subject}: ${ids.length > STRANDED_TASK_ID_LIMIT ? `more than ${STRANDED_TASK_ID_LIMIT}` : ids.length} ` +
      `task(s) are in a state that ${input.target} lacks (${states}). ` +
      `${input.verb} moves no task; finish these tasks (a task in a terminal state of the workflow it follows does not block) ` +
      `or move them to a state ${input.target} also has.`,
    taskIds: shown,
    truncated: ids.length > shown.length,
  };
}
