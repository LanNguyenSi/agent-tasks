// Central receipt layer for write-verb responses. Normative reference:
// docs/response-contract-v1.md. This is the "new responsibility at the
// choke point" the contract calls out for tools.ts's wrap() helper — this
// module is that responsibility, kept separate from wrap() itself so wrap()
// stays a pure error-mapping helper and the receipt projection stays
// independently testable.
//
// A receipt has three tiers layered in one object:
//   Tier 1 (confirm)   — always present, <= ~60 tokens.
//   Tier 2 (deviations) — present only when something needs the caller's
//                          attention, <= ~400 tokens.
//   Tier 3 (next)      — optional, 1-3 free-form hints, present only when
//                          there is an obvious follow-up call.
//
// Every verb's `include: ["task"]` valve returns the backend object
// verbatim, bypassing the tier machinery entirely — the old, pre-contract
// shape stays reachable unchanged. Most write verbs check this in their
// tools.ts handler before calling into this module at all; task_pickup's
// projectPickup and task_start's receiptForStart instead own the check
// themselves, since both verbs' `include` vocabulary is wider than the
// single "task" value the other write verbs accept, so the valve lives at
// the same layer as the rest of their include handling.

import {
  DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS,
  DEFAULT_WORKFLOW_TRANSITIONS,
} from "./default-workflow.js";

/** One entry in the Tier 2 `deviations` array. */
export interface Deviation {
  code: string;
  /** Present only where the caller can act on it (create/respec catalog). */
  detail?: Record<string, unknown>;
  /** Free text: what this means and what changes because of it, right now. */
  actNow?: string;
  /** Free-form hints, SHOULD lead with a verb name. Not machine-parseable. */
  next?: string[];
}

/** The full write-verb response shape, per docs/response-contract-v1.md. */
export interface Receipt {
  ok: true;
  task: { id: string; status?: string };
  /** Only present on an actual state change. */
  transition?: { from: string; to: string };
  /** Bare scalar. Only set by receiptForCreate / receiptForRespec in this
   *  layer — no other write verb carries confidence (actionable counter-rule:
   *  detail belongs only where the caller can act on it). */
  confidence?: number;
  /** Absent or empty on the happy path — report by exception. */
  deviations?: Deviation[];
  /** 1-3 free-form hints, not a menu. */
  next?: string[];
}

interface BuildReceiptOpts {
  taskId: string;
  status?: string;
  transition?: { from: string; to: string };
  confidence?: number;
  deviations?: Deviation[];
  next?: string[];
}

/** Low-level composer. Every receiptFor* builder below funnels through this
 *  so the tier layering (present/absent rules) lives in exactly one place. */
export function buildReceipt(opts: BuildReceiptOpts): Receipt {
  const receipt: Receipt = {
    ok: true,
    task:
      opts.status !== undefined
        ? { id: opts.taskId, status: opts.status }
        : { id: opts.taskId },
  };
  if (opts.transition) receipt.transition = opts.transition;
  if (opts.confidence !== undefined) receipt.confidence = opts.confidence;
  if (opts.deviations && opts.deviations.length > 0) receipt.deviations = opts.deviations;
  if (opts.next && opts.next.length > 0) receipt.next = opts.next;
  return receipt;
}

// ── Backend response shapes consumed here ───────────────────────────────────
//
// Minimal structural types for the fields this layer actually reads. The
// backend objects carry many more fields (title, description, templateData,
// comments, ...); the receipt intentionally never touches those beyond what
// is listed below, since a `task: {id, status}` projection is the whole
// point of the contract.

export interface BackendTask {
  id: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  labels?: string[];
  blockedBy?: { id: string }[];
}

export interface ConfidenceObj {
  score: number;
  threshold: number;
  enforcementMode: string | null;
  blocking?: boolean;
  missing?: string[];
  findings?: unknown[];
  nextActions?: unknown[];
}

// Shared clamp for every deviation's array-valued detail field (`missing[]`
// on CONFIDENCE_BELOW_THRESHOLD, `rejected[]` on DEPENDS_ON_REJECTED,
// `dropped[]` on LABELS_DROPPED, `skipped[]` on WORKFLOW_GATE_SKIPPED):
// first N entries plus an explicit total count, so a caller at the tail of
// a long list still learns "there were more" instead of the array being
// silently truncated with no signal. This is a contract-wide rule (see
// docs/response-contract-v1.md's "Detail arrays are clamped" paragraph),
// applied unconditionally so it holds without exceptions, even for fields
// (like `skipped[]`, bounded by the fixed set of workflow gates) that can
// never actually reach the clamp in practice.
export const DETAIL_CLAMP = 5;

// Per-entry byte bound layered on top of DETAIL_CLAMP. DETAIL_CLAMP alone
// only bounds array LENGTH: a caller-influenced string entering a detail
// array (today: LABELS_DROPPED's `dropped[]`, sourced from task_create's
// `labels` schema, each up to 100 chars per tools.ts inputShape) can still
// blow the tier-2 budget at its own declared maximum even with only 5
// entries kept, measured at 1731 emitted chars (already over the
// 1600-char cap) with an unbounded entry length, before this clamp existed.
//
// 19 is not a round guess, it is the largest value that clears the tier-2
// budget with real headroom at the worst case (all three array-bearing
// task_create deviations firing at once, each at its schema/backend
// maximum): measured via tests/receipt.test.ts's maxima test at each
// candidate value. 20 chars already regresses to 1551 (over budget), 19
// measures 1541 (comfortable margin below both the test's 1550 floor and
// the 1600 cap itself). 19 also happens to be exactly long enough that the
// backend's longest `missing[]` field name ("acceptanceCriteria", 19
// chars) never truncates; the 36-char dependsOn UUIDs still do truncate
// under this bound, since there is no room left for a higher,
// ID-preserving value once labels are at their real maximum. This is an
// accepted, visible (ends in "...") consequence of one shared per-entry
// bound applying uniformly to every future detector, not a special case
// per field.
export const ENTRY_CHAR_BUDGET = 19;

