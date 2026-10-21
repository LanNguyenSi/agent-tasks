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
  reviewStates,
  sanitizeStoredDefinition,
  terminalStates,
  type WorkflowDefinitionShape,
} from "./default-workflow.js";

export type WorkflowStateKind = "terminal" | "review";

type WorkflowReader = Pick<Prisma.TransactionClient, "workflow">;

interface WorkflowRow {
  id: string;
  projectId: string;
  isDefault: boolean;
  definition: unknown;
}

function statesOfKind(def: WorkflowDefinitionShape, kind: WorkflowStateKind): string[] {
  return kind === "terminal" ? terminalStates(def) : reviewStates(def);
}

/**
 * The state names of `kind` in a stored definition. A definition that cannot
 * be read (states or transitions not a list) yields no states instead of
 * throwing, so one broken row cannot take a whole team's poll down; it then
 * reads as "no terminal and no review state".
 */
function safeStates(row: WorkflowRow, kind: WorkflowStateKind): string[] {
  try {
    const def = sanitizeStoredDefinition(row.definition, { workflowId: row.id, projectId: row.projectId });
    return [...new Set(statesOfKind(def, kind))].sort();
  } catch {
    return [];
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

function loadWorkflowRows(db: WorkflowReader, scope: Prisma.WorkflowWhereInput): Promise<WorkflowRow[]> {
  return db.workflow.findMany({
    where: scope,
    select: { id: true, projectId: true, isDefault: true, definition: true },
  });
}

function buildTaskStatusFilter(
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

    // `resolveEffectiveDefinition` reads the first default row of a project;
    // a second one is ignored here as well.
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
