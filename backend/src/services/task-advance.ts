/**
 * The rules of `task_advance` (POST /tasks/:id/advance) that both of its
 * handlers apply: the REST handler in routes/tasks.ts for an unprovisioned
 * task, and the Grounding direct route (routes/grounding-direct-tasks.ts) for
 * a Grounding-provisioned one, which runs `decideAdvance` once on its unlocked
 * read and again under the task lock (grounding-route-effects.ts). One source
 * keeps the two answers identical: the same body schema, the same work-claim
 * refusal, the same advance error codes with their `choices`, and the same
 * preview in the response.
 */
import { z } from "zod";
import type { Actor } from "../types/auth.js";
import {
  advanceTargetsFrom,
  gatesForTransition,
  isReviewState,
  isTerminalState,
  isWorkState,
  reachableFinishTarget,
  resolveAdvanceTarget,
  type WorkflowDefinitionShape,
} from "./default-workflow.js";
import { GroundingAccessError } from "./grounding-context.js";

/** Body of POST /tasks/:id/advance: an optional work stage to move to. */
export const advanceTaskSchema = z.object({
  to: z
    .string()
    .min(1)
    .max(64, "to must be at most 64 characters")
    .regex(/^[a-z0-9_]+$/, "to is a workflow state name: lowercase letters, digits and underscores")
    .optional(),
});

/**
 * The message of the Grounding direct route's 409 precondition_failed for an
 * advance. That refusal does not say which rule failed (the REST handler's
 * 422 lists them in `failed`), so the message names the edge and the gates
 * configured on it.
 */
export function advanceGateRefusalMessage(def: WorkflowDefinitionShape, from: string, to: string): string {
  const gates = gatesForTransition(def, from, to);
  return `Transition blocked: a workflow gate on ${from} -> ${to} is not met${gates.length > 0 ? ` (this edge requires ${gates.join(", ")})` : ""}`;
}

/**
 * Preview the gates configured on a transition edge, distinguishing "edge
 * exists with no `requires`" ([]) from "edge does not exist" (null).
 *
 * `gatesForTransition` alone collapses both cases to []: fine for its
 * original finish-time lookup (a missing edge already 400s with
 * `no_transition` before the gate list matters there), but wrong for a
 * preview: a workflow that keeps `review → done` while dropping
 * `in_progress → review` is persistable (workflowDefinitionSchema doesn't
 * require graph connectivity), and `finish: []` would misread as "nothing
 * required" when finish will actually 400. `to` is optional so callers can
 * feed an `approveTarget`/`requestChangesTarget` result straight through
 * without a separate undefined-check.
 */
export function gatesForTransitionOrNull(
  def: WorkflowDefinitionShape,
  from: string,
  to: string | undefined,
): string[] | null {
  if (to === undefined) return null;
  const exists = def.transitions.some((t) => t.from === from && t.to === to);
  return exists ? gatesForTransition(def, from, to) : null;
}

/**
 * What a work-claim holder can do next from `state`, for the `task_start` and
 * `task_advance` responses: the state a work `task_finish` (without autoMerge)
 * moves the task to, null when that finish would be refused for lack of an
 * edge; the gates configured on that edge, null likewise; and the states
 * `task_advance` can take the task to.
 */
export function workStagePreview(def: WorkflowDefinitionShape, state: string): {
  expectedFinishState: string | null;
  finishGates: string[] | null;
  advanceTargets: string[];
} {
  const expectedFinishState = reachableFinishTarget(def, state);
  return {
    expectedFinishState,
    finishGates: gatesForTransitionOrNull(def, state, expectedFinishState ?? undefined),
    advanceTargets: advanceTargetsFrom(def, state),
  };
}

/** The advance response fields that describe the move, without the task itself. */
export function advanceResponseFields(def: WorkflowDefinitionShape, previousStatus: string, targetStatus: string) {
  const preview = workStagePreview(def, targetStatus);
  return {
    kind: "work" as const,
    previousStatus,
    targetStatus,
    // The same preview task_start returns, from the stage just reached.
    expectedFinishState: preview.expectedFinishState,
    effectiveGates: { finish: preview.finishGates },
    advanceTargets: preview.advanceTargets,
  };
}

export const ADVANCE_WORK_CLAIM_REFUSAL =
  "You do not hold the work claim on this task. Call task_start to claim it before task_advance; a review claim does not advance a task.";