// Visible truncation marker: a shortened entry must not look complete, so
// the caller can tell at the string level (not just via the totalX count)
// that this particular entry was cut.
export const ENTRY_TRUNCATION_MARKER = "...";

/**
 * Byte-bounds a detail array by construction: caps the element COUNT (as
 * DETAIL_CLAMP alone already did) AND caps each surviving entry's own
 * length, so a future detector cannot blow the tier-2 budget just by
 * carrying long strings inside an already-short array. Truncation is never
 * silent: a shortened entry visibly ends with ENTRY_TRUNCATION_MARKER, and
 * the deviation's own totalX field already reports the untruncated
 * cardinality.
 *
 * Exported for reuse by read.ts (rc-v1-C006): tasks_get's summary
 * projection and the block-tier's client-side project-addressing errors
 * clamp their own arrays the same way, at their own (different) budgets, by
 * calling this shared helper rather than re-implementing the clamp+marker
 * logic a second time.
 */
export function clampEntries(
  values: string[],
  opts: { max?: number; entryChars?: number } = {},
): string[] {
  const max = opts.max ?? DETAIL_CLAMP;
  const entryChars = opts.entryChars ?? ENTRY_CHAR_BUDGET;
  return values.slice(0, max).map((v) =>
    v.length > entryChars
      ? v.slice(0, entryChars - ENTRY_TRUNCATION_MARKER.length) + ENTRY_TRUNCATION_MARKER
      : v,
  );
}

// ── task_create / task_respec: confidence deviation ─────────────────────────
//
// Trigger per the contract's create catalog: "confidence score is below the
// project's threshold" — this is `score < threshold`, deliberately NOT the
// backend's own `blocking` flag (backend/src/lib/confidence.ts: `blocking`
// is narrower, "a hard, threshold-INDEPENDENT keystone is violated"; using
// it here would under-report the contract's stated trigger).
function confidenceDeviation(c: ConfidenceObj | undefined): Deviation | null {
  if (!c || c.score >= c.threshold) return null;
  const missing = c.missing ?? [];
  return {
    code: "CONFIDENCE_BELOW_THRESHOLD",
    detail: {
      score: c.score,
      threshold: c.threshold,
      enforcementMode: c.enforcementMode,
      // Clamped like DEPENDS_ON_REJECTED/LABELS_DROPPED below: the backend
      // scorer (backend/src/lib/confidence.ts) can populate up to 9 entries
      // (title, description, goal, acceptanceCriteria, scope, outOfScope,
      // dependencies, risk, agentPrompt), already in surfacing-priority
      // order, so the clamp keeps the entries that matter most.
      missing: clampEntries(missing, { max: DETAIL_CLAMP, entryChars: ENTRY_CHAR_BUDGET }),
      totalMissing: missing.length,
    },
    // Kept short on purpose: at the missing[]/dependsOn/labels maxima, all
    // four task_create deviations firing together leaves little headroom
    // under the tier-2 cap (see the "clamps ... at the schemas' and
    // backend's declared maxima" test in tests/receipt.test.ts).
    actNow:
      c.enforcementMode === "BLOCK"
        ? "Description/templateData not editable after create except via task_respec; at BLOCK, task_pickup/task_start rejects until the score improves."
        : "Description/templateData not editable after create except via task_respec; not BLOCK, so advisory only for now.",
    next: ["task_respec to raise the score above the threshold"],
  };
}

// ── task_create: DEDUPED_EXTERNAL_REF ────────────────────────────────────────
//
// KNOWN GAP (see the implementer's summary / open_questions): the live
// backend (backend/src/routes/tasks.ts, POST /projects/:projectId/tasks)
// rejects a duplicate (projectId, externalRef) with an HTTP 409 P2002
// conflict BEFORE a task is created — it never returns 200 with the
// existing task, so this deviation cannot fire against the current backend.
// It is implemented here for contract-shape completeness (and is exercised
// in tests against a constructed 200 response) so it activates the moment
// the backend gains a soft dedupe-return, without another mcp-server change.
//
// Detection heuristic (the backend provides no explicit dedupe flag on a
// hypothetical 200 response): createdAt !== updatedAt. This is imperfect —
// an existing task that was never touched after its own creation would
// coincidentally have createdAt === updatedAt and be missed — but it is the
// best signal available without a backend change, per the task brief's
// explicit fallback ("createdAt != updatedAt or a backend flag").
//
// Scope gate: the contract's trigger for this deviation is "(projectId,
// externalRef) already exists", the dedupe is keyed on externalRef, so a
// create call that sent no externalRef at all cannot have hit that path,
// regardless of what the createdAt/updatedAt heuristic says. Callers that
// omit externalRef must never see this code.
function dedupedExternalRefDeviation(
  task: BackendTask,
  externalRef: string | undefined,
): Deviation | null {
  if (!externalRef) return null;
  if (!task.createdAt || !task.updatedAt) return null;
  if (task.createdAt === task.updatedAt) return null;
  return {
    code: "DEDUPED_EXTERNAL_REF",
    detail: { existingTaskId: task.id, existingStatus: task.status },
    next: ["tasks_get"],
  };
}

