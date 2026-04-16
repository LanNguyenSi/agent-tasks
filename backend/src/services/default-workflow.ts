/**
 * Built-in default workflow applied to tasks that have no explicit Workflow
 * row. This is the system-wide baseline: every project that hasn't defined
 * its own workflow inherits these transitions and their `requires` gates.
 *
 * Teams that want different rules (e.g. a docs-only project that legitimately
 * has no branches) can create a custom Workflow and override per-transition.
 * That escape hatch is why the defaults live in code, not in a migration.
 *
 * Shape matches workflow.definition.transitions so a single evaluator in
 * tasks.ts can handle both the custom-workflow and no-workflow paths.
 */

export interface DefaultTransition {
  to: string;
  label: string;
  requires?: string[];
}

/** States that ship with the default workflow. Kept in a single place so
 * the customize endpoint can copy them verbatim into a new Workflow row.
 *
 * `agentInstructions` are the per-state prompts surfaced to agents via
 * `GET /tasks/:id/instructions`. They match the prose from the previous
 * legacy editor (pre-#110) so agents that relied on them keep working
 * after customize. Customizing a workflow copies these verbatim — admins
 * can then edit each state's instructions in the UI.
 */
export const DEFAULT_STATES: readonly {
  name: string;
  label: string;
  terminal: boolean;
  agentInstructions: string;
}[] = [
  {
    name: "open",
    label: "Open",
    terminal: false,
    agentInstructions:
      "Claim this task, create a branch, then transition to in_progress.",
  },
  {
    name: "in_progress",
    label: "In progress",
    terminal: false,
    agentInstructions:
      "Implement the changes. When done, push the branch, create a PR, update prUrl and branchName, then transition to review.",
  },
  {
    name: "review",
    label: "In review",
    terminal: false,
    agentInstructions:
      "Review is a code-review state. Approve or request changes here. Merge, deploy, and production verification are external follow-up actions unless your project defines a custom workflow for them.",
  },
  {
    name: "done",
    label: "Done",
    terminal: true,
    agentInstructions:
      "Task is complete. Merge, deploy, and production verification are operational follow-ups outside the modeled task states unless a custom workflow models them explicitly.",
  },
] as const;

export const DEFAULT_INITIAL_STATE = "open";

export const DEFAULT_TRANSITIONS: Record<string, DefaultTransition[]> = {
  open: [
    // Starting work does not require a branch. Exploratory work (scoping,
    // prototyping, reading code) is legitimate before the agent decides
    // where to put the PR, and `task_submit_pr` (the v2-native path for
    // writing branchName) requires the task to already be `in_progress`.
    // Keeping `branchPresent` on this edge would self-checkmate the
    // default workflow once `task_start` enforces gates. See ticket
    // 10c11d76-72f5-4987-ab59-db579e316823 for the full rationale.
    //
    // `branchPresent` still applies on `in_progress → review` and
    // `→ done` below, where it is load-bearing: you cannot submit work
    // for review without a branch to review.
    { to: "in_progress", label: "Start" },
  ],
  in_progress: [
    // "Submit for review" without an actual PR produces an empty review
    // request. Require both branch and PR.
    { to: "review", label: "Submit for review", requires: ["branchPresent", "prPresent"] },
    // Mark done directly (skip review). Still requires branch + PR so the
    // audit trail has something to reference.
    { to: "done", label: "Mark done", requires: ["branchPresent", "prPresent"] },
    // Release the task back to open — always allowed, no artifact needed.
    { to: "open", label: "Release" },
  ],
  review: [
    // Approve: no extra gate (reviewer already saw the PR).
    { to: "done", label: "Approve" },
    // Request changes: always allowed.
    { to: "in_progress", label: "Request changes" },
  ],
  done: [],
};

/**
 * Look up the default transition definition for a given (from, to) pair.
 * Returns `undefined` if the transition is not part of the default workflow.
 */
export function findDefaultTransition(
  from: string,
  to: string,
): DefaultTransition | undefined {
  return DEFAULT_TRANSITIONS[from]?.find((t) => t.to === to);
}

export interface WorkflowDefinitionShape {
  states: { name: string; label: string; terminal: boolean; agentInstructions?: string }[];
  transitions: {
    from: string;
    to: string;
    label?: string;
    requiredRole?: string;
    requires?: string[];
  }[];
  initialState: string;
}

/**
 * Serialize the hardcoded default into the same shape as
 * `Workflow.definition`. The customize endpoint uses this to seed a new
 * Workflow row; the effective-workflow endpoint uses it to return a
 * consistent shape whether a custom row exists or not.
 */
export function defaultWorkflowDefinition(): WorkflowDefinitionShape {
  const transitions: WorkflowDefinitionShape["transitions"] = [];
  for (const [from, list] of Object.entries(DEFAULT_TRANSITIONS)) {
    for (const t of list) {
      transitions.push({
        from,
        to: t.to,
        label: t.label,
        requiredRole: "any",
        ...(t.requires ? { requires: t.requires } : {}),
      });
    }
  }
  return {
    states: DEFAULT_STATES.map((s) => ({ ...s })),
    transitions,
    initialState: DEFAULT_INITIAL_STATE,
  };
}

/**
 * Resolve which state `task_finish` should target for a task currently in
 * `in_progress`. Used by the v2 MCP surface so agents know up-front whether
 * their finish will go to `review` or straight to `done`.
 *
 * Inspects the provided workflow definition (or the built-in default) for
 * transitions originating from `in_progress` and prefers a `review` target
 * over `done`. If the workflow has neither, falls back to `done` — that is
 * the hardcoded final fallback defined in ADR 0008.
 */
/**
 * Resolve the effective workflow definition for a task following the
 * ADR-0008 §50-56 resolution chain:
 *   1. task.workflowId → that Workflow row's definition
 *   2. project-default Workflow row (isDefault: true)
 *   3. built-in defaultWorkflowDefinition()
 */
export async function resolveEffectiveDefinition(
  task: { workflowId: string | null; workflow?: { definition: unknown } | null; projectId: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaClient: { workflow: { findFirst: (...args: any[]) => Promise<{ definition: unknown } | null> } },
): Promise<WorkflowDefinitionShape> {
  if (task.workflowId && task.workflow) {
    return task.workflow.definition as unknown as WorkflowDefinitionShape;
  }
  const projectDefault = await prismaClient.workflow.findFirst({
    where: { projectId: task.projectId, isDefault: true },
  });
  return projectDefault
    ? (projectDefault.definition as unknown as WorkflowDefinitionShape)
    : defaultWorkflowDefinition();
}

export function expectedFinishStateFromDefinition(
  definition: WorkflowDefinitionShape | null,
): "review" | "done" {
  const transitions = definition?.transitions ?? defaultWorkflowDefinition().transitions;
  const fromInProgress = transitions.filter((t) => t.from === "in_progress");
  if (fromInProgress.some((t) => t.to === "review")) return "review";
  if (fromInProgress.some((t) => t.to === "done")) return "done";
  return "done";
}
