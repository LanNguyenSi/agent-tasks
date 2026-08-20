import { z, ZodRawShape } from "zod";
import { AgentTasksClient, AgentTasksApiError, ProjectSlugNotFoundError } from "./client.js";
import { WORKFLOW_PRIMER } from "./primer.js";
import {
  mapBackendError,
  serializeTeachingError,
  looksLikeStructuredWrapper,
  resultMustBePlainStringError,
  projectAddressingConflictError,
  unknownProjectSlugError,
} from "./errors.js";
import {
  receiptForCreate,
  receiptForRespec,
  receiptForFinish,
  receiptForSubmitPr,
  receiptForMerge,
  receiptForAbandon,
  receiptForNote,
  receiptForStart,
  projectPickup,
  type CreateOrRespecResponse,
  type FinishResponse,
  type SubmitPrResponse,
  type MergeResponse,
  type AbandonResponse,
  type NoteResponse,
  type StartResponse,
  type PickupResponse,
} from "./receipt.js";
import {
  projectTaskSummary,
  paginateSignals,
  TASKS_GET_INCLUDE_VALUES,
  SIGNALS_DEFAULT_LIMIT,
  SIGNALS_MAX_LIMIT,
  SIGNALS_BACKEND_FETCH_LIMIT,
  type GetTaskResponse,
  type RawSignal,
} from "./read.js";

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

// ── Receipt contract (docs/response-contract-v1.md) ─────────────────────────
//
// Write verbs return a receipt by default (see the wrap() choke point below
// and receipt.ts, which owns the projection logic). `include: ["task"]` is
// the compatibility valve: it skips the projection and returns the full,
// pre-contract backend object for that call, unchanged. "task" is the only
// value this schema accepts today: the richer read-verb vocabulary
// ("description", "comments", "instructions", "artifacts") belongs to the
// read verbs (rc-v1-C006, not yet converted) and is deliberately NOT
// accepted here: passing one of those values on a write verb is a zod
// validation error, not a silent no-op.
const includeSchema = z
  .array(z.enum(["task"]))
  .max(1)
  .optional()
  .describe(
    'Receipt v1: pass ["task"] to get the full, pre-contract object back for this call instead of the small receipt (recovery path after context loss, or when you need the whole task in one call). "task" is the only supported value on write verbs today.',
  );

// task_start's own include enum. Wider than the other write verbs' (which
// accept only "task") because task_start's default response is a receipt
// PLUS a small per-task slice (inferredTaskType, expectedFinishState,
// gateExpectations) rather than the raw full task — description, comments,
// and the per-state instructions prose are each reachable individually via
// include, without paying for the whole object. include:["task"] is still
// the full, pre-contract object valve, same as every other write verb. See
// receipt.ts's receiptForStart.
const startIncludeSchema = z
  .array(z.enum(["description", "instructions", "comments", "task"]))
  .max(4)
  .optional()
  .describe(
    'Default response is a receipt + a small per-task slice (inferredTaskType, expectedFinishState, gateExpectations), not the full task. Pass one or more of "description", "instructions" (the state\'s agent-facing prose), "comments" to add just that field back, or "task" for the full, pre-contract object (recovery path after context loss).',
  );

// task_pickup's include enum. Its default is already the (near-)full task
// spec per docs/response-contract-v1.md ("full spec, without comments") —
// the only thing include can add back today is comments; "task" is the
// uniform full-object escape hatch every other verb has. Both currently
// resolve to the same content for this verb (see receipt.ts's projectPickup
// doc comment for why that duplication is deliberate, not a bug).
const pickupIncludeSchema = z
  .array(z.enum(["comments", "task"]))
  .max(2)
  .optional()
  .describe(
    'Default response is the full task spec WITHOUT comments. Pass ["comments"] or ["task"] to get comments back too (both return the same full, pre-contract object for this verb today).',
  );

// tasks_get's include enum (rc-v1-C006, the read-verb surface docs/
// response-contract-v1.md's "include semantics" section reserves the full
// five-value vocabulary for). Default response is a SUMMARY (id, title,
// status, priority, labels, claims, blockedBy, prUrl), not the full task —
// see read.ts's projectTaskSummary. "instructions" is deliberately not in
// this enum: it is task_start's own per-state prose, not a field a plain
// task object carries.
const readIncludeSchema = z
  .array(z.enum(TASKS_GET_INCLUDE_VALUES))
  .max(TASKS_GET_INCLUDE_VALUES.length)
  .optional()
  .describe(
    'Default response is a summary (id, title, status, priority, labels, claims, blockedBy, prUrl), not the full task. Pass one or more of "description", "comments", "artifacts" to add just that field back, or "task" for the full, pre-contract object (recovery path after context loss).',
  );

// Choke point for every backend call: maps a thrown AgentTasksApiError to
// the teaching-error shape (docs/response-contract-v1.md's "Error shape
// (block tier)" section; see errors.ts) and throws it as an Error whose
// message IS the serialized shape (serializeTeachingError, which produces
// the same JSON.stringify(x, null, 2) text server.ts's serializeResult
// would for the same object). server.ts's tool-call catch block reads
// `err.message` straight into the isError text block, so this is the one
// place that decides the wire format for every verb's failure path;
// tests/errors.test.ts pins the equality with serializeResult directly.
//
// `verbContext`, forwarded to mapBackendError, is this call's own tool name
// — passed only at the handful of call sites where the resulting recipe
// actually depends on it (see errors.ts's precondition_failed entry);
// every other call site omits it and gets the verb-independent catalog
// entries (or the generic degrade path) unaffected.
async function wrap<T>(fn: () => Promise<T>, verbContext?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AgentTasksApiError) {
      throw new Error(serializeTeachingError(mapBackendError(err.status, err.body, verbContext)));
    }
    throw err;
  }
}

function def<Shape extends ZodRawShape>(
  d: ToolDefinition<Shape>,
): ToolDefinition {
  return d as unknown as ToolDefinition;
}