// Both DEPENDS_ON_REJECTED and LABELS_DROPPED echo a slice of the caller's
// own input back in `detail`. Both schema fields have generous array
// maxima (dependsOn 50, labels 20; see tools.ts's task_create inputShape),
// and at those maxima an unclamped detail array alone blows past the
// tier-2 budget several times over. They reuse DETAIL_CLAMP (defined above,
// next to ConfidenceObj) for the same reason CONFIDENCE_BELOW_THRESHOLD's
// `missing[]` does.

// ── task_create: DEPENDS_ON_REJECTED ─────────────────────────────────────────
//
// KNOWN GAP: the live backend validates `dependsOn` before insert and 400s
// the WHOLE create request if any id is missing/cross-project (tasks.ts
// ~lines 795-813) rather than creating the task with the valid subset and
// reporting the rejected ids as a deviation. On today's backend this
// comparison can only ever find zero missing ids on a successful create
// (all-or-nothing), so this detector is inert in production until/unless
// the backend adopts a soft-accept model. Implemented + tested against a
// constructed response for contract-shape completeness (see above).
function dependsOnRejectedDeviation(
  sentDependsOn: string[] | undefined,
  blockedBy: { id: string }[] | undefined,
): Deviation | null {
  if (!sentDependsOn || sentDependsOn.length === 0) return null;
  const present = new Set((blockedBy ?? []).map((b) => b.id));
  const rejectedIds = sentDependsOn.filter((id) => !present.has(id));
  if (rejectedIds.length === 0) return null;
  return {
    code: "DEPENDS_ON_REJECTED",
    detail: {
      // Every rejected id shares the same reason today (the backend gives
      // no per-id detail), so the reason is hoisted out of the array
      // instead of repeated per entry: that repetition was itself most
      // of the bloat this clamp fixes.
      rejected: clampEntries(rejectedIds, { max: DETAIL_CLAMP, entryChars: ENTRY_CHAR_BUDGET }),
      reason: "not found or cross-project",
      totalRejected: rejectedIds.length,
    },
    next: ["task_create again with corrected dependsOn"],
  };
}

// ── task_create: LABELS_DROPPED ──────────────────────────────────────────────
//
// KNOWN GAP: the live backend stores `labels` verbatim (trimmed by zod, but
// not deduped/normalized/soft-rejected) — see createTaskSchema in
// backend/src/routes/tasks.ts. No label is ever silently dropped today, so
// this detector is inert in production until/unless the backend adopts
// normalization or a per-label rejection policy. Implemented + tested
// against a constructed response for contract-shape completeness.
function labelsDroppedDeviation(
  sentLabels: string[] | undefined,
  responseLabels: string[] | undefined,
): Deviation | null {
  if (!sentLabels || sentLabels.length === 0) return null;
  const present = new Set(responseLabels ?? []);
  const dropped = sentLabels.filter((l) => !present.has(l));
  if (dropped.length === 0) return null;
  return {
    code: "LABELS_DROPPED",
    detail: {
      dropped: clampEntries(dropped, { max: DETAIL_CLAMP, entryChars: ENTRY_CHAR_BUDGET }),
      totalDropped: dropped.length,
    },
    next: ["task_create again (agents cannot set labels post-create)"],
  };
}

// ── Per-verb receipt builders ────────────────────────────────────────────────
//
// Defensive guard shared by every builder below: each one is fed a `response`
// that arrived through an `as` cast in tools.ts (the real runtime shape is
// only as trustworthy as the backend's success body). Dereferencing
// `response.task.id` without checking first throws a raw, unhelpful
// TypeError on a malformed body. Every builder therefore checks
// `response?.task?.id` up front and, when it's missing, returns the raw
// response unprojected instead of crashing: the caller still gets
// something machine-usable, just not the small receipt. This is a
// deliberate, documented exemption from the contract's "no echo, ever"
// rule (docs/response-contract-v1.md): a malformed success body falls
// outside the receipt/tier machinery entirely, so returning it raw is not
// an echo of caller-sent content, it's the only fallback that avoids
// crashing on an unexpected backend shape.
function hasTaskId(response: { task?: { id?: string } } | null | undefined): boolean {
  return !!response?.task?.id;
}

export interface CreateOrRespecResponse {
  task: BackendTask;
  confidence?: ConfidenceObj;
}

export function receiptForCreate(
  response: CreateOrRespecResponse,
  input: { labels?: string[]; dependsOn?: string[]; externalRef?: string },
): Receipt | CreateOrRespecResponse {
  if (!hasTaskId(response)) return response;
  const deviations: Deviation[] = [];
  const confDev = confidenceDeviation(response.confidence);
  if (confDev) deviations.push(confDev);
  const dedupeDev = dedupedExternalRefDeviation(response.task, input.externalRef);
  if (dedupeDev) deviations.push(dedupeDev);
  const dependsOnDev = dependsOnRejectedDeviation(input.dependsOn, response.task.blockedBy);
  if (dependsOnDev) deviations.push(dependsOnDev);
  const labelsDev = labelsDroppedDeviation(input.labels, response.task.labels);
  if (labelsDev) deviations.push(labelsDev);

  // v1 backlog routing (backend/src/routes/tasks.ts): every agent-created
  // task lands in `backlog`, not `open` -- "task_start to begin work on
  // this task" would be actively wrong advice here (task_start 403s with
  // backlog_not_promoted until an operator promotes it), so a backlog task
  // gets its own next hint instead, regardless of whether any deviation
  // also fired.
  const next =
    response.task.status === "backlog"
      ? ["awaits operator promotion; task_start rejects a backlog task until an operator promotes it to open"]
      : deviations.length === 0
        ? ["task_start to begin work on this task"]
        : undefined;

  return buildReceipt({
    taskId: response.task.id,
    status: response.task.status,
    confidence: response.confidence?.score,
    deviations,
    next,
  });
}

