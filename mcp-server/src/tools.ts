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

export function buildTools(client: AgentTasksClient): ToolDefinition[] {
  return [
    def({
      name: "projects_list",
      description:
        "List all projects visible to the authenticated actor. Returns id, slug, name, and GitHub repo for each.",
      inputShape: {},
      handler: async () => wrap(() => client.listProjects()),
    }),
    def({
      name: "tasks_list",
      description:
        "List tasks that the authenticated actor may claim (status=open, not blocked, not already claimed). Supports an optional limit.",
      inputShape: {
        limit: z.number().int().positive().max(500).optional(),
      },
      handler: async ({ limit }) =>
        wrap(() => client.listClaimableTasks({ limit })),
    }),
    def({
      name: "tasks_get",
      description:
        "Fetch a single task by id, including comments and dependencies.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.getTask(taskId)),
    }),
    def({
      name: "tasks_instructions",
      description:
        "Fetch agent-facing instructions for a task: current state, allowed transitions, confidence score, required-field checklist, and updatable fields.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) =>
        wrap(() => client.getTaskInstructions(taskId)),
    }),
    def({
      name: "tasks_create",
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
        "Claim a task as the authenticated actor. Fails if the task is already claimed, blocked, or not in a claimable state.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.claimTask(taskId)),
    }),
    def({
      name: "tasks_release",
      description:
        "Release a previously claimed task, returning it to the claimable pool.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.releaseTask(taskId)),
    }),
    def({
      name: "tasks_transition",
      description:
        "Transition a task to a new status. Preconditions from the task's workflow (branchPresent, prMerged, ciGreen, …) are enforced server-side. Use force=true with a forceReason only when you have explicit authorization to bypass gates.",
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
        "Update mutable fields on a task: branchName, prUrl, prNumber, result. Pass null to clear a field.",
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
        "Add a comment to a task. Useful for logging progress, asking human reviewers for clarification, or recording decisions.",
      inputShape: {
        taskId: uuid(),
        content: z.string().min(1).max(5000),
      },
      handler: async ({ taskId, content }) =>
        wrap(() => client.addTaskComment(taskId, content)),
    }),
    def({
      name: "signals_poll",
      description:
        "Poll the signal inbox for the authenticated agent. Signals represent state changes the agent should react to (task claimed, review requested, force-transition, …).",
      inputShape: {},
      handler: async () => wrap(() => client.pollSignals()),
    }),
    def({
      name: "signals_ack",
      description:
        "Acknowledge a signal by id. Acknowledged signals are removed from the inbox.",
      inputShape: { signalId: uuid() },
      handler: async ({ signalId }) => wrap(() => client.ackSignal(signalId)),
    }),
    def({
      name: "pull_requests_create",
      description:
        "Create a GitHub pull request bound to a task via delegation. The backend dispatches the create call through a team member who has connected GitHub and enabled 'Allow agents to create PRs'; on success the task's branchName, prUrl, and prNumber are patched server-side. Requires token scope tasks:update. base defaults to 'main' — pass the repo's actual default branch (e.g. 'master') explicitly if it differs.",
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
        "Merge a GitHub pull request via delegation and auto-transition the linked task to 'done'. Dispatched through a team member with 'Allow agents to merge PRs' consent. Idempotent on PRs that are already merged. Requires token scope tasks:transition. mergeMethod defaults to 'squash'. REQUIRES the task to be in 'review' state (or already 'done' for re-entry) — tasks in 'open' / 'in_progress' are rejected with 403. If the project has `requireDistinctReviewer` enabled, the merge caller must not be the task's claimant and must have already taken the review lock via tasks_transition→review plus the review-claim flow. To bypass these gates, a team admin can force-transition the task to 'done' via tasks_transition with force=true first, then call this tool.",
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
        "Post a comment on a GitHub pull request via delegation. Dispatched through a team member with 'Allow agents to comment on PRs' consent. Requires token scope tasks:comment. Use for CI status notes, review follow-ups, or cross-referencing other tasks — agent-authored comments are audit-logged separately from human comments.",
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