export type AdvanceRefusalBody = { error: string; message: string } & Record<string, unknown>;
export type AdvanceDecision =
  | { ok: true; to: string }
  | { ok: false; status: 403 | 409; body: AdvanceRefusalBody };

const quoteList = (states: string[]) => states.map((s) => `'${s}'`).join(", ");

/**
 * Decide an advance of `task` by `actor` on `def`: the caller must hold the
 * work claim (a review claim does not count), the task must sit in a work
 * state that is not review-like, and `requested` (or, without it, the single
 * forward edge) must be a forward edge to another work stage. A review-like
 * or terminal target is refused with `advance_use_finish`: those moves are
 * task_finish's, so an advance never reaches a review or terminal state.
 */
export function decideAdvance(
  def: WorkflowDefinitionShape,
  task: { status: string; claimedByUserId: string | null; claimedByAgentId: string | null },
  actor: Actor,
  requested: string | undefined,
): AdvanceDecision {
  const holdsWorkClaim =
    (actor.type === "human" && task.claimedByUserId === actor.userId) ||
    (actor.type === "agent" && task.claimedByAgentId === actor.tokenId);
  if (!holdsWorkClaim) {
    return { ok: false, status: 403, body: { error: "forbidden", message: ADVANCE_WORK_CLAIM_REFUSAL } };
  }

  const from = task.status;
  if (!isWorkState(def, from)) {
    return {
      ok: false,
      status: 409,
      body: { error: "bad_state", message: `task_advance requires a work state (non-initial, non-terminal), got '${from}'` },
    };
  }
  if (isReviewState(def, from)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "advance_use_finish",
        message: `Task is in the review state '${from}'. task_advance moves a task between work stages only; the review is decided with task_finish and an outcome.`,
        from,
        finishTarget: null,
        choices: [],
      },
    };
  }

  const resolution = resolveAdvanceTarget(def, from, requested);
  if (resolution.ok) return { ok: true, to: resolution.to };
  const { choices } = resolution;
  const choicesHint = choices.length > 0 ? ` task_advance can move it to ${quoteList(choices)}.` : "";
  if (resolution.reason === "finish_state") {
    const subject =
      resolution.requested !== null
        ? `'${resolution.requested}' is a ${isTerminalState(def, resolution.requested) ? "terminal" : "review"} state, which task_advance never moves a task into.`
        : `'${from}' has no forward edge to another work stage.`;
    const finishHint =
      resolution.finishTarget !== null
        ? ` Call task_finish, which moves the task from '${from}' to '${resolution.finishTarget}'.`
        : ` task_finish has no edge from '${from}' either.`;
    return {
      ok: false,
      status: 409,
      body: {
        error: "advance_use_finish",
        message: `${subject}${finishHint}${choicesHint}`,
        from,
        ...(resolution.requested !== null ? { requested: resolution.requested } : {}),
        finishTarget: resolution.finishTarget,
        choices,
      },
    };
  }
  if (resolution.reason === "ambiguous") {
    return {
      ok: false,
      status: 409,
      body: {
        error: "advance_ambiguous",
        message: `'${from}' has ${choices.length} forward edges to work stages (${quoteList(choices)}). Call task_advance again with to set to one of them.`,
        from,
        choices,
      },
    };
  }
  if (resolution.reason === "not_forward") {
    return {
      ok: false,
      status: 409,
      body: {
        error: "advance_target_invalid",
        message: `'${resolution.requested}' is not a forward edge from '${from}' to a work stage.${choicesHint || ` '${from}' has no forward edge to another work stage.`}`,
        from,
        requested: resolution.requested,
        choices,
      },
    };
  }
  return {
    ok: false,
    status: 409,
    body: {
      error: "advance_no_forward_edge",
      message: `'${from}' has no forward edge to another work stage, and task_finish has no edge from it either.`,
      from,
      choices,
    },
  };
}

/**
 * An advance refused by `decideAdvance` inside a Grounding transaction. It is a
 * GroundingAccessError so the transaction rethrows it unchanged, and the
 * direct route answers its `body` as the REST handler would.
 */
export class GroundingAdvanceRefused extends GroundingAccessError {
  constructor(readonly refusal: { status: 403 | 409; body: AdvanceRefusalBody }) {
    super(refusal.status === 403 ? "forbidden" : "bad_state", refusal.status, refusal.body.message);
  }
}