export function receiptForRespec(response: CreateOrRespecResponse): Receipt | CreateOrRespecResponse {
  if (!hasTaskId(response)) return response;
  const deviations: Deviation[] = [];
  const confDev = confidenceDeviation(response.confidence);
  if (confDev) deviations.push(confDev);

  return buildReceipt({
    taskId: response.task.id,
    status: response.task.status,
    confidence: response.confidence?.score,
    deviations,
  });
}

export interface FinishResponse {
  kind: "work" | "review";
  task: BackendTask;
  targetStatus?: string;
  outcome?: string;
  autoMergeSha?: string;
  skippedGates?: string[];
}

// task_finish: `transition.from` would require either an extra pre-fetch
// (defeats the whole point of the receipt) or hardcoding a "from" state that
// varies per custom workflow (finish resolves its pre/post states via
// resolveEffectiveDefinition, not literal status strings) — so it is
// deliberately omitted here; `task.status` alone reports the outcome. The
// one deviation this verb DOES carry is grounded in a real backend field:
// `skippedGates`, populated when autoMerge skips the normally-required
// `prMerged` precondition (tasks.ts work/review/self-approve branches all
// echo it back verbatim when non-empty).
export function receiptForFinish(response: FinishResponse): Receipt | FinishResponse {
  if (!hasTaskId(response)) return response;
  const deviations: Deviation[] = [];
  if (response.skippedGates && response.skippedGates.length > 0) {
    deviations.push({
      code: "WORKFLOW_GATE_SKIPPED",
      detail: {
        // Clamped like every other deviation's array-valued detail field
        // (see DETAIL_CLAMP above), even though the fixed set of workflow
        // gates (branchPresent, prPresent, ciGreen, prMerged) means this
        // can never actually reach 5 entries today. The point is that the
        // clamping rule holds unconditionally, not just where it currently
        // bites.
        skipped: clampEntries(response.skippedGates, { max: DETAIL_CLAMP, entryChars: ENTRY_CHAR_BUDGET }),
        totalSkipped: response.skippedGates.length,
      },
      actNow: `autoMerge bypassed the normally-required workflow gate(s) before this transition: ${response.skippedGates.join(", ")}.`,
    });
  }
  return buildReceipt({
    taskId: response.task.id,
    status: response.task.status,
    deviations,
  });
}

export interface SubmitPrResponse {
  kind: "submit_pr";
  task: BackendTask;
}

// task_submit_pr: the contract's "Known catalogs to fill in" table lists
// "unmet workflow gates" for this verb, but the live backend performs NO
// gate evaluation at submit-pr time (see the block comment directly above
// the route in backend/src/routes/tasks.ts: "No gate evaluation — that
// happens on the next task_finish call") — there is no backend signal to
// detect it from without either an extra `projects_get_effective_gates`
// round trip (defeats the budget goal) or duplicating the backend's gate
// engine client-side (out of scope). No deviation catalog is implemented
// for this verb; see open_questions in the implementer's report.
export function receiptForSubmitPr(response: SubmitPrResponse): Receipt | SubmitPrResponse {
  if (!hasTaskId(response)) return response;
  return buildReceipt({
    taskId: response.task.id,
    status: response.task.status,
    next: ["task_finish once CI is green"],
  });
}

export interface MergeResponse {
  task: BackendTask;
  merged: boolean;
  sha?: string | null;
  alreadyMerged?: boolean;
}

// task_merge: no `transition` field. The route admits both `review` and an
// idempotent `done` retry as valid starting states (tasks.ts ~lines
// 3697-3700), and `alreadyMerged` describes the GitHub PR's own merge
// state (github-merge.ts ~lines 158-161), not whether a DB transition
// happened on THIS call: a PR merged out-of-band via the GitHub UI can
// leave the task at `review`, and a subsequent task_merge call both gets
// `alreadyMerged: true` from GitHub AND performs a real review→done
// transition in the DB. Keying `transition` off `alreadyMerged` would
// therefore report a fabricated transition in that case (and a missing one
// on the true idempotent retry, where it happens to be correct by
// coincidence). `task.status` alone reports the outcome; it needs no
// inference.
export function receiptForMerge(response: MergeResponse): Receipt | MergeResponse {
  if (!hasTaskId(response)) return response;
  return buildReceipt({
    taskId: response.task.id,
    status: response.task.status,
  });
}

export interface AbandonResponse {
  task: BackendTask;
}

export function receiptForAbandon(response: AbandonResponse): Receipt | AbandonResponse {
  if (!hasTaskId(response)) return response;
  return buildReceipt({
    taskId: response.task.id,
    status: response.task.status,
  });
}

export interface NoteResponse {
  comment?: { taskId?: string };
}

// task_note / tasks_comment: the backend's POST /tasks/:id/comments returns
// only `{comment}` — there is no `task` object and no `status` field on the
// comment row, so `task.status` is genuinely unknown without an extra GET
// (which would double the round trip for the cheapest verb in the surface).
// The receipt therefore carries `task.id` only, sourced from the response's
// `comment.taskId` when present (falling back to the caller's own taskId,
// which is safe to surface: the no-echo rule throughout this module targets
// CONTENT the caller sent (description, templateData, comment body, and
// so on), not correlation ids. Every other receipt in this module already
// carries `task.id` unconditionally).
export function receiptForNote(taskId: string, response: NoteResponse): Receipt {
  return buildReceipt({ taskId: response.comment?.taskId ?? taskId });
}

