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
// Every verb's `include: ["task"]` valve bypasses this module entirely and
// returns the backend object verbatim (see the per-verb handlers in
// tools.ts) — the old projection path stays reachable, unchanged.

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

// ── task_create / task_respec: confidence deviation ─────────────────────────
//
// Trigger per the contract's create catalog: "confidence score is below the
// project's threshold" — this is `score < threshold`, deliberately NOT the
// backend's own `blocking` flag (backend/src/lib/confidence.ts: `blocking`
// is narrower, "a hard, threshold-INDEPENDENT keystone is violated"; using
// it here would under-report the contract's stated trigger).
function confidenceDeviation(c: ConfidenceObj | undefined): Deviation | null {
  if (!c || c.score >= c.threshold) return null;
  return {
    code: "CONFIDENCE_BELOW_THRESHOLD",
    detail: {
      score: c.score,
      threshold: c.threshold,
      enforcementMode: c.enforcementMode,
      missing: c.missing ?? [],
    },
    actNow:
      c.enforcementMode === "BLOCK"
        ? "Description and templateData are not editable after create except via task_respec; at BLOCK enforcement, task_pickup/task_start will reject this task until the score improves."
        : "Description and templateData are not editable after create except via task_respec; enforcementMode is not BLOCK, so this is advisory only for now.",
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
function dedupedExternalRefDeviation(task: BackendTask): Deviation | null {
  if (!task.createdAt || !task.updatedAt) return null;
  if (task.createdAt === task.updatedAt) return null;
  return {
    code: "DEDUPED_EXTERNAL_REF",
    detail: { existingTaskId: task.id, existingStatus: task.status },
    next: ["tasks_get"],
  };
}

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
  const rejected = sentDependsOn
    .filter((id) => !present.has(id))
    .map((id) => ({ id, reason: "not found or cross-project" }));
  if (rejected.length === 0) return null;
  return {
    code: "DEPENDS_ON_REJECTED",
    detail: { rejected },
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
    detail: { dropped },
    next: ["task_create again (agents cannot set labels post-create)"],
  };
}

// ── Per-verb receipt builders ────────────────────────────────────────────────

export interface CreateOrRespecResponse {
  task: BackendTask;
  confidence?: ConfidenceObj;
}

export function receiptForCreate(
  response: CreateOrRespecResponse,
  input: { labels?: string[]; dependsOn?: string[] },
): Receipt {
  const deviations: Deviation[] = [];
  const confDev = confidenceDeviation(response.confidence);
  if (confDev) deviations.push(confDev);
  const dedupeDev = dedupedExternalRefDeviation(response.task);
  if (dedupeDev) deviations.push(dedupeDev);
  const dependsOnDev = dependsOnRejectedDeviation(input.dependsOn, response.task.blockedBy);
  if (dependsOnDev) deviations.push(dependsOnDev);
  const labelsDev = labelsDroppedDeviation(input.labels, response.task.labels);
  if (labelsDev) deviations.push(labelsDev);

  return buildReceipt({
    taskId: response.task.id,
    status: response.task.status,
    confidence: response.confidence?.score,
    deviations,
    next: deviations.length === 0 ? ["task_start to begin work on this task"] : undefined,
  });
}

export function receiptForRespec(response: CreateOrRespecResponse): Receipt {
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
export function receiptForFinish(response: FinishResponse): Receipt {
  const deviations: Deviation[] = [];
  if (response.skippedGates && response.skippedGates.length > 0) {
    deviations.push({
      code: "WORKFLOW_GATE_SKIPPED",
      detail: { skipped: response.skippedGates },
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
export function receiptForSubmitPr(response: SubmitPrResponse): Receipt {
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

// task_merge: unlike task_finish, the merge route's precondition checks
// compare `task.status` against hardcoded literals ("review" / "done"),
// not a dynamic workflow definition (tasks.ts ~lines 3664-3701) — so
// `from: "review"` is a route-guaranteed fact, not a guess, whenever a real
// transition happened (i.e. not an idempotent already-merged retry).
export function receiptForMerge(response: MergeResponse): Receipt {
  return buildReceipt({
    taskId: response.task.id,
    status: response.task.status,
    transition: response.alreadyMerged ? undefined : { from: "review", to: "done" },
  });
}

export interface AbandonResponse {
  task: BackendTask;
}

export function receiptForAbandon(response: AbandonResponse): Receipt {
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
// which is safe to surface — see the no-echo note on identifiers in
// receiptForCreate's module doc: correlation ids are not the "content" the
// no-echo rule targets).
export function receiptForNote(taskId: string, response: NoteResponse): Receipt {
  return buildReceipt({ taskId: response.comment?.taskId ?? taskId });
}