// ── v1 deprecation notice, and the rc-v1-C007 pruning ───────────────────────
//
// The v1 tools below were phased out in favor of the v2 verb-oriented
// surface (task_pickup / task_start / task_note / task_finish / task_create /
// task_abandon). See ADR 0008.
//
// rc-v1-C007: every verb still carrying this DEPRECATED prefix is
// registered only when buildTools is called with { legacy: true } -- see
// the filter at the bottom of buildTools. server.ts's createServer takes
// the same optional { legacy?: boolean } and passes it straight through;
// index.ts reads AGENT_TASKS_MCP_LEGACY from the process environment and
// forwards it as that option. Handler code is untouched by this change: it
// is a registration-time filter, not a deletion, so AGENT_TASKS_MCP_LEGACY=1
// is a genuine escape hatch for a caller still depending on a pruned verb's
// name, and buildTools stays testable in both modes without env stubbing.
//
// A few DEPRECATED-marked-in-spirit verbs stay in the DEFAULT registration
// regardless, because the work that produced them is still active: tasks_get
// (upgraded by rc-v1-C006 into the modern summary+include read verb, no
// longer actually deprecated, its DEPRECATED prefix removed below),
// tasks_comment (the receipt-converted v1 alias named in the primers'
// converted-verb sentence; pruning it would break their truth guards, and
// its own DEPRECATED prefix -- stale, since it is kept permanently, not
// sunsetting -- is removed below too), and signals_poll / signals_ack
// (signals_poll carries the rc-v1-C006 cap semantics, and acking is
// required for progress at the fetch ceiling). See mcp-server/README.md's
// replacement table for the verb-by-verb migration guidance, and
// docs/response-contract-v1.md for the legacy-flag verbs' exemption from
// this package's response-shape rules.
const DEPRECATED = "[DEPRECATED, use v2 tools] ";

// Verb names pruned from the DEFAULT registration by rc-v1-C007. This is a
// deliberate, hand-typed pin of that exact set, not a value mechanically
// derived from the DEPRECATED prefix at build time: tests/tools.test.ts's
// own "[DEPRECATED marker set equals LEGACY_VERB_NAMES, both directions"
// test is the mechanical guard that keeps the two in sync, so a future verb
// marked DEPRECATED above without a matching entry here (or vice versa)
// fails that test, not just this comment's word. Every verb below still
// carries the DEPRECATED prefix on its description; registering one at all
// is now opt-in via { legacy: true } (or, at the process entrypoint,
// AGENT_TASKS_MCP_LEGACY=1), kept for compatibility only.
const LEGACY_VERB_NAMES = new Set<string>([
  "projects_list",
  "projects_get",
  "tasks_list",
  "tasks_instructions",
  "tasks_create",
  "tasks_claim",
  "tasks_release",
  "tasks_transition",
  "tasks_update",
  "review_approve",
  "review_request_changes",
  "review_claim",
  "review_release",
  "pull_requests_comment",
]);