// ── task_start: receipt + per-task slice ────────────────────────────────────
//
// docs/response-contract-v1.md's per-verb defaults table lists task_start's
// default as "receipt only", but the contract also says task_start needs
// enough for the caller to act without a second round trip. rc-v1-C003
// implements that as the C002-style receipt PLUS a small, task-specific
// slice: inferredTaskType, expectedFinishState, and gateExpectations. None
// of it is the caller's own request content (no-echo is satisfied), and none
// of it is the large, rarely-changing static material (full task payload,
// comments, description, per-state instructions prose) the contract wants
// out of the default path — that material stays reachable via `include`
// (see the per-verb include enum in tools.ts) or, for the truly static
// prose, in default-workflow.ts's exported constants (the rc-v1-C004
// handover point).

export interface StartWorkflowDefinition {
  states?: { name: string; agentInstructions?: string }[];
  transitions?: { from: string; to: string; requires?: string[] }[];
}

export interface StartTask extends BackendTask {
  // Plain scalar columns, always present on the raw response regardless of
  // `include` (only relations need an explicit include) — see the KNOWN GAP
  // comment on deriveGateExpectations for why `workflow` itself is the
  // exception.
  workflowId?: string | null;
  templateData?: { taskType?: unknown } | null;
  description?: string | null;
  comments?: unknown[];
  // KNOWN GAP: the live backend's POST /tasks/:id/start includes this
  // relation on BOTH sub-paths of the review-claim branch (backend/src/
  // routes/tasks.ts): the handler's initial `findUnique` already has
  // `workflow: true` and is reused as-is when the caller is already the
  // current reviewer (no re-claim write needed); a fresh review-claim
  // re-fetches with the same `workflow: true` include. The far more common
  // work-claim branch (open -> in_progress) re-fetches through the
  // narrower `taskInclude` after its `updateMany`, which does NOT include
  // `workflow`. When absent, deriveGateExpectations/deriveStartInstructions
  // fall back to the static default-workflow.ts mirror instead of guessing.
  workflow?: { definition?: StartWorkflowDefinition } | null;
}

export interface StartGroundingHint {
  debugFlavor: true;
  recommendedAction: string;
  mcpToolHint: string;
  // Phase 2 only (a real grounding session was started server-side).
  backendSessionRef?: string;
  currentPhase?: string;
  mandatorySequence?: string[];
  activeGuardrails?: string[];
}

/**
 * Backend field since rc-v1-B001 (PR #445): the gates configured on the
 * edge(s) this call's caller will hit next on a subsequent task_finish,
 * resolved server-side from the SAME effectiveDefinition already used to
 * gate the claim itself (backend/src/routes/tasks.ts's
 * gatesForTransitionOrNull), authoritative over this module's own
 * client-side approximation (deriveGateExpectations below), which is now a
 * fallback for backends that predate this field (see
 * resolveGateExpectations). `null` means the edge itself is absent (the
 * corresponding finish call will 400 with no_transition); `[]` means the
 * edge exists with nothing required. This distinction MUST NOT be
 * collapsed: see gatesForTransitionOrNull's own doc comment for why a
 * workflow that drops one edge while keeping another makes `[]` and `null`
 * mean genuinely different things for the caller.
 */
export interface StartEffectiveGates {
  finish: string[] | null;
  /** Review-claim only: previews the "request_changes" outcome's edge, a
   *  DIFFERENT edge than `finish` (which previews "approve" on a review
   *  claim, see backend/src/routes/tasks.ts's review-claim branch). Absent
   *  on a work-claim response, which has only one relevant edge. */
  requestChanges?: string[] | null;
}

export interface StartResponse {
  kind: "work" | "review";
  task: StartTask;
  expectedFinishState?: string;
  groundingHint?: StartGroundingHint;
  project?: unknown;
  // KNOWN GAP: not present on the live backend's /start success response
  // today (the confidence gate discards its computed score once the claim
  // is allowed — see backend/src/services/confidence-gate.ts). Read
  // defensively, in case a future backend change starts returning it,
  // matching the "actionable counter-rule": task_start cannot change the
  // spec, so only the bare scalar belongs here, never `missing[]`/detail.
  confidence?: { score: number };
  /** Since rc-v1-B001. See StartEffectiveGates. Declared optional (`?:`),
   *  not required, so a pre-B001 backend response is still a valid
   *  StartResponse: resolveGateExpectations reads this defensively and
   *  falls back to deriveGateExpectations when it is absent. */
  effectiveGates?: StartEffectiveGates;
  /** Since rc-v1-B001: task status immediately before this call, the real
   *  transition.from, not a guess. On a work claim this is the state the
   *  task was in before the claim (e.g. "open"); on a review claim it
   *  equals the current task.status ("review"), since review-claiming does
   *  not itself transition status (backend/src/routes/tasks.ts's
   *  review-claim branch comment). Absent on a pre-B001 backend, in which
   *  case StartSlice.transition is simply omitted, no guess is made. */
  previousStatus?: string;
}

