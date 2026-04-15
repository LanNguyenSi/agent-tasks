import { z, ZodRawShape } from "zod";
import { AgentTasksClient, AgentTasksApiError } from "./client.js";

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  inputShape: Shape;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>;
}

const transitionStatusEnum = z.enum([
  "open",
  "in_progress",
  "review",
  "done",
]);
const priorityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

const uuid = () => z.string().uuid();

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AgentTasksApiError) {
      const detail = err.body
        ? ` — ${typeof err.body === "string" ? err.body : JSON.stringify(err.body)}`
        : "";
      throw new Error(`agent-tasks API ${err.status}: ${err.message}${detail}`);
    }
    throw err;
  }
}

function def<Shape extends ZodRawShape>(
  d: ToolDefinition<Shape>,
): ToolDefinition {
  return d as unknown as ToolDefinition;
}

// ── v1 deprecation notice ────────────────────────────────────────────────────
//
// The v1 tools below are being phased out in favor of the v2 verb-oriented
// surface (task_pickup / task_start / task_note / task_finish / task_create /
// task_abandon). LLM clients that see both should prefer the non-deprecated
// variant. v1 tools will be removed 4 weeks after the v2 release. See ADR 0008.
const DEPRECATED = "[DEPRECATED, use v2 tools] ";

export function buildTools(client: AgentTasksClient): ToolDefinition[] {
  return [
    // ── v2 surface (ADR 0008) ────────────────────────────────────────────
    def({
      name: "task_pickup",
      description:
        "Get the next piece of work. Returns one of: a pending signal, a task ready for review, a claimable task, or idle. The response is tagged with `kind: \"signal\" | \"review\" | \"work\" | \"idle\"`. Signals are delivered at-most-once and acked atomically. Review tasks are filtered by the distinct-reviewer rule (you cannot review tasks you authored). Fails with 409 if you already hold an active claim — call task_finish or task_abandon first.",
      inputShape: {},
      handler: async () => wrap(() => client.pickupWork()),
    }),
    def({
      name: "task_start",
      description:
        "Begin work on a task. Polymorphic by task status: an `open` task is author-claimed and transitioned to in_progress; a `review` task is review-claimed without state change. Response includes the task data, project info, and `expectedFinishState` (the state task_finish will target for a work claim). Fails with 409 if you already hold an active claim.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.startTask(taskId)),
    }),
    def({
      name: "task_note",
      description:
        "Comment on a task. Works for both work and review claims — use this to record progress, ask questions, or leave review feedback. Requires taskId today; a future revision may infer it from the active claim.",
      inputShape: {
        taskId: uuid(),
        content: z.string().min(1).max(5000),
      },
      handler: async ({ taskId, content }) =>
        wrap(() => client.addTaskComment(taskId, content)),
    }),
    def({
      name: "task_finish",
      description:
        "Finish a task. Polymorphic based on the claim you hold.\n\nWork claim: pass { result?, prUrl? }. prUrl must be a github.com pull-request URL if provided. The task transitions to its expectedFinishState (review or done depending on the workflow). The work claim is cleared when going to done and kept when going to review.\n\nReview claim: pass { result?, outcome: \"approve\" | \"request_changes\" }. approve → task to done, both claims cleared. request_changes → task back to in_progress, review claim cleared, work claim kept so the author resumes, changes_requested signal emitted.\n\nTransitions may be blocked by workflow gates (branchPresent, prPresent, ciGreen, prMerged). A 422 `precondition_failed` response lists the failing rules. If `branchPresent` fails, the branch must be recorded on the task before retrying; during the v1 deprecation window, use v1 `tasks_update { branchName }` — the v2-native `task_submit_pr` verb lands with ADR-0009.",
      inputShape: {
        taskId: uuid(),
        result: z.string().max(5000).optional(),
        prUrl: z.string().url().optional(),
        outcome: z.enum(["approve", "request_changes"]).optional(),
      },
      handler: async ({ taskId, ...body }) =>
        wrap(() => client.finishTask(taskId, body)),
    }),
    def({
      name: "task_create",
      description:
        "Create a new task in a project. Only title is required. Use externalRef as an idempotency key for bulk imports — the backend dedupes on (projectId, externalRef).",
      inputShape: {
        projectId: uuid(),
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        priority: priorityEnum.optional(),
        workflowId: uuid().optional(),
        dueAt: z.string().datetime().optional(),
        externalRef: z.string().trim().min(1).max(255).optional(),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      },
      handler: async ({ projectId, ...input }) =>
        wrap(() => client.createTask(projectId, input)),
    }),
    def({
      name: "task_abandon",
      description:
        "Explicit bail-out: release the active claim on a task without finishing. A work claim on an in_progress task returns it to open; a review claim simply releases the review lock. Use this sparingly — task_finish is the normal path. Separate intent from finish so audit trails distinguish abandonment from completion.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.abandonTask(taskId)),
    }),
    def({
      name: "task_submit_pr",
      description:
        "Record the branch + pull request metadata on a work-claimed task. Atomic metadata write, not a state transition. Use this after `gh pr create` to satisfy the `branchPresent` / `prPresent` workflow gates before calling task_finish. The canonical v2 flow for projects that enforce branch gates is: task_start → (work + gh pr create) → task_submit_pr → task_finish. For projects that only need prPresent, the shorthand `task_finish { prUrl }` still works and this verb is optional. This is the v2-native replacement for the deprecated v1 `tasks_update { branchName, prUrl, prNumber }` path, which is being sunset 4 weeks after 2026-04-15. Re-submission is allowed and overwrites the prior values (supports the request_changes rework loop). Caller must hold the work claim; task must be in a non-terminal state and not `open`.",
      inputShape: {
        taskId: uuid(),
        branchName: z.string().trim().min(1).max(255),
        prUrl: z
          .string()
          .regex(
            /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/,
            "prUrl must be a github.com pull request URL",
          ),
        prNumber: z.number().int().positive(),
      },
      handler: async ({ taskId, ...input }) =>
        wrap(() => client.submitPr(taskId, input)),
    }),

    // ── v1 surface (deprecated) ──────────────────────────────────────────
    def({
      name: "projects_list",
      description:
        DEPRECATED +
        "List all projects visible to the authenticated actor. Returns id, slug, name, and GitHub repo for each. Agents should use task_pickup instead of browsing.",
      inputShape: {},
      handler: async () => wrap(() => client.listProjects()),
    }),
    def({
      name: "projects_get",
      description:
        DEPRECATED +
        "Fetch a single project by slug or id. Project browsing is not an agent concern under v2.",
      inputShape: { slugOrId: z.string().min(1) },
      handler: async ({ slugOrId }) => wrap(() => client.getProject(slugOrId)),
    }),
    def({
      name: "tasks_list",
      description:
        DEPRECATED +
        "List claimable tasks. Use task_pickup instead — it returns one prioritized item.",
      inputShape: {
        limit: z.number().int().positive().max(500).optional(),
      },
      handler: async ({ limit }) =>
        wrap(() => client.listClaimableTasks({ limit })),
    }),
    def({
      name: "tasks_get",
      description:
        DEPRECATED +
        "Fetch a task by id. v2 folds this into the task_start response.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.getTask(taskId)),
    }),
    def({
      name: "tasks_instructions",
      description:
        DEPRECATED +
        "Fetch agent-facing instructions. v2 folds this into the task_start response.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) =>
        wrap(() => client.getTaskInstructions(taskId)),
    }),
    def({
      name: "tasks_create",
      description:
        DEPRECATED +
        "Use task_create instead (same behavior, v2 naming).",
      inputShape: {
        projectId: uuid(),
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        priority: priorityEnum.optional(),
        workflowId: uuid().optional(),
        dueAt: z.string().datetime().optional(),
        externalRef: z.string().trim().min(1).max(255).optional(),
        labels: z
          .array(z.string().trim().min(1).max(100))
          .max(20)
          .optional(),
      },
      handler: async ({ projectId, ...input }) =>
        wrap(() => client.createTask(projectId, input)),
    }),
    def({
      name: "tasks_claim",
      description:
        DEPRECATED +
        "Use task_start instead (atomic claim + in_progress + instructions).",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.claimTask(taskId)),
    }),
    def({
      name: "tasks_release",
      description:
        DEPRECATED +
        "Use task_abandon instead (explicit bail-out with audit trail).",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.releaseTask(taskId)),
    }),
    def({
      name: "tasks_transition",
      description:
        DEPRECATED +
        "Agents should not pick status values directly. Use task_start and task_finish; the system owns transitions under v2.",
      inputShape: {
        taskId: uuid(),
        status: transitionStatusEnum,
        force: z.boolean().optional(),
        forceReason: z.string().max(500).optional(),
      },
      handler: async ({ taskId, ...input }) =>
        wrap(() => client.transitionTask(taskId, input)),
    }),
    def({
      name: "tasks_update",
      description:
        DEPRECATED +
        "Generic field updates are not part of the v2 agent surface. Pass prUrl via task_finish instead.",
      inputShape: {
        taskId: uuid(),
        branchName: z.string().max(255).nullable().optional(),
        prUrl: z.string().url().nullable().optional(),
        prNumber: z.number().int().positive().nullable().optional(),
        result: z.string().nullable().optional(),
      },
      handler: async ({ taskId, ...input }) =>
        wrap(() => client.updateTask(taskId, input)),
    }),
    def({
      name: "tasks_comment",
      description:
        DEPRECATED +
        "Use task_note instead (same behavior, v2 naming).",
      inputShape: {
        taskId: uuid(),
        content: z.string().min(1).max(5000),
      },
      handler: async ({ taskId, content }) =>
        wrap(() => client.addTaskComment(taskId, content)),
    }),
    def({
      name: "review_approve",
      description:
        DEPRECATED +
        "Use task_finish with outcome=\"approve\" instead (after task_start on a review task).",
      inputShape: {
        taskId: uuid(),
        comment: z.string().max(5000).optional(),
      },
      handler: async ({ taskId, comment }) =>
        wrap(() => client.reviewTask(taskId, { action: "approve", comment })),
    }),
    def({
      name: "review_request_changes",
      description:
        DEPRECATED +
        "Use task_finish with outcome=\"request_changes\" instead (after task_start on a review task).",
      inputShape: {
        taskId: uuid(),
        comment: z.string().max(5000).optional(),
      },
      handler: async ({ taskId, comment }) =>
        wrap(() =>
          client.reviewTask(taskId, { action: "request_changes", comment }),
        ),
    }),
    def({
      name: "review_claim",
      description:
        DEPRECATED +
        "Use task_start on a task in review status instead — it review-claims polymorphically.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.claimReview(taskId)),
    }),
    def({
      name: "review_release",
      description:
        DEPRECATED +
        "Use task_abandon instead.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.releaseReview(taskId)),
    }),
    def({
      name: "signals_poll",
      description:
        DEPRECATED +
        "Signals are delivered inline by task_pickup under v2.",
      inputShape: {},
      handler: async () => wrap(() => client.pollSignals()),
    }),
    def({
      name: "signals_ack",
      description:
        DEPRECATED +
        "Signals are acked atomically when delivered by task_pickup under v2.",
      inputShape: { signalId: uuid() },
      handler: async ({ signalId }) => wrap(() => client.ackSignal(signalId)),
    }),
    def({
      name: "pull_requests_create",
      description:
        DEPRECATED +
        "PR creation is not an agent-tasks concern under v2. Use the `gh` CLI directly; pass the resulting URL to task_finish as prUrl.",
      inputShape: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        head: z.string().min(1),
        base: z.string().min(1).optional(),
        title: z.string().min(1),
        body: z.string().optional(),
      },
      handler: async (input) => wrap(() => client.createPullRequest(input)),
    }),
    def({
      name: "pull_requests_merge",
      description:
        DEPRECATED +
        "Merge is a human decision, not an agent routine. Use the web UI or `gh pr merge` directly.",
      inputShape: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        prNumber: z.number().int().positive(),
        mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
      },
      handler: async ({ mergeMethod, ...rest }) =>
        wrap(() =>
          client.mergePullRequest({
            ...rest,
            // The backend schema field is snake_case `merge_method`. The
            // MCP tool surface uses camelCase `mergeMethod` to match the
            // convention of the other MCP tools (branchName, prUrl, etc.)
            // and translates here at the client boundary.
            ...(mergeMethod !== undefined ? { merge_method: mergeMethod } : {}),
          }),
        ),
    }),
    def({
      name: "pull_requests_comment",
      description:
        DEPRECATED +
        "Use `gh pr comment` directly or leave the note on the task via task_note.",
      inputShape: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        prNumber: z.number().int().positive(),
        body: z.string().min(1),
      },
      handler: async (input) =>
        wrap(() => client.commentOnPullRequest(input)),
    }),
  ];
}
