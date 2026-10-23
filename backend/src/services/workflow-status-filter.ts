/**
 * Status filters that follow each task's own workflow instead of the built-in
 * state names.
 *
 * Queries such as the review pickup, the webhook PR binding and the
 * single-active-claim check span tasks of several projects, and a state name
 * can be terminal in one workflow and open in another. A union of terminal
 * names used as a flat `notIn` would wrongly drop a task whose own workflow
 * treats that name as open. So the filters here are built per workflow: one
 * condition per group of workflows that share the same state set, joined by
 * `OR`, each pinned to the tasks that resolve to those workflows.
 *
 * Which workflow a task resolves to follows `resolveEffectiveDefinition`:
 * the task's pinned workflow, else the project's default workflow row, else
 * the built-in definition. A pinned workflow always belongs to the task's
 * project, so loading the workflow rows of the queried projects covers every
 * task the outer query can match.
 */

import type { Prisma } from "@prisma/client";
import {
  defaultWorkflowDefinition,
  FIRST_DEFAULT_ROW_ORDER,
  reviewStates,
  sanitizeStoredDefinition,
  terminalStates,
  type WorkflowDefinitionShape,
} from "./default-workflow.js";

export type WorkflowStateKind = "terminal" | "review";

type WorkflowReader = Pick<Prisma.TransactionClient, "workflow">;

export interface WorkflowRow {
  id: string;
  projectId: string;
  isDefault: boolean;
  definition: unknown;
}

function statesOfKind(def: WorkflowDefinitionShape, kind: WorkflowStateKind): string[] {
  return kind === "terminal" ? terminalStates(def) : reviewStates(def);
}

/**
 * The state names of `kind` in a stored definition. The fallback is per kind:
 * when the names of the asked `kind` cannot be read from the stored definition,
 * the built-in definition's names of that same kind are used, so the row
 * behaves as a built-in project for that kind instead of throwing (one broken
 * row must not take a whole team's poll down) or reading as "no terminal and no
 * review state". Which kinds are readable differs: terminal states need only
 * the `states` list, review-like states also need the `transitions` list. A
 * definition whose `states` is a list but whose `transitions` is not therefore
 * keeps its own terminal states and falls back to the built-in `review` for the
 * review kind. A definition whose `states` is not a list falls back for both
 * kinds (`done` for terminal, `review` for review).
 *
 * That fallback is fail-closed for each caller, and no weaker than the
 * literal `review` / `done` these filters used before:
 * - work-claim check (terminal, `notIn`): a claim on any task whose status is
 *   not `done` counts as active, so the single-claim rule can only
 *   over-block, never open;
 * - review pickup and review-claim check (review, `in`): the `review` branch
 *   stays in place, so the pool still offers `review` tasks and a review
 *   claim on one still counts, where an empty list would drop the branch and
 *   let an agent take a second claim;
 * - webhook lookups (terminal, `notIn`): `done` stays excluded, where an
 *   empty list would make a finished task bindable again.
 */
function safeStates(row: WorkflowRow, kind: WorkflowStateKind): string[] {
  try {
    const def = sanitizeStoredDefinition(row.definition, { workflowId: row.id, projectId: row.projectId });
    return [...new Set(statesOfKind(def, kind))].sort();
  } catch {
    return [...new Set(statesOfKind(defaultWorkflowDefinition(), kind))].sort();
  }
}

function statusCondition(match: "in" | "notIn", states: string[]): Prisma.TaskWhereInput {
  if (match === "in") return { status: { in: states } };
  return states.length > 0 ? { status: { notIn: states } } : {};
}

/**
 * A `where` fragment for tasks whose status is (`match: "in"`) or is not
 * (`match: "notIn"`) a state of `kind` in the task's OWN effective workflow.
 * Combine it with the caller's other conditions through `AND`.
 *
 * `scope` selects the workflow rows to read; pass the narrowest filter that
 * still covers every project the outer query can match (one project id, or
 * the caller's team). One read per call, however many tasks match.
 */
export async function taskStatusByWorkflow(
  db: WorkflowReader,
  opts: { kind: WorkflowStateKind; match: "in" | "notIn"; scope: Prisma.WorkflowWhereInput },
): Promise<Prisma.TaskWhereInput> {
  return buildTaskStatusFilter(await loadWorkflowRows(db, opts.scope), opts);
}

/**
 * The workflow rows `buildTaskStatusFilter` reads; load once and build several
 * filters from them. The rows come back oldest first (ties by id), so the first
 * default row of a project in the list is the one `resolveEffectiveDefinition`
 * and the claim repair pick: `buildTaskStatusFilter` and `isStatusOfKind` take
 * the first default row they meet and rely on this order.
 */
export function loadWorkflowRows(db: WorkflowReader, scope: Prisma.WorkflowWhereInput): Promise<WorkflowRow[]> {
  return db.workflow.findMany({
    where: scope,
    select: { id: true, projectId: true, isDefault: true, definition: true },
    orderBy: FIRST_DEFAULT_ROW_ORDER,
  });
}