export interface StartSlice {
  ok: true;
  task: { id: string; status?: string };
  /** Only present on an actual state change (response.previousStatus !==
   *  response.task.status), the same "only on a state change" rule the
   *  general Receipt.transition field follows (docs/response-contract-v1.md).
   *  Absent on a review-claim start (task.status stays "review", so
   *  previousStatus equals it), and absent entirely against a pre-rc-v1-B001
   *  backend that does not send `previousStatus`, no guess is made. */
  transition?: { from: string; to: string };
  /** Bare scalar only — see the KNOWN GAP note on StartResponse.confidence. */
  confidence?: number;
  /** Derived from task.templateData.taskType (the same source
   *  backend/src/lib/confidence.ts's own inferredTaskType uses), not echoed
   *  from the caller's own request (taskType is set once, at task_create
   *  time, by whoever created the task — not by this call's caller). */
  inferredTaskType?: string;
  /** On a work claim, this names the SAME edge `gateExpectations` previews
   *  (startTarget -> expectedFinishState). On a review claim, it does NOT:
   *  it names the definition-wide work-finish target (what an author's
   *  task_finish would target on this task), while `gateExpectations`
   *  previews the review -> approveTarget edge (the "approve" outcome), a
   *  different edge, resolved from the backend's own
   *  `expectedFinishStateFromDefinition` vs `approveTarget` (see
   *  backend/src/routes/tasks.ts's review-claim branch). A review-claim
   *  receipt like `{ expectedFinishState: "review", gateExpectations: null
   *  }` therefore means the approve edge is absent, NOT that this field's
   *  own named state is unreachable; do not pair the two fields as if they
   *  describe the same transition on a review claim. */
  expectedFinishState?: string;
  /** The `requires` gate list for the edge task_finish will hit next: on a
   *  work claim, the single startTarget -> expectedFinishState edge; on a
   *  review claim, the "approve" edge (see requestChangesGateExpectations
   *  for the review claim's other outcome). Sourced from the backend's
   *  authoritative `effectiveGates.finish` (rc-v1-B001) when present, via
   *  resolveGateExpectations; falls back to deriveGateExpectations'
   *  dynamic-vs-static-fallback resolution only against a pre-B001 backend.
   *  `null` = the edge does not exist (finish will 400 with no_transition);
   *  omitted = either the edge exists with nothing required, or (fallback
   *  path only) no data was derivable at all: see resolveGateExpectations
   *  and projectGateList for the exact collapse rule. */
  gateExpectations?: string[] | null;
  /** Present only alongside `gateExpectations`, only when it came from the
   *  pre-B001 fallback (deriveGateExpectations' static default-workflow.ts
   *  table) rather than the backend's own authoritative `effectiveGates`.
   *  A `null` `task.workflowId` does NOT prove the built-in default
   *  workflow governs this task — it can also mean a project-default
   *  customized Workflow row applies (see the KNOWN GAP note on
   *  deriveGateExpectations) — so this marks the gate list as an assumption
   *  the caller should not treat as authoritative. Never set when
   *  `effectiveGates` was present on the response: the backend's own value
   *  needs no such caveat. */
  gateExpectationsSource?: "assumed-default-workflow";
  /** Review-claim only: the `requires` gate list for the "request_changes"
   *  outcome's edge, sourced exclusively from the backend's
   *  `effectiveGates.requestChanges` (rc-v1-B001); there is no client-side
   *  fallback derivation for this edge (the pre-B001 code never computed it
   *  at all), so on a pre-B001 backend this field is simply absent, never
   *  guessed, and carries no separate "source" marker. Same null-vs-omitted
   *  rule as `gateExpectations`. */
  requestChangesGateExpectations?: string[] | null;
  next?: string[];
  // ── include-gated fields (tools.ts's task_start includeSchema) ──────────
  description?: string;
  comments?: unknown[];
  instructions?: string;
  /** Same provenance rule as gateExpectationsSource: present only when the
   *  prose came from the static default-workflow.ts fallback (null
   *  workflowId), which does not prove the built-in default governs this
   *  task. See deriveStartInstructions. */
  instructionsSource?: "assumed-default-workflow";
}

function deriveInferredTaskType(task: StartTask): string | undefined {
  const taskType = task.templateData?.taskType;
  return typeof taskType === "string" && taskType.length > 0 ? taskType : undefined;
}

interface GateExpectationsResult {
  gates?: string[];
  /** Set only when `gates` came from the static default-workflow.ts
   *  fallback table (see the "Static fallback" section below), never on
   *  the dynamic path. */
  source?: "assumed-default-workflow";
}

/**
 * Resolves the `requires` gate list for task.status -> expectedFinishState
 * WITHOUT the backend's rc-v1-B001 `effectiveGates` field. Called only by
 * resolveGateExpectations below, and only when `response.effectiveGates` is
 * absent (a pre-B001 backend); on any backend that sends it,
 * `effectiveGates` is authoritative (it is resolved server-side from the
 * exact same effectiveDefinition this function can only approximate
 * client-side) and this function is never consulted. Kept for that
 * version-tolerance case only; its own KNOWN GAPs below are pre-existing
 * and unrelated to that gating.
 *
 * Dynamic path: when the raw response embeds `task.workflow.definition`
 * (today: both sub-paths of the review-claim branch of POST
 * /tasks/:id/start — see the KNOWN GAP on StartTask.workflow above), it is
 * authoritative for this project and takes priority.
 *
 * Static fallback: `task.workflowId === null` does NOT prove the task runs
 * the built-in default workflow. Per the backend's resolveEffectiveDefinition
 * chain (backend/src/services/default-workflow.ts, ADR-0008 §50-56):
 *   1. task.workflowId set -> that Workflow row's definition (the dynamic
 *      path above, when embedded).
 *   2. a project-default Workflow row (isDefault: true, looked up by
 *      projectId) -> a CUSTOMIZED workflow that a project admin created via
 *      POST /projects/:projectId/workflow/customize. Tasks governed by this
 *      row still carry `workflowId === null`, and its gate structure can
 *      differ from the built-in table below.
 *   3. the built-in defaultWorkflowDefinition() -> what DEFAULT_WORKFLOW_
 *      TRANSITIONS mirrors.
 * `workflowId === null` is therefore consistent with EITHER step 2 or step
 * 3, and this function cannot distinguish them without the embedded
 * definition. Falling back to the built-in table is an assumption, not a
 * guarantee, so the result carries `source: "assumed-default-workflow"`
 * whenever it fires, so the caller can tell the gate list is unconfirmed.
 *
 * A non-null `workflowId` without an embedded `workflow` relation means a
 * CUSTOM workflow governs this task but its definition was not sent —
 * guessing its gates from the default table would be actively wrong, so
 * gates is omitted (no source marker either) rather than guessed in that
 * case.
 */