export function buildTools(
  client: AgentTasksClient,
  options?: { legacy?: boolean },
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    // ── Onboarding (docs/response-contract-v1.md's "Onboarding channels by
    // rate of change" table, rc-v1-C004) ────────────────────────────────
    //
    // System/lifecycle/verb-order knowledge that "effectively never"
    // changes gets its own two channels instead of being replayed on every
    // task_start call (see receipt.ts's receiptForStart and rc-v1-C003):
    // the MCP `initialize.instructions` field (server.ts, sent once per
    // session) and this parameterless verb, callable on demand for the
    // fuller reference. Both texts live in primer.ts, single-sourced
    // against default-workflow.ts so the lifecycle prose never grows a
    // third hand-copied version.
    def({
      name: "workflow_primer",
      description:
        "Full onboarding reference: per-state lifecycle detail, canonical flows, the claim model, receipt/include defaults per verb, and today's error behavior. Parameterless, deterministic, no per-task data (call task_pickup or task_start for that). Complements the shorter `initialize.instructions` text sent once at session start; call this on demand whenever you need the fuller text again, or a fresh session skipped the handshake.",
      inputShape: {},
      handler: async () => WORKFLOW_PRIMER,
    }),

    // ── v2 surface (ADR 0008) ────────────────────────────────────────────
    def({
      name: "task_pickup",
      description:
        "Get the next piece of work. Returns one of: a pending signal, a task ready for review, a claimable task, or idle. The response is tagged with `kind: \"signal\" | \"review\" | \"work\" | \"idle\"`. Signals are delivered at-most-once and acked atomically. Review tasks are filtered by the distinct-reviewer rule (you cannot review tasks you authored). Fails with 409 if you already hold an active claim; call tasks_get on it to see its state, then task_finish, task_abandon, or task_merge as appropriate (see the already_claimed entry in workflow_primer for the exact cases).\n\nOn a review/work `kind`, returns the full task spec by default — description, templateData, acceptance criteria, everything you need to do the work — WITHOUT `comments` (docs/response-contract-v1.md: task_pickup is the one write verb whose default is the full spec, not a receipt). Pass include:[\"comments\"] or include:[\"task\"] to get comments back too.\n\nOptional `reclassify`: opt-in flag that re-runs the debugFlavor classifier past the isFresh guard and overwrites debugFlavor with the new result; on a true-to-false flip it also deletes the now-stale grounding-session metadata. Forwarded as `?reclassify=true` in the query string (the backend compares with `=== \"true\"`, so only the literal lowercase string `true` is honoured; any other truthy representation is a no-op).",
      inputShape: {
        reclassify: z
          .boolean()
          .optional()
          .describe(
            "Opt-in flag. When true, re-runs the debugFlavor classifier past the isFresh guard and overwrites debugFlavor with the new result; on a true-to-false flip it also deletes the now-stale grounding-session metadata. Sent as the literal query string `?reclassify=true` — only lowercase `true` is honoured by the backend; other truthy values are no-ops.",
          ),
        include: pickupIncludeSchema,
      },
      handler: async ({ reclassify, include }) => {
        const response = await wrap(() =>
          client.pickupWork(reclassify !== undefined ? { reclassify } : undefined),
        );
        return projectPickup(response as PickupResponse, include);
      },
    }),
    def({
      name: "task_start",
      description:
        "Begin work on a task. Polymorphic by task status: an `open` task is author-claimed and transitioned to in_progress; a `review` task is review-claimed without state change. Fails with 409 if you already hold an active claim.\n\nOptional `branchName`: for projects that enforce the `branchPresent` workflow gate on the start edge, pass the branch you intend to work on and the server folds it into the same atomic claim write, no follow-up call required. Ignored when the task already has a branchName (idempotent, never overwrites). Only meaningful on the open→in_progress branch; on a review-claim start the value is accepted but ignored.\n\nOptional `reclassify`: opt-in flag that re-runs the debugFlavor classifier past the isFresh guard and overwrites debugFlavor with the new result; on a true-to-false flip it also deletes the now-stale grounding-session metadata. Forwarded as a strict JSON boolean in the request body (unlike task_pickup where only the literal query string `true` is honoured).\n\nReturns a receipt by default ({ ok, task: { id, status }, transition?, expectedFinishState, gateExpectations?, gateExpectationsSource?, requestChangesGateExpectations?, inferredTaskType? }) — no description, no per-state instructions prose, no comments, and no project object; a compact grounding-session recipe replaces the debugFlavor hint's verbose fields when the task is debug-flavored, and the large metadata.groundingSessionState blob never appears. `transition` (from/to) appears only on an actual state change (a work claim; a review claim does not itself transition status). `gateExpectations` is the gate list for the edge task_finish will hit next (on a review claim: the approve outcome); `requestChangesGateExpectations` is the review claim's other outcome. Either can be `null`, meaning the edge itself does not exist and that finish call will 400, distinct from an omitted field, which means nothing is required (or, on an old backend, nothing could be derived). gateExpectationsSource is set to \"assumed-default-workflow\" only when the backend predates the authoritative gate fields and gateExpectations came from the static built-in-default fallback instead, since a null workflowId can also mean a customized project-default workflow; unset on a current backend. Pass include:[\"description\" | \"instructions\" | \"comments\"] to add one field back, or include:[\"task\"] for the full, pre-contract object (recovery path after context loss).",
      inputShape: {
        taskId: uuid(),
        branchName: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe(
            "Optional branch name. When set and the task has no branchName yet, the server writes it as part of the claim transaction so a `branchPresent` precondition passes in one call.",
          ),
        reclassify: z
          .boolean()
          .optional()
          .describe(
            "Opt-in flag. When true, re-runs the debugFlavor classifier past the isFresh guard and overwrites debugFlavor with the new result; on a true-to-false flip it also deletes the now-stale grounding-session metadata. Forwarded as a strict JSON boolean in the request body (unlike task_pickup where the backend compares the query string with === \"true\").",
          ),
        include: startIncludeSchema,
      },
      handler: async ({ taskId, branchName, reclassify, include }) => {
        const body: { branchName?: string; reclassify?: boolean } = {};
        if (branchName) body.branchName = branchName;
        if (reclassify !== undefined) body.reclassify = reclassify;
        const response = await wrap(
          () => client.startTask(taskId, Object.keys(body).length > 0 ? body : undefined),
          "task_start",
        );
        // include:["task"] valve is handled inside receiptForStart itself
        // (same layer as projectPickup handles it for task_pickup), not
        // here, since task_start's include vocabulary is wider than the
        // single "task" value the other write verbs accept.
        return receiptForStart(response as StartResponse, include);
      },
    }),
    def({
      name: "task_note",
      description:
        "Comment on a task. Works for both work and review claims — use this to record progress, ask questions, or leave review feedback. Requires taskId today; a future revision may infer it from the active claim.\n\nReturns a receipt by default ({ ok, task: { id } }, no status — the backend comment endpoint does not report task status). Pass include:[\"task\"] for the full { comment } object.",
      inputShape: {
        taskId: uuid(),
        content: z.string().min(1).max(5000),
        include: includeSchema,
      },
      handler: async ({ taskId, content, include }) => {
        const response = await wrap(() => client.addTaskComment(taskId, content));
        if (include?.includes("task")) return response;
        return receiptForNote(taskId, response as NoteResponse);
      },
    }),
    def({
      name: "task_finish",
      description:
        "Finish a task. Requires an active work or review claim on this specific task; call task_start first to claim it (task_pickup alone returns a candidate but does not claim). The claim of any prior task you just finished does NOT carry over. Polymorphic based on the claim you hold.\n\nWork claim: pass { result?, prUrl?, autoMerge?, mergeMethod? }. prUrl must be a github.com pull-request URL if provided. The task transitions to its expectedFinishState (review or done depending on the workflow). The work claim is cleared when going to done and kept when going to review.\n\nautoMerge (Mode A — work claim): requires project.soloMode=true. Overrides targetStatus to 'done', evaluates gates (skipping prMerged pre-check), merges the PR via GitHub API, then transitions the task to done atomically. Sets autoMergeSha on success.\n\nReview claim: pass { result?, outcome, autoMerge?, mergeMethod? }. approve → task to done, both claims cleared. request_changes → task back to in_progress, review claim cleared, work claim kept so the author resumes, changes_requested signal emitted.\n\nautoMerge (Mode B — review claim + approve): does NOT require soloMode. Merges the PR and transitions to done atomically. outcome 'request_changes' + autoMerge is rejected.\n\nTransitions may be blocked by workflow gates (branchPresent, prPresent, ciGreen, prMerged). A 422 `precondition_failed` response lists the failing rules. See ADR-0010.\n\nReturns a receipt by default ({ ok, task: { id, status }, deviations? }) — a WORKFLOW_GATE_SKIPPED deviation appears when autoMerge bypassed a normally-required gate. Pass include:[\"task\"] for the full backend object.",
      inputShape: {
        taskId: uuid(),
        result: z
          .string()
          .max(5000)
          .describe(
            "Free-text summary of the work, recorded on the task timeline (plain prose or markdown, max 5000 chars). Not a structured payload: do not wrap it in XML or JSON tags — it is stored and rendered as text.",
          )
          .optional(),
        prUrl: z.string().url().optional(),
        outcome: z.enum(["approve", "request_changes"]).optional(),
        autoMerge: z.boolean().optional(),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).optional(),
        include: includeSchema,
      },
      handler: async ({ taskId, include, ...body }) => {
        // Catalog entry #8 (errors.ts): `result` is stored verbatim as free
        // text by the backend, which performs no validation of its shape —
        // this guard exists only at this layer, checked BEFORE any request
        // is sent, so an XML/JSON-wrapped result never round-trips into
        // mis-stored structured input in the first place.
        if (body.result !== undefined && looksLikeStructuredWrapper(body.result)) {
          throw new Error(serializeTeachingError(resultMustBePlainStringError("task_finish")));
        }
        const response = await wrap(() => client.finishTask(taskId, body), "task_finish");
        if (include?.includes("task")) return response;
        return receiptForFinish(response as FinishResponse);
      },
    }),
    def({
      name: "task_create",
      description:
        "Create a new task in a project. Only title is required (plus exactly one of project, projectId, or projectSlug). Use externalRef as an idempotency key for bulk imports — the backend dedupes on (projectId, externalRef). Pass dependsOn=[taskId, ...] to declare blocking task IDs (same project); task_pickup will skip the new task until every listed blocker reaches a resolved status (done or abandoned). Note: dependsOn is a CREATE-time field only — there is no v2 verb to add or remove blockers post-create; use the REST /tasks/:id/dependencies endpoints (currently human-only) for that. Pass debugFlavor=true/false to explicitly classify the task: true forces the grounding hint at pickup, false suppresses it. When omitted, the backend runs the title/label heuristic lazily at task_pickup instead. When a project uses task-template mode, call projects_get_effective_gates first and populate the templateData fields it lists under taskCreation.requiredFields.\n\nproject is a slug-or-UUID alternative to projectId/projectSlug, matching project_tasks's own `project` param: pass a slug ('agent-tasks') or a UUID in one field instead of choosing between the other two. projectSlug (rc-v1-C006) remains a slug-only alternative to projectId. All three resolve through the same mcp-server-side, TTL-cached slug lookup (~15 min, invalidated and retried once if the cached id 404s downstream) when a slug is given. Passing project together with projectId, project together with projectSlug, or projectId together with projectSlug is a project_addressing_conflict teaching error; passing none of the three is the same error in the other direction. A slug that resolves to nothing is an unknown_project_slug teaching error whose recipe asks the operator for the correct slug or id (or, with AGENT_TASKS_MCP_LEGACY=1 set, call projects_list).\n\nReturns a receipt by default ({ ok, task: { id, status }, confidence: <score>, deviations? }) — description/templateData are NOT echoed back. A CONFIDENCE_BELOW_THRESHOLD deviation appears when score < threshold, with detail ({score, threshold, enforcementMode, missing[] clamped to the first 5, totalMissing}) and a task_respec hint; low confidence never blocks creation itself, only the hard gate at task_pickup/task_start (when enforcementMode=BLOCK) does. Pass include:[\"task\"] for the full { task, confidence } object.",
      inputShape: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe(
            "Slug or UUID, same polymorphic addressing as project_tasks's `project`. Alternative to projectId/projectSlug. Pass exactly one of project, projectId, or projectSlug. Trimmed and length-capped (max 255) like projectSlug, so the two slug-accepting fields share the same input hygiene. A UUID-shaped value is routed straight to the id endpoint and never treated as a slug -- if this project's slug is itself UUID-shaped, pass it via projectSlug instead, which is always resolved as a slug.",
          ),
        projectId: uuid().optional(),
        projectSlug: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe(
            "Slug-only alternative to projectId. Resolved mcp-server-side via a TTL-cached slug lookup. Pass exactly one of project, projectId, or projectSlug.",
          ),
        title: z.string().min(1).max(255),
        description: z.string().optional(),
        priority: priorityEnum.optional(),
        workflowId: uuid().optional(),
        dueAt: z.string().datetime().optional(),
        externalRef: z.string().trim().min(1).max(255).optional(),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
        dependsOn: z.array(uuid()).max(50).optional(),
        debugFlavor: z.boolean().optional(),
        templateData: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Structured spec fields, forwarded to the backend which validates + scores them: goal, acceptanceCriteria (the task's evals), context, constraints, scope, outOfScope, dependencies, risk, agentPrompt, taskType, and prefers { testBeforeImplementation, verticalSlices, smallDiffs, explicitStopConditions, noSpeculativeRefactoring }. Populate goal + acceptanceCriteria at minimum so the task is executable.",
          ),
        deliverableRepo: z
          .string()
          .trim()
          .min(3)
          .max(255)
          .regex(/^[^/\s]+\/[^/\s]+$/, "Expected 'owner/repo'")
          .optional()
          .describe(
            "Cross-repo deliverable override ('owner/repo'). Set only when this task's legitimate deliverable is a PR in a DIFFERENT GitHub repo than the project's linked githubRepo (benchmark/measurement/docs tasks) — the cross-repo PR guard and merge automation then key off this repo instead. Post-create changes are project-admin-only (human, PATCH); agents cannot retarget it later.",
          ),
        include: includeSchema,
      },
      handler: async ({ project, projectId, projectSlug, include, ...input }) => {
        // rc-v1-C006 (extended for the unified `project` field): addressing
        // validation happens here, before any network call, same pattern as
        // task_respec's own client-side "at least one of" guard below —
        // except CONFLICT is a proper teaching error per the task spec, not
        // a bare thrown message. Checked pairwise so the message names the
        // two fields that actually collided, not a generic "more than one".
        if (project !== undefined && projectId !== undefined) {
          throw new Error(
            serializeTeachingError(
              projectAddressingConflictError("task_create", "project_and_projectId"),
            ),
          );
        }
        if (project !== undefined && projectSlug !== undefined) {
          throw new Error(
            serializeTeachingError(
              projectAddressingConflictError("task_create", "project_and_projectSlug"),
            ),
          );
        }
        if (projectId !== undefined && projectSlug !== undefined) {
          throw new Error(serializeTeachingError(projectAddressingConflictError("task_create")));
        }
        if (project === undefined && projectId === undefined && projectSlug === undefined) {
          throw new Error(
            serializeTeachingError(
              projectAddressingConflictError("task_create", "neither_provided"),
            ),
          );
        }
        let response: unknown;
        try {
          response =
            project !== undefined
              ? await wrap(() => client.createTaskByProject(project, input))
              : projectId !== undefined
                ? await wrap(() => client.createTask(projectId, input))
                : await wrap(() => client.createTaskByProjectSlug(projectSlug as string, input));
        } catch (err) {
          // ProjectSlugNotFoundError is raised by client.ts's resolver on a
          // FRESH 404 (not a stale cache entry — that case is retried
          // internally and never reaches here). wrap() does not translate
          // it (it is not an AgentTasksApiError), so it is caught here and
          // mapped to the specific unknown_project_slug teaching error
          // instead of leaking a raw, non-JSON error message.
          if (err instanceof ProjectSlugNotFoundError) {
            throw new Error(serializeTeachingError(unknownProjectSlugError(err.slug, "task_create")));
          }
          throw err;
        }
        if (include?.includes("task")) return response;
        return receiptForCreate(response as CreateOrRespecResponse, input);
      },
    }),
    def({
      name: "task_respec",
      description:
        "Edit an OPEN, UNCLAIMED task's description and/or structured templateData in place — fix a low-confidence or under-specified spec instead of abandoning and recreating the task. Wraps POST /api/tasks/:id/respec. Requires at least one of description or templateData (checked client-side before the request, and enforced authoritatively by the backend with 400 — the backend also rejects empty values: a blank/whitespace-only description, or an empty templateData object). templateData is a WHOLESALE REPLACE of the task's stored templateData, not a merge — send the full object you want stored. By default only the task's creator may respec it; a project admin can relax this via project.allowNonCreatorRespec (403 otherwise; missing tasks:update scope for agent callers is also 403). Any task that is claimed (work or review) or not status=open is rejected with 409 'Task must be open and unclaimed to respec'. 404 if the task does not exist. A call that would not actually change anything (same values resubmitted) is a no-op: no write, no audit entry.\n\nReturns a receipt by default ({ ok, task: { id, status }, confidence: <score>, deviations? }) — description/templateData are NOT echoed back. confidence is freshly re-scored on the STORED (new) values; a CONFIDENCE_BELOW_THRESHOLD deviation appears when the new score is still below threshold. Pass include:[\"task\"] for the full { task, confidence } object (confidence there keeps its detailed shape: { score, threshold, enforcementMode, blocking, missing, findings, nextActions }).",
      inputShape: {
        taskId: uuid(),
        description: z
          .string()
          .optional()
          .describe(
            "Replacement description text. Backend rejects a blank/whitespace-only value and anything over 50000 chars with 400. At least one of description or templateData is required.",
          ),
        templateData: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Replacement structured spec fields (same shape as task_create's templateData: goal, acceptanceCriteria, context, constraints, scope, outOfScope, dependencies, risk, agentPrompt, taskType, prefers). This WHOLESALE REPLACES the task's stored templateData — it is not merged with the existing value. Backend rejects an empty object with 400. At least one of description or templateData is required.",
          ),
        include: includeSchema,
      },
      handler: async ({ taskId, description, templateData, include }) => {
        if (description === undefined && templateData === undefined) {
          throw new Error(
            "task_respec requires at least one of description or templateData",
          );
        }
        const body: {
          description?: string;
          templateData?: Record<string, unknown>;
        } = {};
        if (description !== undefined) body.description = description;
        if (templateData !== undefined) body.templateData = templateData;
        const response = await wrap(() => client.respecTask(taskId, body));
        if (include?.includes("task")) return response;
        return receiptForRespec(response as CreateOrRespecResponse);
      },
    }),
    def({
      name: "task_abandon",
      description:
        "Explicit bail-out: release the active claim on a task without finishing. A work claim on an in_progress task returns it to open; a review claim simply releases the review lock. Use this sparingly — task_finish is the normal path. Separate intent from finish so audit trails distinguish abandonment from completion.\n\nReturns a receipt by default ({ ok, task: { id, status } }). Pass include:[\"task\"] for the full backend object.",
      inputShape: { taskId: uuid(), include: includeSchema },
      handler: async ({ taskId, include }) => {
        const response = await wrap(() => client.abandonTask(taskId));
        if (include?.includes("task")) return response;
        return receiptForAbandon(response as AbandonResponse);
      },
    }),
    def({
      name: "task_creator_abandon",
      description:
        "Retire an OPEN, UNCLAIMED task you created into status=abandoned, for the case where the task itself was a mistake (e.g. filed in the wrong project) rather than work you started and gave up on. Distinct from task_abandon: that verb releases a CLAIM (work or review) you currently hold; this verb never requires a claim and instead ends the task's lifecycle outright. Typical use: you filed a task in the wrong project, re-filed the correct one, and now need to retire the original so it stops showing up as an open duplicate. Wraps POST /api/tasks/:id/creator-abandon.\n\nNarrow authz, no relaxation and no force: only the task's own creator may call this (403 otherwise), and the task must still be status=open with no work or review claim held by anyone (409 'Task must be open and unclaimed to creator-abandon' otherwise). Agent-only, requires the tasks:update scope; humans have DELETE for this case instead. 404 if the task does not exist. Optional `reason` is recorded on the audit trail but not required.\n\nNot a dead end: abandoned is recoverable only by a project admin, via a status PATCH to the workflow's initial state (no agent path, and no other target status is allowed).\n\nReturns a receipt by default ({ ok, task: { id, status } }). Pass include:[\"task\"] for the full backend object.",
      inputShape: {
        taskId: uuid(),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe("Optional free-text reason, recorded on the audit trail (e.g. 'refiled as <taskId> in the correct project')."),
        include: includeSchema,
      },
      handler: async ({ taskId, reason, include }) => {
        const response = await wrap(() => client.creatorAbandonTask(taskId, reason !== undefined ? { reason } : undefined));
        if (include?.includes("task")) return response;
        return receiptForAbandon(response as AbandonResponse);
      },
    }),
    def({
      name: "task_submit_pr",
      description:
        "Record the branch + pull request metadata on a work-claimed task. Atomic metadata write, not a state transition. Use this after `gh pr create` to satisfy the `branchPresent` / `prPresent` workflow gates before calling task_finish. The canonical v2 flow for projects that enforce branch gates is: task_start → (work + gh pr create) → task_submit_pr → task_finish. For projects that only need prPresent, the shorthand `task_finish { prUrl }` still works and this verb is optional. This is the v2-native replacement for the v1 `tasks_update { branchName, prUrl, prNumber }` path, pruned from the default tool registration by rc-v1-C007 and reachable only with AGENT_TASKS_MCP_LEGACY=1 set. Re-submission is allowed and overwrites the prior values (supports the request_changes rework loop). Caller must hold the work claim; task must be in a non-terminal state and not `open`. Cross-repo hardening: prUrl must point at the same repo as project.githubRepo; mismatches are rejected with 400 cross_repo_pr_rejected. Authorship verification: the PR must be authored by the delegation user; mismatches are rejected with 403 pr_author_mismatch (fails open on GitHub API errors).\n\nReturns a receipt by default ({ ok, task: { id, status }, next: [\"task_finish once CI is green\"] }). Not a state transition, so no `transition` field. Pass include:[\"task\"] for the full backend object.",
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
        include: includeSchema,
      },
      handler: async ({ taskId, include, ...input }) => {
        const response = await wrap(() => client.submitPr(taskId, input));
        if (include?.includes("task")) return response;
        return receiptForSubmitPr(response as SubmitPrResponse);
      },
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

    // ── Attachments (read-only) ──────────────────────────────────────────
    //
    // Human-uploaded files (images + text). Agents cannot upload or delete
    // them, but can READ them so a pipeline stage can consume an uploaded
    // spec, document, or screenshot.
    def({
      name: "task_attachment_list",
      description:
        "List metadata for a task's human-uploaded attachments (images + text files), most recent first. Bytes are not included — use task_attachment_get to read one attachment's content. Requires the tasks:read scope for agent callers.",
      inputShape: { taskId: uuid() },
      handler: async ({ taskId }) => wrap(() => client.listTaskAttachments(taskId)),
    }),
    def({
      name: "task_attachment_get",
      description:
        "Read one human-uploaded attachment's content: a UTF-8 text excerpt for text files (text/plain, markdown, csv), or base64 for images (jpeg/png/gif/webp) when `includeBase64` is set. Use this to consume an uploaded spec/document or a screenshot. `textByteLimit` (max 800000, default 200000) and `base64ByteLimit` (max 512000, default 65536) cap the returned slice; values above the max are rejected. The response carries `status` (ready/missing/unsupported/error), `truncated`, `bytesRead`, `fileSize`, and `base64Truncated` — when `base64Truncated` is true and `base64` is null, the image exceeded `base64ByteLimit`, so retry with a higher value. Requires the tasks:read scope for agent callers.",
      inputShape: {
        taskId: uuid(),
        attachmentId: uuid(),
        includeBase64: z.boolean().optional(),
        textByteLimit: z.number().int().positive().max(800_000).optional(),
        base64ByteLimit: z.number().int().positive().max(512_000).optional(),
      },
      handler: async ({ taskId, attachmentId, includeBase64, textByteLimit, base64ByteLimit }) =>
        wrap(() =>
          client.getTaskAttachmentContent(taskId, attachmentId, {
            includeBase64,
            textByteLimit,
            base64ByteLimit,
          }),
        ),
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
        "Merge the PR attached to a task. Task-scoped verb (not a GitHub-identifier verb): derives owner/repo/PR number from the task/project metadata and uses the team's GitHub delegation. Requires `github:pr_merge` scope for agent callers, and, when `project.requireDistinctReviewer` is enabled and the project is not in `soloMode`, refuses with 403 `self_merge_blocked` if the caller also holds the work claim. Idempotent on an already-merged PR (task stays at `done`).\n\nReturns a receipt by default ({ ok, task: { id, status } }), no `transition` field: the route accepts both `review` and an idempotent `done` retry as valid starting states, and the backend's `alreadyMerged` flag describes the GitHub PR's own merge state, not whether a DB transition happened on this call, so the receipt reports the outcome via `task.status` alone. Pass include:[\"task\"] for the full { task, merged, sha, alreadyMerged } object.",
      inputShape: {
        taskId: uuid(),
        mergeMethod: z.enum(["squash", "merge", "rebase"]).optional(),
        include: includeSchema,
      },
      handler: async ({ taskId, mergeMethod, include }) => {
        const response = await wrap(() => client.mergeTask(taskId, mergeMethod));
        if (include?.includes("task")) return response;
        return receiptForMerge(response as MergeResponse);
      },
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
        "Fetch a single project by slug or id. Project browsing is not an agent concern under v2. The non-deprecated use is the `effectiveGates` and `taskCreation` fields in the response (taskCreation includes a per-task-type `taskTypeThresholds` summary with { effectiveThreshold, thresholdSource }) — call `projects_get_effective_gates` for a leaner payload that carries both.",
      inputShape: { slugOrId: z.string().min(1) },
      handler: async ({ slugOrId }) => wrap(() => client.getProject(slugOrId)),
    }),
    def({
      name: "projects_get_effective_gates",
      description:
        "Return the gate map for a project. Each entry is keyed by `GateCode` (e.g. `distinct_reviewer`, `self_merge`, `task_status_for_merge`, `pr_repo_matches_project`) and carries `active` (whether this gate would evaluate on this project), `because` (why — e.g. governance mode, project binding), and `appliesTo` (the verb names the gate can reject). Use it to answer 'will this verb be blocked?' BEFORE making the call, instead of discovering preconditions by tripping a 4xx. The response also carries a `taskCreation` block ({ enforcementMode, confidenceThreshold, templateModeEnabled, requiredFields[], taskTypeThresholds }): call it BEFORE task_create to learn whether task-template mode is on, which structured templateData fields this project requires, and the effective per-task-type confidence threshold ({ effectiveThreshold, thresholdSource } per type) so the per-type gate value is visible BEFORE the create, not only after.",
      inputShape: { projectId: uuid() },
      handler: async ({ projectId }) =>
        wrap(() => client.getProjectEffectiveGates(projectId)),
    }),
    def({
      name: "project_tasks",
      description:
        "Browse tasks scoped to a single project. Use this when you want to answer 'what is open in project X?' (a question task_pickup cannot answer on its own, since it returns one prioritized item, not a browsable list). " +
        "`project` accepts a slug ('agent-tasks') or a UUID; slugs are resolved mcp-server-side (TTL-cached, ~15 min, rc-v1-C006), no separate lookup call needed. An unresolvable slug is an unknown_project_slug teaching error whose recipe asks the operator for the correct slug or id (or, with AGENT_TASKS_MCP_LEGACY=1 set, call projects_list). " +
        "Filters (status, priority, labels, unclaimed) combine with AND semantics; status and priority accept either a single value or an array. limit defaults to unbounded on the backend, but clamps to 500 if supplied — pass an explicit limit when calling from an LLM harness so the response stays inside the tool-result token cap. " +
        "DEFAULT sort is `createdAt:desc` (newest tasks first) — pass `sort: \"createdAt:asc\"` to reverse it. Combined with a small `limit`, the default lets you fetch the N newest open tasks in a single call without blowing the tool-result token cap. " +
        "The response carries `nextCursor` (a task id, or null once the last page is reached) — pass it back as `cursor` to page forward; combined with `sort` + `id` as a tiebreaker, page order is stable even when many tasks share the same createdAt timestamp.",
      inputShape: {
        project: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe(
            "Slug or UUID; trimmed and length-capped (max 255), same input hygiene as task_create's project/projectSlug fields. A UUID-shaped value is routed straight to the id endpoint and never treated as a slug -- if this project's slug is itself UUID-shaped, it cannot be addressed via this field.",
          ),
        status: z
          .union([
            z.enum(["open", "in_progress", "review", "done", "abandoned", "backlog"]),
            z
              .array(z.enum(["open", "in_progress", "review", "done", "abandoned", "backlog"]))
              .min(1),
          ])
          .optional(),
        priority: z
          .union([priorityEnum, z.array(priorityEnum).min(1)])
          .optional(),
        labels: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
        unclaimed: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
        sort: z
          .enum(["createdAt:asc", "createdAt:desc"])
          .default("createdAt:desc")
          .describe(
            "Only `createdAt` is sortable. Default `createdAt:desc` (newest first) — matches this route's backend default, and is the recommended setting for browsing recently-triaged tasks under the token cap.",
          ),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Task id to page forward from — pass the previous call's `nextCursor`. Omit for the first page.",
          ),
      },
      handler: async ({ project, status, priority, labels, unclaimed, limit, sort, cursor }) => {
        try {
          return await wrap(() =>
            client.listProjectTasks(project, {
              status,
              priority,
              labels,
              unclaimed,
              limit,
              sort,
              cursor,
            }),
          );
        } catch (err) {
          // Same rc-v1-C006 mapping as task_create's own projectSlug path:
          // client.ts's resolver throws ProjectSlugNotFoundError (not an
          // AgentTasksApiError, so wrap() does not touch it) on a fresh
          // 404, translated here to the specific teaching error.
          if (err instanceof ProjectSlugNotFoundError) {
            throw new Error(serializeTeachingError(unknownProjectSlugError(err.slug, "project_tasks")));
          }
          throw err;
        }
      },
    }),
    def({
      name: "tasks_list",
      description:
        DEPRECATED +
        "List tasks. With no filters: claimable only (status=open, unclaimed) — for that single-prioritized-item case prefer task_pickup. " +
        "For 'what is open in project X' use project_tasks (the browse-scoped verb). " +
        "Pass status/priority/labels/claimedByAgentId/projectId to broaden the search; verbose=true switches to the full task payload " +
        "(default returns a summary projection without descriptions/comments to stay inside the harness's tool-result token cap). " +
        "claimedByAgentId='me' resolves to the calling agent's tokenId. Default limit 25. " +
        "DEFAULT sort is `createdAt:desc` (newest tasks first) — the backend API itself still defaults to `createdAt:asc` for backward compatibility, but this tool overrides that at the tool layer so calling with no `sort` returns the N most-recently-created tasks, not the oldest. Pass `sort: \"createdAt:asc\"` to get the old behavior back. " +
        "The response carries `nextCursor` (a task id, or null once the last page is reached) — pass it back as `cursor` to page forward through more results than fit in one call, instead of raising `limit` past the token cap.",
      inputShape: {
        limit: z.number().int().positive().max(200).optional(),
        projectId: uuid().optional(),
        status: z
          .union([
            z.enum(["open", "in_progress", "review", "done", "abandoned", "backlog"]),
            z.array(z.enum(["open", "in_progress", "review", "done", "abandoned", "backlog"])).min(1),
          ])
          .optional(),
        priority: z
          .union([priorityEnum, z.array(priorityEnum).min(1)])
          .optional(),
        labels: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
        claimedByAgentId: z.union([uuid(), z.literal("me")]).optional(),
        verbose: z.boolean().optional(),
        sort: z
          .enum(["createdAt:asc", "createdAt:desc"])
          .default("createdAt:desc")
          .describe(
            "Only `createdAt` is sortable. Default `createdAt:desc` (newest first) — a tool-layer override of the backend's `createdAt:asc` API default, so the N newest tasks are reachable in one call under the token cap.",
          ),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Task id to page forward from — pass the previous call's `nextCursor`. Omit for the first page.",
          ),
      },
      handler: async (args) =>
        wrap(() => client.listClaimableTasks(args)),
    }),
    def({
      name: "tasks_get",
      description:
        "Fetch a task by id. The modern read-verb surface (rc-v1-C006): task_start folds its own task-scoped slice of this into its receipt, but this is the general-purpose read. Returns a summary projection by default (id, title, status, priority, labels, claims, blockedBy, prUrl), pass include:[\"description\" | \"comments\" | \"artifacts\"] to add one field back, or include:[\"task\"] for the full, pre-contract object.",
      inputShape: { taskId: uuid(), include: readIncludeSchema },
      handler: async ({ taskId, include }) => {
        const response = await wrap(() => client.getTask(taskId));
        return projectTaskSummary(response as GetTaskResponse, include);
      },
    }),
    def({
      name: "tasks_instructions",
      description:
        DEPRECATED +
        "Fetch agent-facing instructions. v2 folds this into the task_start response. Response carries `confidence.inferredTaskType` (`bugfix | feature | refactoring | security | migration | docs`) when the task was created from a typed preset; future Milestone-2 work uses it to drive per-type required-signals + thresholds.",
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
        debugFlavor: z.boolean().optional(),
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
      handler: async ({ taskId }) => wrap(() => client.claimTask(taskId), "tasks_claim"),
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
        wrap(() => client.transitionTask(taskId, input), "tasks_transition"),
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
        // Symmetry with task_finish's own result field (same field, same
        // storage): uncapped here let a caller feed an arbitrarily large
        // string straight into looksLikeStructuredWrapper's tag-pair scan
        // before this cap was added (measured: 18,395ms on a 400k-char
        // adversarial input against the pre-cap guard alone).
        result: z.string().max(5000).nullable().optional(),
      },
      handler: async ({ taskId, ...input }) => {
        // Same pre-network guard as task_finish's own result field
        // (errors.ts catalog entry #8): tasks_update writes `result` the
        // same way the backend stores it, so the same XML/JSON-wrapper
        // mistake needs the same check here, not just on the v2 verb.
        if (typeof input.result === "string" && looksLikeStructuredWrapper(input.result)) {
          throw new Error(serializeTeachingError(resultMustBePlainStringError("tasks_update")));
        }
        return wrap(() => client.updateTask(taskId, input), "tasks_update");
      },
    }),
    def({
      name: "tasks_comment",
      description:
        "First-class alias of task_note (same behavior, v2 naming, including the receipt default). Kept in the default registration permanently for naming-convention compatibility; not part of rc-v1-C007's pruned legacy set.",
      inputShape: {
        taskId: uuid(),
        content: z.string().min(1).max(5000),
        include: includeSchema,
      },
      handler: async ({ taskId, content, include }) => {
        const response = await wrap(() => client.addTaskComment(taskId, content));
        if (include?.includes("task")) return response;
        return receiptForNote(taskId, response as NoteResponse);
      },
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
        `Signals are also delivered inline by task_pickup under v2; call this verb directly when you want to check the signal inbox without also claiming a task. Default limit ${SIGNALS_DEFAULT_LIMIT} (max ${SIGNALS_MAX_LIMIT}); when more are pending within the fetched batch the response carries truncated:true and a cursor (the last delivered signal's id). Pass it back as cursor on the next call to fetch the remainder. mcp-server always fetches up to ${SIGNALS_BACKEND_FETCH_LIMIT} pending signals from the backend per call (its own hard max; the backend has no cursor of its own). When the backend backlog is at or above that ceiling, the response also carries atBackendFetchCeiling:true: more signals may exist beyond what this call could see, even once truncated stops appearing, so ack what you have and poll again rather than assuming the backlog is drained. A cursor whose signal was acked or aged out of the backend's fetch window restarts from the oldest pending signal, so an occasional duplicate delivery is possible; treat acking as idempotent.`,
      inputShape: {
        limit: z
          .number()
          .int()
          .positive()
          .max(SIGNALS_MAX_LIMIT)
          .optional()
          .describe(`Max signals to return this call. Default ${SIGNALS_DEFAULT_LIMIT}.`),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Signal id to resume after — pass the previous call's cursor. Omit for the first page.",
          ),
      },
      handler: async ({ limit, cursor }) => {
        const response = await wrap(() => client.pollSignals(SIGNALS_BACKEND_FETCH_LIMIT));
        const all = (response as { signals?: RawSignal[] } | undefined)?.signals ?? [];
        return paginateSignals(all, { cursor, limit });
      },
    }),
    def({
      name: "signals_ack",
      description:
        "Acknowledge a signal fetched via signals_poll (signals delivered inline by task_pickup under v2 are acked atomically instead, no separate call needed).",
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
      handler: async (input) => wrap(() => client.createPullRequest(input), "pull_requests_create"),
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

  // rc-v1-C007: registration-time filter only. Every handler above stays
  // fully defined regardless of `options.legacy`; { legacy: true } is the
  // only thing that changes which of them end up in the returned array.
  return options?.legacy ? tools : tools.filter((t) => !LEGACY_VERB_NAMES.has(t.name));
}
