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

import { logger } from "../lib/logger.js";

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
 * `backlog` is not a workflow state. A task enters it at creation (agent
 * task creation is routed there) or by the human demote verb, and leaves it
 * only by the human promote or discard verb, which the PATCH handler writes
 * directly; never through a workflow edge or a workflow's initial state.
 * `workflowDefinitionSchema` (routes/workflows.ts) rejects any such
 * definition on save, but definitions stored before that lock can still
 * carry one (the retired coding-agent template: initialState backlog and
 * edges such as spec -> backlog). Read as stored, they let
 * POST /tasks/:id/transition, the claim-abandon and release routes and the
 * grounding direct writers move a task into or out of backlog.
 *
 * This is the one place the stored shape is made safe, applied on every
 * read of a stored definition. Edges into backlog and a backlog state are
 * dropped. When the stored initialState is backlog (the legacy shape, where
 * "open" takes backlog's place as the entry state), the initialState becomes
 * "open" and an "open" state is added when the definition lacks one. Edges
 * out of backlog are dropped, with one exception: in the legacy shape, an
 * edge out of backlog whose target is neither a terminal state nor a review
 * state (the legacy start edge, such as backlog -> spec) is remapped to leave
 * from "open". Any other edge out of backlog (such as backlog -> done or
 * backlog -> review), and every edge out of backlog when the stored
 * initialState is anything else, is dropped.
 *
 * The invariant: an open task can never reach a terminal or review state
 * through a remapped edge; the only path the sanitizer adds is the legacy
 * start edge from open to a non-terminal, non-review state. A definition
 * that does not mention backlog is returned untouched (same object), so
 * valid workflows behave exactly as before. The stored row is never
 * rewritten.
 */
export const BACKLOG_STATE = "backlog";
const SANITIZED_INITIAL_STATE = "open";

function mentionsBacklog(def: WorkflowDefinitionShape): boolean {
  return (
    def.initialState === BACKLOG_STATE ||
    (Array.isArray(def.states) && def.states.some((s) => s.name === BACKLOG_STATE)) ||
    (Array.isArray(def.transitions) &&
      def.transitions.some((t) => t.from === BACKLOG_STATE || t.to === BACKLOG_STATE))
  );
}

/**
 * Edges into backlog are dropped. Edges out of backlog are dropped too,
 * except when `remapOutOfBacklog` is set (the stored initialState is
 * backlog): then an edge whose target is neither terminal nor review is
 * remapped to leave from "open". Terminal and review are the repo's own
 * predicates (isTerminalState, isReviewState), judged on the sanitized
 * definition before any remap: initial state "open", the states without
 * backlog, and only the edges that touch backlog at neither end. Judged on
 * the stored definition (initial state backlog) or after the remap (initial
 * state open), every target of an edge from the initial state fails
 * isReviewState's "not a direct target of the initial state" clause, so a
 * review target would never be recognised. When the states are not a list,
 * no target can be judged and nothing is remapped. A remapped edge keeps
 * label, requires, requiredRole and every other field. One that would
 * duplicate an edge from "open" to the same target (an existing one, or an
 * earlier remapped one) is skipped, as is one that would become a self loop.
 */
function sanitizeBacklogEdges(
  transitions: WorkflowDefinitionShape["transitions"],
  remapOutOfBacklog: boolean,
  states: unknown,
): WorkflowDefinitionShape["transitions"] {
  const judge: WorkflowDefinitionShape | null = Array.isArray(states)
    ? {
        initialState: SANITIZED_INITIAL_STATE,
        states: states as WorkflowDefinitionShape["states"],
        transitions: transitions.filter((t) => t.from !== BACKLOG_STATE && t.to !== BACKLOG_STATE),
      }
    : null;
  const taken = new Set(
    transitions.filter((t) => t.from === SANITIZED_INITIAL_STATE && t.to !== BACKLOG_STATE).map((t) => t.to),
  );
  const out: WorkflowDefinitionShape["transitions"] = [];
  for (const t of transitions) {
    if (t.to === BACKLOG_STATE) continue;
    if (t.from !== BACKLOG_STATE) {
      out.push(t);
      continue;
    }
    if (!remapOutOfBacklog) continue;
    if (judge === null) continue;
    if (isTerminalState(judge, t.to)) continue;
    if (isReviewState(judge, t.to)) continue;
    if (t.to === SANITIZED_INITIAL_STATE || taken.has(t.to)) continue;
    taken.add(t.to);
    out.push({ ...t, from: SANITIZED_INITIAL_STATE });
  }
  return out;
}

export function sanitizeStoredDefinition(
  stored: unknown,
  source?: { workflowId?: string | null; projectId?: string },
): WorkflowDefinitionShape {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return stored as WorkflowDefinitionShape;
  }
  const def = stored as WorkflowDefinitionShape;
  if (!mentionsBacklog(def)) return def;

  const legacyInitial = def.initialState === BACKLOG_STATE;
  const states = Array.isArray(def.states) ? def.states.filter((s) => s.name !== BACKLOG_STATE) : def.states;
  const initialState = legacyInitial ? SANITIZED_INITIAL_STATE : def.initialState;
  const transitions = Array.isArray(def.transitions)
    ? sanitizeBacklogEdges(def.transitions, legacyInitial, states)
    : def.transitions;
  // Only the legacy shape gets an "open" state: its initial state and its
  // remapped edges name it. Any other definition keeps its own states.
  const sanitized: WorkflowDefinitionShape = {
    ...def,
    initialState,
    states:
      Array.isArray(states) && legacyInitial && !states.some((s) => s.name === SANITIZED_INITIAL_STATE)
        ? [...states, { name: SANITIZED_INITIAL_STATE, label: "Open", terminal: false }]
        : states,
    transitions,
  };
  logger.warn(
    { component: "workflow", op: "sanitizeStoredDefinition", ...source },
    "stored workflow definition references backlog; edges into backlog and the backlog state were dropped; when the initial state was backlog (now open), an edge out of backlog to a non-terminal, non-review state leaves from open; every other edge out of backlog was dropped (backlog is left only by promote and discard)",
  );
  return sanitized;
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
    return sanitizeStoredDefinition(task.workflow.definition, {
      workflowId: task.workflowId,
      projectId: task.projectId,
    });
  }
  const projectDefault = await prismaClient.workflow.findFirst({
    where: { projectId: task.projectId, isDefault: true },
  });
  return projectDefault
    ? sanitizeStoredDefinition(projectDefault.definition, { projectId: task.projectId })
    : defaultWorkflowDefinition();
}