function deriveGateExpectations(
  task: StartTask,
  expectedFinishState: string | undefined,
): GateExpectationsResult {
  if (!expectedFinishState || !task.status) return {};

  const dynamicTransitions = task.workflow?.definition?.transitions;
  if (dynamicTransitions) {
    const match = dynamicTransitions.find(
      (t) => t.from === task.status && t.to === expectedFinishState,
    );
    const gates = match?.requires && match.requires.length > 0 ? match.requires : undefined;
    return gates ? { gates } : {};
  }

  if (task.workflowId) return {}; // custom workflow, definition not sent: do not guess

  const fallback = DEFAULT_WORKFLOW_TRANSITIONS[task.status]?.find(
    (t) => t.to === expectedFinishState,
  );
  const gates = fallback?.requires && fallback.requires.length > 0 ? fallback.requires : undefined;
  return gates ? { gates, source: "assumed-default-workflow" } : {};
}

/**
 * Maps a raw backend gate list (`string[] | null`) to StartSlice's
 * convention: `null` (the edge is absent) passes through unchanged, exactly
 * the value that must stay distinguishable from "no requires" per
 * rc-v1-B001's contract (see StartEffectiveGates); a non-empty array
 * passes through unchanged, and an empty array (edge exists, nothing
 * required) collapses to `undefined` so the happy, nothing-to-report case
 * costs no bytes in the receipt (report-by-exception, same rationale the
 * pre-existing fallback logic already applied to its own gate lists).
 */
function projectGateList(gates: string[] | null | undefined): string[] | null | undefined {
  if (gates === undefined || gates === null) return gates;
  return gates.length > 0 ? gates : undefined;
}

/**
 * Resolves task_start's three gate-expectation slice fields
 * (gateExpectations, gateExpectationsSource, requestChangesGateExpectations)
 * from the raw response. Two paths:
 *
 *   Authoritative (rc-v1-B001+): `response.effectiveGates.finish` is
 *   present (checked as `!== undefined`, not truthiness of the parent
 *   `effectiveGates` object, since `finish` is the field this layer
 *   actually consumes and can legitimately BE `null`, `[]`, or a non-empty
 *   array while still being "present"; a malformed/partial backend body
 *   that sends `effectiveGates: {}` with no `finish` key at all must fall
 *   through to the client-side fallback below instead of silently
 *   resolving to "nothing required" with no provenance marker). `finish`
 *   (and, on a review claim, `requestChanges`) are passed through
 *   projectGateList as-is, with no gateExpectationsSource, since the
 *   backend's own value needs no "assumed" caveat.
 *
 *   Fallback (pre-B001 backends, or a present-but-partial `effectiveGates`
 *   missing its own `finish` key): deriveGateExpectations' existing
 *   dynamic-then-static resolution runs unchanged for `finish`. There is no
 *   fallback for `requestChanges` at all (the pre-B001 code never computed
 *   it), so it is always omitted on this path.
 */
function resolveGateExpectations(response: StartResponse): {
  finish?: string[] | null;
  finishSource?: "assumed-default-workflow";
  requestChanges?: string[] | null;
} {
  if (response.effectiveGates?.finish !== undefined) {
    return {
      finish: projectGateList(response.effectiveGates.finish),
      requestChanges: projectGateList(response.effectiveGates.requestChanges),
    };
  }
  const { gates, source } = deriveGateExpectations(response.task, response.expectedFinishState);
  return { finish: gates, finishSource: source };
}

/**
 * Same dynamic-then-static resolution as deriveGateExpectations, for the
 * per-state instructions prose instead of the per-edge gate list — and the
 * SAME provenance rule. An embedded `workflow.definition.states` entry is
 * authoritative and carries no marker. A set `task.workflowId` without an
 * embedded definition means a task-level custom workflow whose prose we do
 * not have: omitted outright, never guessed (wrong instructions read as
 * authoritative are actively harmful — they can tell an agent to do the
 * wrong thing next). A `null` `workflowId` does NOT prove the built-in
 * default (a project-default customized Workflow row can apply, see
 * deriveGateExpectations' KNOWN GAP), so the static built-in prose is
 * surfaced WITH `instructionsSource: "assumed-default-workflow"` — correct
 * for the common built-in case, honestly labeled for the customized one.
 * Recovery path when instructions are omitted: the `tasks_instructions`
 * verb (GET /tasks/:id/instructions) — NOT include:["task"], because the
 * work-claim raw response never embeds the workflow relation either.
 */
