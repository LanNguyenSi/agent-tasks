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
        "Finish a task. Polymorphic based on the claim you hold.\n\nWork claim: pass { result?, prUrl?, autoMerge?, mergeMethod? }. prUrl must be a github.com pull-request URL if provided. The task transitions to its expectedFinishState (review or done depending on the workflow). The work claim is cleared when going to done and kept when going to review.\n\nautoMerge (Mode A — work claim): requires project.soloMode=true. Overrides targetStatus to 'done', evaluates gates (skipping prMerged pre-check), merges the PR via GitHub API, then transitions the task to done atomically. Sets autoMergeSha on success.\n\nReview claim: pass { result?, outcome, autoMerge?, mergeMethod? }. approve → task to done, both claims cleared. request_changes → task back to in_progress, review claim cleared, work claim kept so the author resumes, changes_requested signal emitted.\n\nautoMerge (Mode B — review claim + approve): does NOT require soloMode. Merges the PR and transitions to done atomically. outcome 'request_changes' + autoMerge is rejected.\n\nTransitions may be blocked by workflow gates (branchPresent, prPresent, ciGreen, prMerged). A 422 `precondition_failed` response lists the failing rules. See ADR-0010.",
      inputShape: {
        taskId: uuid(),
        result: z.string().max(5000).optional(),
        prUrl: z.string().url().optional(),
        outcome: z.enum(["approve", "request_changes"]).optional(),
        autoMerge: z.boolean().optional(),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).optional(),
      },
      handler: async ({ taskId, ...body }) =>
        wrap(() => client.finishTask(taskId, body)),
    }),
    def({
      name: "task_create",
      description:
        "Create a new task in a project. Only title is required. Use externalRef as an idempotency key for bulk imports — the backend dedupes on (projectId, externalRef). Pass dependsOn=[taskId, ...] to declare blocking task IDs (same project); task_pickup will skip the new task until all listed blockers reach status=done.",
      inputShape: {
        projectId: uuid(),
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        priority: priorityEnum.optional(),
        workflowId: uuid().optional(),
        dueAt: z.string().datetime().optional(),
        externalRef: z.string().trim().min(1).max(255).optional(),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        dependsOn: z.array(uuid()).max(50).optional(),
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
        "Record the branch + pull request metadata on a work-claimed task. Atomic metadata write, not a state transition. Use this after `gh pr create` to satisfy the `branchPresent` / `prPresent` workflow gates before calling task_finish. The canonical v2 flow for projects that enforce branch gates is: task_start → (work + gh pr create) → task_submit_pr → task_finish. For projects that only need prPresent, the shorthand `task_finish { prUrl }` still works and this verb is optional. This is the v2-native replacement for the deprecated v1 `tasks_update { branchName, prUrl, prNumber }` path, which is being sunset 4 weeks after 2026-04-15. Re-submission is allowed and overwrites the prior values (supports the request_changes rework loop). Caller must hold the work claim; task must be in a non-terminal state and not `open`. Cross-repo hardening: prUrl must point at the same repo as project.githubRepo; mismatches are rejected with 400 cross_repo_pr_rejected. Authorship verification: the PR must be authored by the delegation user; mismatches are rejected with 403 pr_author_mismatch (fails open on GitHub API errors).",
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

    // ── Artifacts (v2) ───────────────────────────────────────────────────
    //
    // Typed, agent-produced task outputs. Unlike attachments (human-uploaded
    // metadata), artifacts carry semantics — later pipeline stages read the
    // outputs of earlier ones (e.g. Stage N reads Stage N-1's `test_report`).
    def({
      name: "task_artifact_create",
      description:
        "Record a typed, agent-produced output on a task (build_log, test_report, generated_code, coverage, diff, other). Inline content is capped at 1 MiB; larger payloads must be uploaded externally and referenced via `url`. Either `content` or `url` is required. Requires the tasks:update scope for agent callers. Task-scoped: no claim required, but the caller must have project access.",
      inputShape: {
        taskId: uuid(),
        type: z.enum([
          "build_log",
          "test_report",
          "generated_code",
          "coverage",
          "diff",
          "other",
        ]),
        name: z.string().min(1).max(255),
        description: z.string().max(1000).optional(),
        content: z.string().max(1_048_576).optional(),
        url: z.string().url().max(2048).optional(),
        mimeType: z.string().max(255).optional(),
      },
      handler: async ({ taskId, ...input }) =>
        wrap(() => client.createTaskArtifact(taskId, input)),
    }),
    def({
      name: "task_artifact_list",
      description:
        "List artifact metadata for a task (most recent first). Payload bytes are not included — use task_artifact_get to fetch a single artifact with its `content`. Optional `type` filter matches the artifact-type enum exactly.",
      inputShape: {
        taskId: uuid(),
        type: z
          .enum([
            "build_log",
            "test_report",
            "generated_code",
            "coverage",
            "diff",
            "other",
          ])
          .optional(),
      },
      handler: async ({ taskId, type }) =>
        wrap(() => client.listTaskArtifacts(taskId, type)),
    }),
    def({
      name: "task_artifact_get",
      description:
        "Fetch a single artifact including its inline `content` (if any) and `url` (if external). Use this when a later pipeline stage needs the output of an earlier stage. Requires the tasks:read scope for agent callers.",
      inputShape: { taskId: uuid(), artifactId: uuid() },
      handler: async ({ taskId, artifactId }) =>
        wrap(() => client.getTaskArtifact(taskId, artifactId)),
    }),

    // ── PR lifecycle (v2) ────────────────────────────────────────────────
    //
    // Server-side PR create + merge. Pairs with the existing GitHub
    // delegation (a team member connects GitHub once and opts in per
    // capability). Self-merge is explicitly blocked on projects with
    // `requireDistinctReviewer` unless `soloMode` is on — see task_merge.
    def({
      name: "task_merge",
      description:
        "Merge the PR attached to a task. Task-scoped verb (not a GitHub-identifier verb): derives owner/repo/PR number from the task/project metadata and uses the team's GitHub delegation. Requires `github:pr_merge` scope for agent callers, and — when `project.requireDistinctReviewer` is enabled and the project is not in `soloMode` — refuses with 403 `self_merge_blocked` if the caller also holds the work claim. Idempotent on an already-merged PR (task stays at `done`).",
      inputShape: {
        taskId: uuid(),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).optional(),
      },
      handler: async ({ taskId, mergeMethod }) =>
        wrap(() => client.mergeTask(taskId, mergeMethod)),
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
        "Fetch a single project by slug or id. Project browsing is not an agent concern under v2. The non-deprecated use is the `effectiveGates` field in the response — call `projects_get_effective_gates` for a leaner payload.",
      inputShape: { slugOrId: z.string().min(1) },
      handler: async ({ slugOrId }) => wrap(() => client.getProject(slugOrId)),
    }),
    def({
      name: "projects_get_effective_gates",
      description:
        "Return the gate map for a project. Each entry is keyed by `GateCode` (e.g. `distinct_reviewer`, `self_merge`, `task_status_for_merge`, `pr_repo_matches_project`) and carries `active` (whether this gate would evaluate on this project), `because` (why — e.g. governance mode, project binding), and `appliesTo` (the verb names the gate can reject). Use it to answer 'will this verb be blocked?' BEFORE making the call, instead of discovering preconditions by tripping a 4xx.",
      inputShape: { projectId: uuid() },
      handler: async ({ projectId }) =>
        wrap(() => client.getProjectEffectiveGates(projectId)),
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
        "Create a pull request on behalf of a team member with GitHub connected. Requires `github:pr_create` scope for agent callers plus an operator who has opted in via 'Allow agents to create PRs' in Settings. The task is updated with `branchName`, `prUrl`, `prNumber` on success. The historic alternative — agents running `gh pr create` themselves and passing the URL into `task_finish { prUrl }` — still works and remains a supported fallback for orgs that prefer not to share a GitHub identity with agent-tasks. Pass `idempotencyKey` (client-generated, any unique string ≤255 chars) to make the call safe to retry after a network timeout — the backend replays the stored 2xx response on subsequent calls with the same key, and rejects the same key + different payload with 409.",
      inputShape: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        head: z.string().min(1),
        base: z.string().min(1).optional(),
        title: z.string().min(1),
        body: z.string().optional(),
        idempotencyKey: z.string().trim().min(1).max(255).optional(),
      },
      handler: async (input) => wrap(() => client.createPullRequest(input)),
    }),
    def({
      name: "pull_requests_merge",
      description:
        "GitHub-identifier merge variant (taskId + owner + repo + prNumber). Prefer `task_merge` when you already hold the taskId — it derives owner/repo/PR number from the task, enforces the same self-merge gate, and avoids having to pass GitHub metadata around. Requires `github:pr_merge` scope for agent callers. Supports `idempotencyKey` (see `pull_requests_create`) for retry-safety across network timeouts.",
      inputShape: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        prNumber: z.number().int().positive(),
        mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
        idempotencyKey: z.string().trim().min(1).max(255).optional(),
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
        "Use `gh pr comment` directly or leave the note on the task via task_note. Supports `idempotencyKey` (see `pull_requests_create`) — GitHub does NOT de-dupe comments, so retries without the key genuinely post the comment twice.",
      inputShape: {
        taskId: uuid(),
        owner: z.string().min(1),
        repo: z.string().min(1),
        prNumber: z.number().int().positive(),
        body: z.string().min(1),
        idempotencyKey: z.string().trim().min(1).max(255).optional(),
      },
      handler: async (input) =>
        wrap(() => client.commentOnPullRequest(input)),
    }),
  ];
}