/**
 * Whether `task` currently sits in a review-like state of ITS effective
 * workflow (task-pinned, else project default, else built-in), judged by the
 * same `isReviewState` predicate the release/transition gates use. Task rows
 * fetched without the `workflow` relation (the serialised task include) get
 * their pinned workflow loaded here, so a pinned task is never judged on the
 * project default.
 */
export async function isTaskInReviewState(
  task: { status: string; workflowId: string | null; workflow?: { definition: unknown } | null; projectId: string },
  prismaClient: {
    workflow: {
      findFirst: (...args: any[]) => Promise<{ definition: unknown } | null>; // eslint-disable-line @typescript-eslint/no-explicit-any
      findUnique: (...args: any[]) => Promise<{ definition: unknown } | null>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
  },
): Promise<boolean> {
  const workflow =
    task.workflow ??
    (task.workflowId ? await prismaClient.workflow.findUnique({ where: { id: task.workflowId } }) : null);
  const def = await resolveEffectiveDefinition({ ...task, workflow }, prismaClient);
  return isReviewState(def, task.status);
}

/** Adds the server-computed `inReviewState` flag to a task payload. */
export async function withInReviewState<
  T extends { status: string; workflowId: string | null; workflow?: { definition: unknown } | null; projectId: string },
>(
  task: T,
  prismaClient: Parameters<typeof isTaskInReviewState>[1],
): Promise<T & { inReviewState: boolean }> {
  return { ...task, inReviewState: await isTaskInReviewState(task, prismaClient) };
}

// ── Workflow state semantic helpers ──────────────────────────────────────────
//
// These derive semantic roles (initial, terminal, review, work) from any
// WorkflowDefinitionShape, replacing hardcoded state-name checks throughout
// the v2 verb handlers. See the plan at plans/shimmering-stargazing-boot.md.

export function isInitialState(def: WorkflowDefinitionShape, stateName: string): boolean {
  return def.initialState === stateName;
}

export function isTerminalState(def: WorkflowDefinitionShape, stateName: string): boolean {
  return def.states.find((s) => s.name === stateName)?.terminal === true;
}

/**
 * A state is "review-like" if it:
 *   1. Is not the initial state
 *   2. Is not terminal
 *   3. Has at least one transition to a terminal state
 *   4. Is NOT a direct transition target of the initial state
 *
 * For the default workflow: "review" qualifies (review→done, open does NOT →review).
 * For coding-agent: "review" qualifies (review→done, backlog does NOT →review).
 */
export function isReviewState(def: WorkflowDefinitionShape, stateName: string): boolean {
  if (isInitialState(def, stateName) || isTerminalState(def, stateName)) return false;
  const hasTransitionToTerminal = def.transitions.some(
    (t) => t.from === stateName && isTerminalState(def, t.to),
  );
  if (!hasTransitionToTerminal) return false;
  const isDirectFromInitial = def.transitions.some(
    (t) => t.from === def.initialState && t.to === stateName,
  );
  return !isDirectFromInitial;
}

/** Non-initial, non-terminal state (any "work" state including review). */
export function isWorkState(def: WorkflowDefinitionShape, stateName: string): boolean {
  return !isInitialState(def, stateName) && !isTerminalState(def, stateName);
}

/** First transition target from a given state. */
export function firstTransitionTarget(def: WorkflowDefinitionShape, fromState: string): string | undefined {
  return def.transitions.find((t) => t.from === fromState)?.to;
}

/** All terminal state names. */
export function terminalStates(def: WorkflowDefinitionShape): string[] {
  return def.states.filter((s) => s.terminal).map((s) => s.name);
}

/** All review-like state names. */
export function reviewStates(def: WorkflowDefinitionShape): string[] {
  return def.states.filter((s) => isReviewState(def, s.name)).map((s) => s.name);
}

/**
 * Find the transition target for a review-finish "approve" outcome:
 * the first transition from `fromState` to a terminal state.
 */
export function approveTarget(def: WorkflowDefinitionShape, fromState: string): string | undefined {
  return def.transitions.find(
    (t) => t.from === fromState && isTerminalState(def, t.to),
  )?.to;
}

/**
 * Find the transition target for a review-finish "request_changes" outcome:
 * the first transition from `fromState` to a non-terminal, non-review state.
 */
export function requestChangesTarget(def: WorkflowDefinitionShape, fromState: string): string | undefined {
  return def.transitions.find(
    (t) => t.from === fromState && !isTerminalState(def, t.to) && !isReviewState(def, t.to),
  )?.to;
}

/**
 * Gates ("requires") configured on the edge between two states in the given
 * effective definition. Mirrors the lookup `evaluateV2TransitionGates`
 * performs at finish-time (`routes/tasks.ts`), so a caller can preview the
 * gates a later finish call will enforce without duplicating that logic.
 *
 * Returns an empty array both when the transition exists with no `requires`
 * and when no such transition is defined — callers that only want "what
 * must I satisfy" don't need to distinguish the two.
 */
export function gatesForTransition(
  def: WorkflowDefinitionShape,
  from: string,
  to: string,
): string[] {
  return def.transitions.find((t) => t.from === from && t.to === to)?.requires ?? [];
}

/**
 * Resolve which state `task_finish` should target for a work-claim finish.
 *
 * Inspects transitions from the given state (or the definition overall)
 * and prefers a review-like target over a terminal one. Falls back to
 * the first terminal state if no review state is reachable.
 */
export function expectedFinishStateFromDefinition(
  definition: WorkflowDefinitionShape | null,
): string {
  const def = definition ?? defaultWorkflowDefinition();
  // Find a review state reachable from ANY non-initial, non-terminal state
  const revStates = reviewStates(def);
  if (revStates.length > 0) return revStates[0]!;
  // No review state → finish goes to terminal directly
  const terms = terminalStates(def);
  return terms[0] ?? "done";
}

/**
 * Project-level workflow resolution (no task object needed).
 * Used by task creation where only projectId is known.
 */
export async function resolveProjectEffectiveDefinition(
  projectId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prismaClient: { workflow: { findFirst: (...args: any[]) => Promise<{ definition: unknown } | null> } },
): Promise<WorkflowDefinitionShape> {
  const projectDefault = await prismaClient.workflow.findFirst({
    where: { projectId, isDefault: true },
  });
  return projectDefault
    ? sanitizeStoredDefinition(projectDefault.definition, { projectId })
    : defaultWorkflowDefinition();
}