export function buildTaskStatusFilter(
  rows: WorkflowRow[],
  opts: { kind: WorkflowStateKind; match: "in" | "notIn" },
): Prisma.TaskWhereInput {
  const pinned = new Map<string, { ids: string[]; states: string[] }>();
  const projectDefault = new Map<string, { projectIds: string[]; states: string[] }>();
  const projectsWithDefault = new Set<string>();

  for (const row of rows) {
    const states = safeStates(row, opts.kind);
    const key = JSON.stringify(states);
    const pin = pinned.get(key) ?? { ids: [], states };
    pin.ids.push(row.id);
    pinned.set(key, pin);

    // `resolveEffectiveDefinition` reads the first default row of a project
    // (the oldest, which is the first one in `rows`, see `loadWorkflowRows`); a
    // second one is ignored here as well.
    if (row.isDefault && !projectsWithDefault.has(row.projectId)) {
      projectsWithDefault.add(row.projectId);
      const grp = projectDefault.get(key) ?? { projectIds: [], states };
      grp.projectIds.push(row.projectId);
      projectDefault.set(key, grp);
    }
  }

  const branches: Prisma.TaskWhereInput[] = [];
  const keep = (states: string[]) => opts.match === "notIn" || states.length > 0;

  for (const { ids, states } of pinned.values()) {
    if (keep(states)) branches.push({ workflowId: { in: ids }, ...statusCondition(opts.match, states) });
  }
  for (const { projectIds, states } of projectDefault.values()) {
    if (keep(states)) {
      branches.push({
        workflowId: null,
        projectId: { in: projectIds },
        ...statusCondition(opts.match, states),
      });
    }
  }
  // Tasks without a pinned workflow in a project that has no default row
  // resolve to the built-in definition.
  const builtin = statesOfKind(defaultWorkflowDefinition(), opts.kind).sort();
  if (keep(builtin)) {
    branches.push({
      workflowId: null,
      ...(projectsWithDefault.size > 0 ? { projectId: { notIn: [...projectsWithDefault] } } : {}),
      ...statusCondition(opts.match, builtin),
    });
  }

  // The built-in branch is always present for `notIn`, and the built-in
  // workflow has a review state, so `branches` is never empty.
  return { OR: branches };
}

function builtinStates(kind: WorkflowStateKind): string[] {
  return [...new Set(statesOfKind(defaultWorkflowDefinition(), kind))].sort();
}

/**
 * Whether `task.status` is a state of `kind` in the task's OWN effective
 * workflow, judged in code from rows loaded with `loadWorkflowRows`. It
 * resolves the workflow the way the `where` builders do (the pinned row, else
 * the first default row of the task's project, else the built-in states) and
 * reads the states with the same per-kind fallback. For callers that already
 * hold a handful of task rows and must not issue one definition lookup per
 * task.
 */
export function isStatusOfKind(
  rows: WorkflowRow[],
  task: { workflowId: string | null; projectId: string; status: string },
  kind: WorkflowStateKind,
): boolean {
  const pinned = task.workflowId ? rows.find((r) => r.id === task.workflowId) : undefined;
  const row = pinned ?? rows.find((r) => r.isDefault && r.projectId === task.projectId);
  return (row ? safeStates(row, kind) : builtinStates(kind)).includes(task.status);
}

export interface ActiveClaim {
  id: string;
  title: string;
  claimedByAgentId: string | null;
  reviewClaimedByAgentId: string | null;
}

/**
 * The task on which `agentId` holds an active claim, or null: a work claim on
 * a task that is not in a terminal state of its own workflow, or a review
 * claim on a task that is in a review-like state of its own workflow. The
 * workflow rows of the projects where the agent holds a claim are read once
 * and shared by both conditions.
 */
export async function findActiveAgentClaim(
  db: Pick<Prisma.TransactionClient, "task" | "workflow">,
  agentId: string,
  opts: { excludeTaskId?: string } = {},
): Promise<ActiveClaim | null> {
  const claimed: Prisma.TaskWhereInput[] = [{ claimedByAgentId: agentId }, { reviewClaimedByAgentId: agentId }];
  const rows = await loadWorkflowRows(db, { project: { tasks: { some: { OR: claimed } } } });
  const notTerminal = buildTaskStatusFilter(rows, { kind: "terminal", match: "notIn" });
  const inReview = buildTaskStatusFilter(rows, { kind: "review", match: "in" });
  return db.task.findFirst({
    where: {
      ...(opts.excludeTaskId ? { id: { not: opts.excludeTaskId } } : {}),
      OR: [
        { claimedByAgentId: agentId, AND: [notTerminal] },
        { reviewClaimedByAgentId: agentId, AND: [inReview] },
      ],
    },
    select: { id: true, title: true, claimedByAgentId: true, reviewClaimedByAgentId: true },
  });
}