function deriveStartInstructions(task: StartTask): {
  text?: string;
  source?: "assumed-default-workflow";
} {
  const dynamicState = task.workflow?.definition?.states?.find((s) => s.name === task.status);
  if (dynamicState?.agentInstructions) return { text: dynamicState.agentInstructions };
  if (task.workflowId) return {}; // custom workflow, definition not sent: do not guess wrong prose
  if (!task.status) return {};
  const text = DEFAULT_WORKFLOW_AGENT_INSTRUCTIONS[task.status];
  return text ? { text, source: "assumed-default-workflow" } : {};
}

/**
 * Compacts a debugFlavor groundingHint down to its actionable part: the
 * callable recipe (`mcpToolHint`) alone. `backendSessionRef` is deliberately
 * dropped from this string entirely, not merely de-prioritized: per
 * GroundingHint's own doc comment in backend/src/lib/debug-flavor.ts, that
 * field is named "backendSessionRef" (not "sessionId") specifically because
 * it is NOT usable as a grounding-mcp sessionId — appending it into the
 * actionable `next[]` string would present a value the caller cannot
 * actually pass to any grounding-mcp tool as if it were one. `mcpToolHint`
 * already carries a self-sufficient recipe on its own. `backendSessionRef`
 * remains reachable via include:["task"] for forensic/debugging purposes;
 * it just does not belong in the actionable hint. Also deliberately drops
 * `recommendedAction` (a restated sentence, not an action), `currentPhase`,
 * `mandatorySequence`, and `activeGuardrails` (verbose, not actionable for
 * THIS call) — the full hint remains reachable via include:["task"]. This is
 * also where `metadata.groundingSessionState` (the large persisted session
 * blob) is kept OUT of the default response: this function never reads
 * `metadata` at all, only the already-compact `groundingHint` field.
 */
function deriveGroundingNext(hint: StartGroundingHint | undefined): string[] | undefined {
  if (!hint) return undefined;
  return [hint.mcpToolHint];
}

export function receiptForStart(
  response: StartResponse,
  include?: readonly string[],
): StartSlice | StartResponse {
  // Compatibility valve: bypasses the tier machinery entirely, same as
  // projectPickup's own include:["task"] check for task_pickup. Checked
  // first, unconditionally, regardless of whether `response` even carries
  // a task.id — the caller asked for the raw object back.
  if (include?.includes("task")) return response;
  if (!hasTaskId(response)) return response;

  const slice: StartSlice = {
    ok: true,
    task:
      response.task.status !== undefined
        ? { id: response.task.id, status: response.task.status }
        : { id: response.task.id },
  };
  // Same "only on a state change" rule as the general Receipt.transition
  // field (docs/response-contract-v1.md): a review-claim's previousStatus
  // equals its (unchanged) task.status, so no transition is reported there.
  // Absent entirely against a pre-rc-v1-B001 backend (previousStatus
  // undefined), no guess is made.
  if (
    response.previousStatus !== undefined &&
    response.task.status !== undefined &&
    response.previousStatus !== response.task.status
  ) {
    slice.transition = { from: response.previousStatus, to: response.task.status };
  }
  if (response.confidence?.score !== undefined) slice.confidence = response.confidence.score;
  const inferredTaskType = deriveInferredTaskType(response.task);
  if (inferredTaskType) slice.inferredTaskType = inferredTaskType;
  if (response.expectedFinishState) slice.expectedFinishState = response.expectedFinishState;
  const {
    finish: gateExpectations,
    finishSource: gateExpectationsSource,
    requestChanges: requestChangesGateExpectations,
  } = resolveGateExpectations(response);
  if (gateExpectations !== undefined) slice.gateExpectations = gateExpectations;
  if (gateExpectationsSource) slice.gateExpectationsSource = gateExpectationsSource;
  if (requestChangesGateExpectations !== undefined) {
    slice.requestChangesGateExpectations = requestChangesGateExpectations;
  }
  const next = deriveGroundingNext(response.groundingHint);
  if (next) slice.next = next;

  if (include?.includes("description") && response.task.description) {
    slice.description = response.task.description;
  }
  if (include?.includes("comments") && response.task.comments) {
    slice.comments = response.task.comments;
  }
  if (include?.includes("instructions")) {
    const { text: instructions, source: instructionsSource } = deriveStartInstructions(
      response.task,
    );
    if (instructions) slice.instructions = instructions;
    if (instructionsSource) slice.instructionsSource = instructionsSource;
  }

  return slice;
}

// ── task_pickup: full spec, without comments (the contract's deliberate
// exception — see docs/response-contract-v1.md's "Receipt shape for write
// verbs" section) ────────────────────────────────────────────────────────
//
// Every kind task_pickup can return ("signal" | "review" | "work" | "idle")
// passes through unchanged except that a "review"/"work" kind's `task.
// comments` array is stripped by default. include:["comments"] or
// include:["task"] both restore the untouched raw response — see
// tools.ts's pickupIncludeSchema and the "both reach the same content for
// this verb" test in tests/receipt.test.ts for why two enum values map to
// one behavior here (uniform "task" escape hatch across every verb, plus
// forward compatibility with the read-verb `include` vocabulary landing in
// rc-v1-C006).
export interface PickupResponse {
  kind: "signal" | "review" | "work" | "idle";
  task?: { comments?: unknown[]; [key: string]: unknown };
  signal?: unknown;
  groundingHint?: unknown;
}

export function projectPickup(
  response: PickupResponse,
  include?: readonly string[],
): PickupResponse {
  if (include?.includes("task") || include?.includes("comments")) return response;
  if (!response.task || !("comments" in response.task)) return response;
  const { comments: _comments, ...taskWithoutComments } = response.task;
  return { ...response, task: taskWithoutComments };
}
