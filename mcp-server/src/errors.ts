// Teaching-error layer (block tier). Normative reference:
// docs/response-contract-v1.md's "Error shape (block tier)" section. A call
// that cannot proceed at all returns
//   { ok: false, error: { code, message, recipe, allowedNext, detail? } }
// instead of a bare HTTP status or a backend error string forwarded
// verbatim. `recipe` names the concrete corrective call; `allowedNext` lists
// only verb names the caller can call immediately (machine-checkable,
// unlike the receipt layer's free-form `next[]` — see receipt.ts).
//
// mapBackendError(status, body, verbContext?) is the single entry point:
// tools.ts's wrap() is its only call site (mirrors receipt.ts's relationship
// to the receipt-projection helpers). `verbContext`, when supplied, is the
// calling tool's own registered name (e.g. "task_finish") — used only where
// the correct recipe genuinely depends on which verb was called (today:
// `precondition_failed`, which the live backend can raise from task_start,
// task_finish, and two deprecated v1 routes with different correct retry
// targets; and `cross_repo_pr_rejected`, whose pull_requests_create emit
// site sends owner/repo rather than a prUrl, so the default task_submit_pr
// recipe would misdirect it). Every other catalog entry is verb-independent
// by construction.
//
// Catalog seed (docs/response-contract-v1.md's "Catalog seed" list, plus
// pr_author_mismatch from the read_first context on backend/src/routes/
// tasks.ts): not_claimed, already_claimed, precondition_failed,
// cross_repo_pr_rejected, pr_author_mismatch, force_admin_only,
// respec_conflict, result_not_plain_string. Plus low_confidence (422, the
// pre-claim confidence gate on task_start / the deprecated tasks_claim,
// backend/src/services/confidence-gate.ts via backend/src/middleware/
// error.ts's lowConfidence helper): NOT in the contract's original seed
// list, added on review (rc-v1-C005 round 1) to close an information-loss
// gap the generic degrade path left on the highest-traffic verb — see
// lowConfidenceError below. Every other backend error degrades to the
// generic shape (status-derived code, message passthrough, recipe ->
// workflow_primer, and now also a clamped passthrough of any structured
// body.details — see genericDegrade) rather than being forwarded as raw
// text. rc-v1-C006 adds two more client-side-only entries for the
// projectSlug addressing feature: project_addressing_conflict and
// unknown_project_slug (see both below, near the end of the catalog
// section) — neither is a backend error mapBackendError ever sees.
//
// No em dashes in this file's exported/emitted prose (repo convention,
// enforced today only for primer.ts's exported strings, applied here too
// since these messages are caller-facing prose of the same kind).
//
// ── Response budget invariant ───────────────────────────────────────────
//
// INVARIANT: the serialized form of any TeachingError this module builds
// (serializeTeachingError's output, exactly what a caller receives) is
// always <= ERROR_BUDGET_CHARS (1200 chars, the wire-format size measured
// through serializeResult exactly as server.ts emits it) for arbitrary
// adversarial backend input. `code`, `message` (itself already clamped to
// MESSAGE_CHAR_BUDGET), `recipe` (clamped to RECIPE_CHAR_BUDGET), and
// `allowedNext` are always preserved WHOLE regardless of size, since the
// contract mandates all four unconditionally; `detail` is the one
// auxiliary field, and the only field this module ever sacrifices to hold
// the invariant.
//
// The per-field clamps below (DETAIL_CLAMP, DETAIL_KEY_CLAMP,
// DETAIL_ENTRY_CHAR_BUDGET, MESSAGE_CHAR_BUDGET, RECIPE_CHAR_BUDGET) each
// bound a single field, never their sum: several near-max fields at once
// (precondition_failed's failed[] with several entries, each carrying an
// optional `error` string alongside rule/message, or a wide generic
// `details` object) can still exceed the budget in total even when every
// individual field stayed within its own clamp. buildTeachingError's own
// enforceErrorBudget step is the single place that actually guarantees the
// TOTAL: it re-measures the whole serialized object after construction
// and, only when still over budget, first re-clamps `detail` harder (same
// recursive clamp, tighter limits), then, if that is still not enough,
// replaces `detail` entirely with a small, visible summary object instead
// of truncating it into something silently misleading or dropping it
// without a trace.

/** The full block-tier response shape. */
export interface TeachingError {
  ok: false;
  error: {
    code: string;
    message: string;
    recipe: string;
    /** Verb names only, machine-checkable. Empty when no self-service
     *  corrective call exists (e.g. an admin-only wall). */
    allowedNext: string[];
    /** Present when this entry carries structured detail: today,
     *  precondition_failed's `failed[]`, low_confidence's
     *  score/threshold/missing[]/totalMissing, and, for the generic
     *  degrade path, a clamped passthrough of whatever `details` object
     *  the backend itself sent, OR, when the backend instead sent an
     *  OBJECT `error` (a raw zod SafeParseError spread into the body, see
     *  genericDegrade/deriveGenericDetailSource), a clamped
     *  issues[]/totalIssues summary derived from it. */
    detail?: Record<string, unknown>;
  };
}

// ── Budget / clamp constants ────────────────────────────────────────────
//
// Mirrors receipt.ts's DETAIL_CLAMP / ENTRY_CHAR_BUDGET convention (same
// reason: an unclamped array or a long backend string can blow the response
// budget on its own). Kept local to this module rather than imported from
// receipt.ts since the two layers clamp different shapes (string[] there,
// {rule,message} objects here) and have independent budgets.

/** Max entries kept in a detail array before it is clamped + counted. */
const DETAIL_CLAMP = 5;
/** Max distinct keys kept in a detail OBJECT before it is clamped + counted
 *  (the object counterpart to DETAIL_CLAMP's array-entry cap). An object
 *  with many keys, or long key names, is exactly as capable of blowing the
 *  response budget as an oversized array or string, and per-VALUE clamping
 *  alone does nothing to bound key count or key-name length. */
const DETAIL_KEY_CLAMP = 12;
/** Per-entry char bound for a detail array's own string fields, and for a
 *  detail object's own key names and string values. */
const DETAIL_ENTRY_CHAR_BUDGET = 60;
/** Char bound for the top-level `message` and `recipe` strings — these can
 *  carry a raw backend message (a zod validation error, for one, can run to
 *  thousands of chars) or, for `recipe`, a hand-authored corrective sentence
 *  that must itself never grow into a prose blob. */
const MESSAGE_CHAR_BUDGET = 300;
const RECIPE_CHAR_BUDGET = 240;
const TRUNCATION_MARKER = "...";

/** Hard ceiling on the whole serialized teaching error (JSON.stringify(x,
 *  null, 2), the exact wire format serializeTeachingError/serializeResult
 *  emit). See the file header's "Response budget invariant" section: this
 *  is the number enforceErrorBudget (below) actually holds the line at,
 *  since the per-field clamps above only ever bound one field at a time. */
const ERROR_BUDGET_CHARS = 1200;

/** Tighter versions of DETAIL_CLAMP / DETAIL_KEY_CLAMP /
 *  DETAIL_ENTRY_CHAR_BUDGET, used only by enforceErrorBudget's second
 *  ("harder reclamp") pass, when the normal clamp still was not enough to
 *  bring the total under ERROR_BUDGET_CHARS. */
const HARD_DETAIL_CLAMP = 2;
const HARD_DETAIL_KEY_CLAMP = 3;
const HARD_DETAIL_ENTRY_CHAR_BUDGET = 20;

function clamp(value: string, maxChars: number): string {
  return value.length > maxChars
    ? value.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
    : value;
}

function buildTeachingError(opts: {
  code: string;
  message: string;
  recipe: string;
  allowedNext: string[];
  detail?: Record<string, unknown>;
}): TeachingError {
  const err: TeachingError = {
    ok: false,
    error: {
      code: opts.code,
      message: clamp(opts.message, MESSAGE_CHAR_BUDGET),
      recipe: clamp(opts.recipe, RECIPE_CHAR_BUDGET),
      allowedNext: opts.allowedNext,
      ...(opts.detail ? { detail: opts.detail } : {}),
    },
  };
  // Single choke point for every TeachingError this module ever constructs
  // (every catalog entry, the generic degrade path, and
  // resultMustBePlainStringError all call buildTeachingError): the response
  // budget invariant documented in the file header is enforced HERE, not
  // duplicated at each call site or bolted onto mapBackendError's return
  // path, so a future catalog entry gets it for free. enforceErrorBudget is
  // defined further down (near clampDetailValue, which it reuses); function
  // declarations are hoisted, so the forward reference is fine.
  return enforceErrorBudget(err);
}

/** Serializes a TeachingError exactly as server.ts's serializeResult would
 *  (JSON.stringify(x, null, 2) for a non-string result — a teaching error is
 *  always an object, never a string, so the two are always equal for this
 *  input). Defined locally rather than importing serializeResult from
 *  server.ts to avoid a circular import (server.ts -> tools.ts -> errors.ts);
 *  tests/errors.test.ts asserts the two stay equal for every catalog entry. */
export function serializeTeachingError(err: TeachingError): string {
  return JSON.stringify(err, null, 2);
}

// ── Backend error body shape ────────────────────────────────────────────
//
// backend/src/middleware/error.ts's errorResponse: { error: code, message,
// details? }. Individual routes in backend/src/routes/tasks.ts also inline
// this shape directly (same fields) rather than always going through the
// helper — see e.g. the precondition_failed sites, which additionally carry
// `failed: [{ rule, message, error? }]` and `canForce`.

interface BackendErrorBody {
  error?: string;
  message?: string;
  failed?: Array<{ rule?: unknown; message?: unknown; error?: unknown }>;
  // low_confidence's structured payload (backend/src/middleware/error.ts's
  // lowConfidence: `errorResponse(..., confidence)` spreads the confidence
  // report in as `details`). Typed loosely (not `ConfidenceObj`-shaped)
  // since this module treats it as untrusted response data, same stance as
  // `failed` above.
  details?: unknown;
  // already_claimed's own structured payload: `{ taskId, title, role }` for
  // the claim the caller already holds (backend/src/routes/tasks.ts:
  // 1469-1480 / 1688-1699). Typed loosely for the same untrusted-response-data
  // reason as `failed`/`details` above; see extractActiveClaim below for the
  // per-field validation.
  activeClaim?: unknown;
  [key: string]: unknown;
}

function asBackendBody(body: unknown): BackendErrorBody {
  return body && typeof body === "object" ? (body as BackendErrorBody) : {};
}

function backendMessage(body: BackendErrorBody, status: number): string {
  return typeof body.message === "string" && body.message.length > 0
    ? body.message
    : `request failed with status ${status}`;
}

// ── Catalog entries ─────────────────────────────────────────────────────

// 1. Acting without a claim. task_finish, task_submit_pr, and task_abandon
// all return 403 `forbidden` with a message matching this shape when the
// caller does not hold the claim on the task (backend/src/routes/tasks.ts:
// POST /tasks/:id/finish, POST /tasks/:id/submit-pr, POST
// /tasks/:id/abandon). The backend's own `error` code is the generic
// "forbidden" (shared with unrelated 403s like missing-scope and
// access-denied), so this catalog entry is message-pattern matched, not
// code matched, and mints its own more specific `not_claimed` code.
const NOT_CLAIMED_PATTERN = /do not hold .*claim/i;

function notClaimedError(message: string): TeachingError {
  return buildTeachingError({
    code: "not_claimed",
    message,
    recipe: "call task_start to claim this task first",
    allowedNext: ["task_start"],
  });
}

// 2. Claim wall / solo multi-task. task_pickup and task_start both return
// 409 `already_claimed` when the caller already holds an active claim
// (backend/src/routes/tasks.ts: POST /tasks/pickup, POST
// /tasks/:id/start). The backend's own code is already specific, so it is
// kept verbatim as this entry's code.
//
// Review-retention case (rc-v1-C008 Cold-Start-Eval, 2026-08-12 live
// finding; generalized on the rc-v1-already-claimed-review-recipe review
// round, H1): task_finish's own documented semantics clear the work claim
// only when the task lands on a TERMINAL state, and keep it on EVERY finish
// that instead lands the task back on `review` -- there is no separate
// request_changes-only code path (backend/src/routes/tasks.ts ~3150-3156:
// `if (isTerminalState(...)) { clear claim fields }`, no `else`).
// request_changes (the rework loop keeping the original author's claim so
// they resume automatically) is the one caller-visible EXAMPLE of this, not
// the definition: an ordinary multi-step workflow whose own
// expectedFinishState is `review` keeps the claim the exact same way, with
// no request_changes outcome involved at all. A recipe that names only
// request_changes reads as a scope test to a caller whose task landed in
// review some other way, who could then wrongly conclude task_abandon is
// safe. Named below as "work claim on an in-review task" instead, with no
// reference to how the task got there.
//
// Reviewer branch (H2): this same 409 fires identically for a REVIEW claim
// wall, not just a work claim -- task_pickup's and task_start's own
// claim-wall queries both match `reviewClaimedByAgentId === actor.tokenId
// && status === "review"` too (backend/src/routes/tasks.ts ~1462-1465 for
// /tasks/pickup, ~1681-1684 for /tasks/:id/start), and by construction ANY
// review claim sits on a task currently in review. For that caller,
// task_abandon on the held claim IS the correct, immediate, clean exit: the
// abandon route's "cannot abandon while in review" guard
// (backend/src/routes/tasks.ts ~3540-3541: `if (holdsWorkClaim &&
// !holdsReviewClaim && isReviewState(...))`) is scoped to a WORK claim only
// and never fires for a review claim. A recipe that tells a role=reviewer
// caller to wait, merge, or avoid task_abandon would be actively wrong for
// them.
//
// Whether the held claim is an ordinary in_progress work claim, a work
// claim retained on a task now in review, or a review claim is only
// PARTIALLY determinable from this catalog entry's only input. The 409 body
// both real call sites send is `{ error: "already_claimed", message,
// activeClaim: { taskId, title, role } }` (verified at
// backend/src/routes/tasks.ts:1469-1480 for /tasks/pickup and :1688-1699
// for /tasks/:id/start, and documented at docs/okf/claim-model.md:19).
// `role` ("author" vs "reviewer", derived from which claim column matched)
// DOES cleanly separate the reviewer case from both author cases (a
// role="reviewer" claim is always a review claim, per the query above) --
// it is only WITHIN role="author" that an ordinary in_progress claim and a
// work claim retained on a review-state task stay indistinguishable from
// this input alone (there is no `status` field on activeClaim). This
// input is not status-BLIND, though: the caller already has taskId in hand
// and is one tasks_get call away from the actual status if it needs to
// decide programmatically rather than read the recipe's cases -- M3
// (rc-v1-already-claimed-review-recipe review round, task 008ac513, the
// follow-up this comment used to point at) closes that gap: extractActiveClaim
// below passes the backend's own `activeClaim: { taskId, title, role }`
// through, clamped, as this entry's `detail.activeClaim`, and `tasks_get`
// is added to `allowedNext` so the check-its-status call is itself
// immediately callable per the allowedNext contract, not just implied by
// the prose. This entry still names all three cases explicitly in the
// recipe text, keyed by claim kind / state rather than by role, so the
// caller self-selects the right one instead of defaulting to task_abandon,
// which is safe for two of the three cases and rejected outright for the
// third; `detail.activeClaim` is the machine-readable input a caller can
// use to do that same selection programmatically instead of reading prose.
//
// task_finish is deliberately NOT offered as a blanket corrective for the
// workClaimInReview case below: on that task it is either rejected outright
// (403 when a distinct reviewer already holds the review claim on a
// REQUIRES_DISTINCT_REVIEWER project, backend/src/routes/tasks.ts
// ~2825-2831; 409 `reviewer_conflict` when a distinct reviewer already
// holds the claim on a non-DR project, ~2805-2818) or is the deliberate
// self-approve branch on a non-DR project with no reviewer claim yet held
// (~2539-2557, `outcome` required). It is therefore SAFE when it works,
// just often unavailable to a caller who cannot know in advance which of
// those applies -- "wait for the reviewer" is offered as the option that is
// always safe regardless.
//
// ALREADY_CLAIMED_CASES (M6) names the three case-sentences as individually
// testable, exported constants instead of one hand-assembled string tests
// would otherwise have to slice out of by searching for a substring like
// "review": a slice-by-indexOf assertion breaks on any semantically-safe
// reword that keeps the meaning but moves the words (see
// tests/errors.test.ts for the constant-based assertions this enables).
export const ALREADY_CLAIMED_CASES = {
  inProgress: "In-progress claim: task_finish or task_abandon on it.",
  workClaimInReview:
    "Work claim on an in-review task: abandon is rejected (409); wait for the reviewer, or task_merge + task_finish outcome=approve.",
  reviewClaim: "Review claim: task_abandon frees the review lock.",
} as const;

const ALREADY_CLAIMED_RECIPE = [
  ALREADY_CLAIMED_CASES.inProgress,
  ALREADY_CLAIMED_CASES.workClaimInReview,
  ALREADY_CLAIMED_CASES.reviewClaim,
].join(" ");

// M3 follow-up (task 008ac513): pulls the backend's own `activeClaim: {
// taskId, title, role }` (see the file comment above this catalog entry)
// out of the 409 body and clamps it for `detail.activeClaim`, the same
// DETAIL_ENTRY_CHAR_BUDGET convention every other structured detail field
// in this module uses. Untrusted response data, same stance as the other
// extract-from-body helpers in this file (asBackendBody, preconditionFailedError's
// rawFailed mapping): every field is validated by type before use, and a
// missing/malformed activeClaim (or one with no usable field at all)
// degrades to `undefined` -- the caller then just sees the recipe prose
// with no detail, the exact behavior before this change, rather than a
// detail object with fabricated or empty fields.
function extractActiveClaim(body: BackendErrorBody): Record<string, unknown> | undefined {
  const raw = body.activeClaim;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const claim = raw as Record<string, unknown>;
  const taskId = typeof claim.taskId === "string" ? clamp(claim.taskId, DETAIL_ENTRY_CHAR_BUDGET) : undefined;
  const title = typeof claim.title === "string" ? clamp(claim.title, DETAIL_ENTRY_CHAR_BUDGET) : undefined;
  const role = typeof claim.role === "string" ? clamp(claim.role, DETAIL_ENTRY_CHAR_BUDGET) : undefined;
  if (taskId === undefined && title === undefined && role === undefined) return undefined;
  return {
    ...(taskId !== undefined ? { taskId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(role !== undefined ? { role } : {}),
  };
}

function alreadyClaimedError(body: BackendErrorBody, message: string): TeachingError {
  const activeClaim = extractActiveClaim(body);
  return buildTeachingError({
    code: "already_claimed",
    message,
    recipe: ALREADY_CLAIMED_RECIPE,
    // M4: deliberately the UNION over all three ALREADY_CLAIMED_CASES above,
    // not just the in-progress pair task_finish/task_abandon -- task_merge
    // is the corrective action the workClaimInReview case's own sentence
    // names (merge, then task_finish outcome=approve), so it must be
    // immediately callable per the allowedNext contract
    // (docs/response-contract-v1.md's "verb names the caller can call
    // immediately"). The recipe text is what actually SELECTS the right
    // case for the caller's own claim; allowedNext only has to list every
    // verb any one of the three cases could legitimately call next.
    // M3 follow-up: tasks_get is added too -- it is the concrete corrective
    // for "check its status" (see the M3 comment above extractActiveClaim),
    // and, same as task_merge, must be immediately callable per the
    // allowedNext contract rather than only implied by prose.
    allowedNext: ["task_finish", "task_abandon", "task_merge", "tasks_get"],
    ...(activeClaim ? { detail: { activeClaim } } : {}),
  });
}

// 3. Branch precondition. task_start / task_finish / tasks_transition [POST
// /tasks/:id/transition] / (the two deprecated v1 routes tasks_update
// [PATCH /tasks/:id] and tasks_claim [POST /tasks/:id/claim]) all return 422
// `precondition_failed` with a structured `failed: [{rule, message, error?}]`
// array (backend/src/routes/tasks.ts, backend/src/services/transition-rules.ts:
// TransitionRule is exactly "branchPresent" | "prPresent" | "ciGreen" |
// "prMerged", so `failed` never actually exceeds 4 entries today). The
// per-rule detail is kept STRUCTURED (each rule named individually), not
// collapsed into the prose `message` the backend also sends (which
// concatenates every failing rule's own message into one string) — the
// outer `message` here is a short, own-authored summary instead, so a
// caller reading just `error.message` still gets something scannable.
//
// The clamp (DETAIL_CLAMP entries, DETAIL_ENTRY_CHAR_BUDGET chars each) is
// applied unconditionally, same as receipt.ts's DETAIL_CLAMP convention,
// even though the fixed 4-rule set means it can never actually bite against
// the live backend — a future rule addition, or a malformed/spoofed body in
// a test fixture, must not be able to blow the response budget. This clamp
// bounds each FIELD on its own, not the sum of all of them; the aggregate
// invariant that the WHOLE response never blows the budget is what
// buildTeachingError's enforceErrorBudget step (see the file header)
// actually guarantees, since several near-max failed[] entries at once can
// still add up past ERROR_BUDGET_CHARS even though each stayed clamped.
//
// The real backend's TransitionRule values (backend/src/services/
// transition-rules.ts) and their RULE_MESSAGES prose. That prose is
// diagnostic ("what's wrong"), not corrective ("what to do"): at
// DETAIL_ENTRY_CHAR_BUDGET (60 chars) every one of the four real messages
// gets clamped exactly where its instruction half starts (measured:
// branchPresent's own message truncates to "No branch recorded on this
// task. PATCH /api/tasks/:id with branchNam..."). Rather than truncate the
// corrective away, each known rule gets its own short, own-authored
// corrective here instead of the backend's message, kept whole. The
// truncating clamp is kept as the fallback for any OTHER rule name (a
// future rule addition, or a malformed/spoofed body in a test fixture), so
// the unconditional-clamp property above still holds for anything this
// module does not know about.
// Exported so tests/errors.test.ts can assert this map's key set stays in
// sync with the real backend's transition-rules.ts RULE_MESSAGES (a
// same-workspace-idiom drift guard, not a runtime consumer outside this
// module).
export const KNOWN_RULE_CORRECTIVES: Record<string, string> = {
  branchPresent: "record the branch via task_submit_pr",
  prPresent: "create the PR then task_submit_pr",
  ciGreen: "wait for CI to pass on the PR",
  prMerged: "merge the PR first",
};

function preconditionFailedError(body: BackendErrorBody, verbContext: string | undefined): TeachingError {
  const rawFailed = Array.isArray(body.failed) ? body.failed : [];
  const rules = rawFailed.map((f) => (typeof f.rule === "string" ? f.rule : "unknown"));
  // `rule` is clamped even though the real backend's TransitionRule values
  // are short: this function's input is untrusted response data, not a
  // value this module controls, so a malformed/oversized `rule` string
  // must not be able to blow the per-field budget either. Three near-max
  // fields (rule/message/error) on several entries at once can still add
  // up past the RESPONSE budget even with every field individually
  // clamped here; buildTeachingError's enforceErrorBudget step is what
  // actually holds that aggregate line (see the file header). `message`
  // is the known rule's own-authored corrective (whole, never truncated)
  // when the rule is one of the four real ones, or the backend's own
  // message clamped otherwise (see KNOWN_RULE_CORRECTIVES above). The
  // optional per-rule `error` field (present today on ciGreen/prMerged
  // when the underlying GitHub call itself failed — e.g. "GitHub
  // unreachable" vs. a clean "CI red", the only thing distinguishing the
  // two) is included, clamped, whenever the backend actually sent one.
  const clampedFailed = rawFailed.slice(0, DETAIL_CLAMP).map((f) => {
    const rawRule = typeof f.rule === "string" ? f.rule : "unknown";
    const rawMessage = typeof f.message === "string" ? f.message : "";
    const corrective = KNOWN_RULE_CORRECTIVES[rawRule];
    return {
      rule: clamp(rawRule, DETAIL_ENTRY_CHAR_BUDGET),
      message: corrective ?? clamp(rawMessage, DETAIL_ENTRY_CHAR_BUDGET),
      ...(typeof f.error === "string" && f.error.length > 0
        ? { error: clamp(f.error, DETAIL_ENTRY_CHAR_BUDGET) }
        : {}),
    };
  });
  const needsSubmitPr = rules.includes("branchPresent") || rules.includes("prPresent");
  // task_finish is the contract's own documented context for this trap
  // ("blocks task_finish with 422 precondition_failed") and the correct
  // fallback for every call site this module does not thread verbContext
  // through today (only task_start, task_finish, tasks_claim, tasks_update,
  // and tasks_transition can actually raise this error; see tools.ts's
  // wrap() call sites for those five).
  const retryVerb = verbContext ?? "task_finish";
  const recipe = needsSubmitPr
    ? `run \`gh pr create\`, call task_submit_pr with the branch/PR metadata, then retry ${retryVerb}`
    : `wait for the remaining precondition(s) to clear (see error.detail.failed), then retry ${retryVerb}`;
  const allowedNext = needsSubmitPr ? ["task_submit_pr", retryVerb] : [retryVerb];
  return buildTeachingError({
    code: "precondition_failed",
    message:
      rules.length > 0
        ? `${rules.length} workflow gate${rules.length === 1 ? "" : "s"} not yet satisfied: ${rules
            .slice(0, DETAIL_CLAMP)
            .join(", ")}`
        : "a workflow gate is not yet satisfied",
    recipe,
    allowedNext: Array.from(new Set(allowedNext)),
    detail: { failed: clampedFailed, totalFailed: rawFailed.length },
  });
}

// 4. cross_repo_pr_rejected. A prUrl (or, for pull_requests_create, an
// owner/repo pair) that does not point at project.githubRepo is rejected
// with 400 from four backend sites: POST /tasks/:id/submit-pr
// (task_submit_pr's own emit site), POST /tasks/:id/finish (a work-claim
// task_finish call that also carries prUrl), PATCH /tasks/:id (the
// deprecated tasks_update agent-write path), and, differently shaped, POST
// /pull-requests (backend/src/routes/github.ts, pull_requests_create's own
// emit site — rejected BEFORE a PR is even created on GitHub, from an
// owner/repo pair rather than a prUrl). Backend code kept verbatim; the
// recipe branches on verbContext because pull_requests_create's own caller
// sent owner/repo, not a prUrl (see crossRepoRejectedError below).
function crossRepoRejectedError(message: string, verbContext: string | undefined): TeachingError {
  if (verbContext === "pull_requests_create") {
    return buildTeachingError({
      code: "cross_repo_pr_rejected",
      message,
      recipe: "call pull_requests_create again with owner/repo matching this project's own repo",
      allowedNext: ["pull_requests_create"],
    });
  }
  return buildTeachingError({
    code: "cross_repo_pr_rejected",
    message,
    recipe:
      "call task_submit_pr again with a prUrl on this project's own repo, or set deliverableRepo at create time when the deliverable is intentionally a different repo",
    allowedNext: ["task_submit_pr"],
  });
}

// 5. pr_author_mismatch. task_submit_pr rejects a prUrl whose PR was not
// authored by the delegation user, 403 (backend/src/routes/tasks.ts:
// POST /tasks/:id/submit-pr). Backend code kept verbatim.
function prAuthorMismatchError(message: string): TeachingError {
  return buildTeachingError({
    code: "pr_author_mismatch",
    message,
    recipe: "open the PR under the delegation user's own GitHub login, then call task_submit_pr again with that prUrl",
    allowedNext: ["task_submit_pr"],
  });
}

// 6. transition force=admin-only. tasks_transition / POST
// /tasks/:id/transition { force: true } returns 403 `forbidden` for
// non-admins (backend/src/routes/tasks.ts: POST /tasks/:id/transition,
// message "Only team admins can force a transition"). Same generic backend
// code as not_claimed, message-pattern matched, own code minted. No self-service
// corrective call exists (this is genuinely an admin-only wall), so
// allowedNext is empty by design, not an oversight — the recipe itself
// still names the concrete action ("do not pass force:true"), satisfying
// the "never just 'invalid request'" rule without inventing a verb.
const FORCE_ADMIN_ONLY_PATTERN = /admins? can force a transition/i;

function forceAdminOnlyError(message: string): TeachingError {
  return buildTeachingError({
    code: "force_admin_only",
    message,
    recipe: "do not pass force:true; only a project admin can use the force-transition escape hatch",
    allowedNext: [],
  });
}

// 7. Description immutability. task_respec only edits an OPEN, unclaimed
// task; any other state is rejected with 409 `conflict` (backend/src/
// routes/tasks.ts, RESPEC_STATE_CONFLICT_MESSAGE = "Task must be open and
// unclaimed to respec"). The backend's own code ("conflict") is shared with
// other unrelated 409s (middleware/error.ts's generic conflict() helper),
// so this entry is message-pattern matched and mints its own code.
const RESPEC_CONFLICT_PATTERN = /open and unclaimed to respec/i;

function respecConflictError(message: string): TeachingError {
  return buildTeachingError({
    code: "respec_conflict",
    message,
    recipe: "task_respec only works on an open, unclaimed task; call task_abandon first if you hold the claim, then retry task_respec",
    allowedNext: ["task_abandon", "task_respec"],
  });
}

// 8. task_finish `result` (and the deprecated tasks_update's) as plain
// string. Unlike the other catalog entries, the backend performs NO
// validation of this today (`result` is stored verbatim as free text) —
// this trap exists only at the mcp-server layer, triggered locally in
// tools.ts's task_finish and tasks_update handlers BEFORE any request is
// sent, not mapped from a backend error. Exported separately (not reachable
// via mapBackendError, which only ever sees a real AgentTasksApiError) and
// paired with looksLikeStructuredWrapper, the detector tools.ts calls.

// Inline formatting tags a caller might legitimately use in ordinary prose
// (markdown-adjacent emphasis, e.g. "<b>Done</b>" as a whole result). A LONE
// pair using one of these is never, on its own, a structured-wrapper signal
// — see hasSuspiciousTagPair below. An unlisted tag (<result>, <Foo>, <div>,
// ...) is still suspect, and MULTIPLE tag pairs (even multiple inline-
// formatting ones) are still suspect: the allowance is deliberately scoped
// to a single lone pair.
const INLINE_FORMATTING_TAGS = new Set(["b", "i", "em", "strong", "code"]);

// Finds every non-overlapping complete "<tag ...>...</tag>" pair in a
// string (global, lazy inner match so a sibling pair right after a closing
// tag is found as its own match rather than the scan running past it to a
// later same-named closing tag).
const TAG_PAIR_PATTERN = /<([a-zA-Z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1>/g;

// A pathological string (many '<' characters with no matching closing tag)
// can make TAG_PAIR_PATTERN's lazy, backtracking-capable inner match blow up
// combinatorially on long input (measured: ~18.4s scanning a single 400k-char
// adversarial string). tools.ts's task_finish and tasks_update both cap
// `result` at 5000 chars today, but this guard must not itself become the
// next unbounded-input path for some future caller that forgets to cap its
// own input before handing it to looksLikeStructuredWrapper, so it is
// bounded here too, defensively, independent of any caller-side cap. Only
// the leading TAG_SCAN_CHAR_LIMIT chars are scanned for a suspicious tag
// pair; a legitimate tag pair sitting entirely past that point in an
// already-pathologically-long value is missed, an accepted trade-off since a
// value that long is already well outside "plain prose result text"
// territory regardless.
const TAG_SCAN_CHAR_LIMIT = 6000;

/** True when `trimmed` contains a tag pair this guard treats as suspicious.
 *  Zero matches: never suspicious (plain prose that merely mentions an
 *  unclosed tag, e.g. "fixed the <Foo> component", never matches at all).
 *  More than one matched pair: always suspicious, regardless of tag name —
 *  a caller wrapping two separate pieces in their own tags (or repeating an
 *  inline-formatting tag) is exactly the kind of LLM mistake this guard
 *  exists to catch, so the inline-formatting allowance below is
 *  deliberately scoped to a LONE pair only. Exactly one matched pair: a
 *  lone INLINE_FORMATTING_TAGS pair is never suspicious (regardless of
 *  position — a bolded lead-in like "<b>Warning:</b> ..." is ordinary
 *  prose); any other single tag is suspicious only when it sits at the
 *  leading or trailing edge of the value (a whole-string wrap, a tag
 *  followed by trailing prose, or leading prose followed by a tag) — NOT
 *  when it is embedded mid-sentence with prose on both sides, which stays
 *  deliberately uncovered (indistinguishable from a caller quoting a
 *  tag-like token in normal prose; see tests/errors.test.ts's
 *  "embedded mid-sentence" case for the documented boundary). */
function hasSuspiciousTagPair(trimmed: string): boolean {
  const matches = Array.from(trimmed.matchAll(TAG_PAIR_PATTERN));
  if (matches.length === 0) return false;
  if (matches.length > 1) return true;
  const [match] = matches;
  const tag = match[1].toLowerCase();
  if (INLINE_FORMATTING_TAGS.has(tag)) return false;
  const start = match.index ?? 0;
  const end = start + match[0].length;
  return start === 0 || end === trimmed.length;
}

/** True when `value` (trimmed) looks like an LLM-style structured wrapper
 *  around what should be plain prose: an `<?xml` preamble, a fenced code
 *  block (the single most common mistake — wrapping the whole answer, or a
 *  JSON payload, in a \`\`\` / \`\`\`json fence), valid whole-string JSON, or
 *  a suspicious tag pair (see hasSuspiciousTagPair). Deliberately NOT
 *  triggered by a value that merely contains an angle bracket or a brace
 *  somewhere in ordinary prose, or by a single inline-formatting tag pair
 *  (e.g. a result of exactly "<b>Done</b>") — both stay legitimate prose. */
export function looksLikeStructuredWrapper(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  // <?xml preamble: an LLM that started emitting an XML document.
  if (/^<\?xml\b/i.test(trimmed)) return true;

  // A fenced code block anywhere, so long as the fence starts at the
  // beginning of a line — not just when it opens the whole string, since a
  // caller often prefaces the fence with a sentence of prose.
  if (/^```/m.test(trimmed)) return true;

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // Starts/ends with a brace but is not valid JSON on its own — fall
      // through to the tag-pair check below rather than assuming prose.
    }
  }

  return hasSuspiciousTagPair(
    trimmed.length > TAG_SCAN_CHAR_LIMIT ? trimmed.slice(0, TAG_SCAN_CHAR_LIMIT) : trimmed,
  );
}

export function resultMustBePlainStringError(
  verb: "task_finish" | "tasks_update" = "task_finish",
): TeachingError {
  return buildTeachingError({
    code: "result_not_plain_string",
    message: "result must be plain prose or markdown text, not wrapped in XML or JSON tags",
    recipe: `resubmit ${verb} with result as plain text (no <tag>...</tag> or {...} wrapping)`,
    allowedNext: [verb],
  });
}

// 9. low_confidence. task_start's (and the deprecated tasks_claim's)
// pre-claim confidence gate rejects a claim below the project's confidence
// threshold with 422 `low_confidence` (backend/src/services/
// confidence-gate.ts's evaluateConfidenceGate, via backend/src/middleware/
// error.ts's lowConfidence helper: POST /tasks/:id/start, POST
// /tasks/:id/claim). NOT in the contract's original catalog seed (see the
// file header above) — added on review because the generic degrade path
// was silently DROPPING body.details (score, threshold, missing[],
// nextActions) on this specific, highest-traffic verb: a caller saw only a
// generic message and a workflow_primer recipe, with no way to learn WHY
// the claim was blocked short of re-deriving it independently. task_respec
// is the contract's own documented corrective for CONFIDENCE_BELOW_THRESHOLD
// (docs/response-contract-v1.md's deviation catalog; receipt.ts's
// confidenceDeviation uses the same corrective for task_create/
// task_respec's own low-score case), so it is named here too.
function lowConfidenceError(body: BackendErrorBody, message: string): TeachingError {
  const details =
    body.details && typeof body.details === "object" && !Array.isArray(body.details)
      ? (body.details as Record<string, unknown>)
      : {};
  const score = typeof details.score === "number" ? details.score : undefined;
  const threshold = typeof details.threshold === "number" ? details.threshold : undefined;
  const rawMissing = Array.isArray(details.missing)
    ? details.missing.filter((m): m is string => typeof m === "string")
    : [];
  // Same DETAIL_CLAMP/DETAIL_ENTRY_CHAR_BUDGET convention as
  // precondition_failed's `failed[]` above: the backend scorer can
  // populate up to 9 field names (see receipt.ts's confidenceDeviation),
  // already in surfacing-priority order.
  const missing = rawMissing.slice(0, DETAIL_CLAMP).map((m) => clamp(m, DETAIL_ENTRY_CHAR_BUDGET));
  return buildTeachingError({
    code: "low_confidence",
    message,
    recipe: "call task_respec to raise the description/templateData above the confidence threshold, then retry",
    allowedNext: ["task_respec"],
    detail: {
      ...(score !== undefined ? { score } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      missing,
      totalMissing: rawMissing.length,
    },
  });
}

// 10. project_addressing_conflict / unknown_project_slug. rc-v1-C006's
// projectSlug alternative to projectId (task_create, and project_tasks via
// the same client-side resolver, client.ts's withResolvedProjectSlug):
// neither trap is a backend error the real API ever raises with these
// codes, so neither is reachable via mapBackendError below. Both are raised
// directly by the calling tool's own handler in tools.ts, same pattern as
// catalog entry #8 (resultMustBePlainStringError) — a client-side guard
// checked before, or in place of, any network call.
//
// project_addressing_conflict covers BOTH directions of the same "exactly
// one of projectId/projectSlug" requirement, not just "both provided":
// task_create's own client-side guard (tools.ts) also rejects the mirror-
// image mistake, neither field set. That case used to throw a bare,
// unteaching Error (rc-v1-C006 round-2 review, LOW) instead of going
// through this catalog. Rather than mint a second, near-duplicate code for
// what is really the same "exactly one" constraint violated the other way,
// `reason` selects direction-specific message/recipe/allowedNext under the
// SAME code: "both" needs no extra corrective (the caller already named
// both candidates, it just needs to pick one), but "neither" used to point
// at projects_list as the self-service way to find the project.
//
// rc-v1-C007 pruned projects_list out of the DEFAULT tool registration
// (tools.ts's LEGACY_VERB_NAMES); it is opt-in only via
// AGENT_TASKS_MCP_LEGACY=1 now. task_create and project_tasks (this
// catalog entry's only two real call sites) both stay in the default
// registration, so a default-mode caller can trip "neither_provided"
// without ever having projects_list available to them. `allowedNext` MUST
// list only verb names callable immediately (docs/response-contract-v1.md's
// error-shape section), so "neither"'s allowedNext no longer names
// projects_list unconditionally; `recipe` still mentions it, but only as
// the legacy-flag option, alongside the always-available "ask the
// operator" fallback.
export function projectAddressingConflictError(
  verb: string,
  reason: "both_provided" | "neither_provided" = "both_provided",
): TeachingError {
  if (reason === "neither_provided") {
    return buildTeachingError({
      code: "project_addressing_conflict",
      message: "neither projectId nor projectSlug was provided; pass exactly one",
      recipe: `ask the operator for this project's slug or id (or, with AGENT_TASKS_MCP_LEGACY=1 set, call projects_list), then resubmit ${verb} with projectId or projectSlug set`,
      allowedNext: [verb],
    });
  }
  return buildTeachingError({
    code: "project_addressing_conflict",
    message: "projectId and projectSlug were both provided; pass exactly one",
    recipe: `resubmit ${verb} with only one of projectId or projectSlug`,
    allowedNext: [verb],
  });
}

// Raised when client.ts's slug resolver gets a 404 on a FRESH (not
// cache-served) slug lookup — see client.ts's ProjectSlugNotFoundError and
// withResolvedProjectSlug. `recipe` used to name projects_list
// unconditionally as the concrete corrective call for "how do I find the
// actual available slugs". Same rc-v1-C007 constraint as
// projectAddressingConflictError above: projects_list is legacy-gated now,
// task_create and project_tasks (both default-registered) are this
// catalog entry's real call sites, so `allowedNext` no longer names it
// (only the calling verb does); `recipe` still offers it as the
// legacy-flag option alongside the always-available operator fallback.
export function unknownProjectSlugError(slug: string, verb: string): TeachingError {
  return buildTeachingError({
    code: "unknown_project_slug",
    message: `no project found for slug "${slug}"`,
    recipe:
      "ask the operator for the correct project slug or id (or, with AGENT_TASKS_MCP_LEGACY=1 set, call projects_list to see the available slugs)",
    allowedNext: [verb],
  });
}

// ── Generic degrade path ────────────────────────────────────────────────
//
// Any backend error not matched by one of the catalog entries above
// degrades structurally instead of being forwarded as raw text: the code is
// derived from the HTTP status (NOT the backend's own `error` field — that
// field is only trustworthy as a catalog SIGNAL, matched explicitly above;
// echoing it verbatim here would silently grow the catalog by accident
// every time the backend adds a new code), the message is passed through
// (clamped), the recipe points at workflow_primer, the one call every
// caller can always make to recover — AND, when the backend body carried a
// structured `details` object, a clamped copy of it survives into
// `error.detail` instead of being dropped. Before this, any uncataloged
// error with a `details` payload (not just low_confidence, which is now
// its own catalog entry above) silently lost that payload; this closes the
// gap for the whole degrade class, not just the one verb that happened to
// earn its own catalog entry.
const GENERIC_DETAIL_MAX_DEPTH = 3;

/** Overridable limits for clampDetailValue's recursive walk. Defaults to
 *  this module's normal DETAIL_CLAMP / DETAIL_KEY_CLAMP /
 *  DETAIL_ENTRY_CHAR_BUDGET; enforceErrorBudget's harder second pass
 *  supplies the HARD_* constants instead, reusing the same function rather
 *  than a parallel implementation. */
interface DetailClampOpts {
  arrayClamp?: number;
  keyClamp?: number;
  entryChars?: number;
}

/** Writes `key: value` into `out`, disambiguating on collision instead of
 *  silently overwriting the earlier entry. A collision here means two
 *  DISTINCT original keys clamped down to the identical truncated name
 *  (e.g. several keys sharing a long common prefix beyond the char
 *  budget). Without this, the second write would clobber the first with
 *  no trace, which is exactly the kind of silent data loss this whole
 *  module exists to avoid. */
function setClampedKey(out: Record<string, unknown>, key: string, value: unknown): void {
  if (!(key in out)) {
    out[key] = value;
    return;
  }
  let suffix = 2;
  while (`${key}~${suffix}` in out) suffix++;
  out[`${key}~${suffix}`] = value;
}

/** Recursively clamps an arbitrary JSON-ish detail value: every string is
 *  char-clamped, every array is entry-clamped, and every object's key
 *  COUNT is entry-clamped too (an object with many keys, or long key
 *  names, is exactly as capable of blowing the response budget as an
 *  oversized array or string, and per-VALUE clamping alone does nothing to
 *  bound key count or key-name length). Surviving keys' NAMES are
 *  themselves char-clamped, colliding clamped names are disambiguated
 *  rather than overwritten (see setClampedKey), and a `totalKeys` marker
 *  is added whenever any key was dropped, so the drop is never silent.
 *  Kept values are clamped the same way, recursively. `depth` guards
 *  against a pathological/cyclic input from untrusted response data. */
function clampDetailValue(value: unknown, depth: number, opts: DetailClampOpts = {}): unknown {
  const arrayClamp = opts.arrayClamp ?? DETAIL_CLAMP;
  const keyClamp = opts.keyClamp ?? DETAIL_KEY_CLAMP;
  const entryChars = opts.entryChars ?? DETAIL_ENTRY_CHAR_BUDGET;
  if (depth > GENERIC_DETAIL_MAX_DEPTH) return "[detail nested too deep, truncated]";
  if (typeof value === "string") return clamp(value, entryChars);
  if (Array.isArray(value)) {
    return value.slice(0, arrayClamp).map((v) => clampDetailValue(v, depth + 1, opts));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries.slice(0, keyClamp)) {
      setClampedKey(out, clamp(k, entryChars), clampDetailValue(v, depth + 1, opts));
    }
    if (entries.length > keyClamp) out.totalKeys = entries.length;
    return out;
  }
  // number, boolean, null, undefined: passed through unchanged.
  return value;
}

/** Clamps a whole `details` object for the generic degrade path. Returns
 *  undefined (so buildTeachingError omits `detail` entirely) when the
 *  backend sent nothing usable — not an object, an array, or empty.
 *  Delegates straight to clampDetailValue (depth 0) rather than its own
 *  parallel key-walk: the top-level object needs exactly the same
 *  key-count/key-name clamping clampDetailValue's object branch already
 *  does for every NESTED object, so a wide top-level `details` (many keys,
 *  or long key names) and a wide NESTED object are both bounded by the one
 *  code path. */
function clampGenericDetail(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const out = clampDetailValue(details, 0) as Record<string, unknown>;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Bookkeeping fields a catalog entry or clampDetailValue itself may already
// have set to record a TRUE original count (precondition_failed's
// totalFailed, low_confidence's totalMissing, clampDetailValue's own
// totalKeys, and the generic degrade path's own totalIssues -- see
// deriveGenericDetailSource). A second, harder clamp pass over an
// already-clamped object must not re-derive these from the intermediate
// object's own (already shrunk) entry count -- that would silently replace
// an accurate original count with a smaller, misleading one. See
// reclampDetailHarder below.
const DETAIL_TOTAL_MARKER_KEYS = ["totalFailed", "totalMissing", "totalKeys", "totalIssues"] as const;

/** Re-clamps a detail object with the HARD_* limits, WITHOUT letting the
 *  pass corrupt any totalFailed/totalMissing/totalKeys marker already
 *  present (see DETAIL_TOTAL_MARKER_KEYS): those numbers are pulled out
 *  first, the remaining data-bearing keys are clamped harder on their own,
 *  and the original markers are restored afterward, overwriting whatever
 *  (smaller, intermediate-count) marker clampDetailValue's own object
 *  branch may have added while re-clamping the rest. */
function reclampDetailHarder(detail: Record<string, unknown>): Record<string, unknown> {
  const preservedMarkers: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if ((DETAIL_TOTAL_MARKER_KEYS as readonly string[]).includes(k) && typeof v === "number") {
      preservedMarkers[k] = v;
    } else {
      rest[k] = v;
    }
  }
  const reclampedRest = clampDetailValue(rest, 0, {
    arrayClamp: HARD_DETAIL_CLAMP,
    keyClamp: HARD_DETAIL_KEY_CLAMP,
    entryChars: HARD_DETAIL_ENTRY_CHAR_BUDGET,
  }) as Record<string, unknown>;
  return { ...reclampedRest, ...preservedMarkers };
}

/** Enforces the response budget invariant documented in the file header.
 *  buildTeachingError's own per-field clamps (MESSAGE_CHAR_BUDGET,
 *  RECIPE_CHAR_BUDGET) and each catalog entry's own array/key clamps
 *  bound individual FIELDS, never their sum: several near-max fields at
 *  once can still exceed ERROR_BUDGET_CHARS in total. This is the one
 *  place that actually guarantees the total. `code`, `message`, `recipe`,
 *  and `allowedNext` are never touched here (the contract mandates them
 *  whole, regardless of size). Only `detail`, the one field the contract
 *  marks auxiliary, is ever degraded, and NEVER silently: first a harder
 *  recursive re-clamp (same clampDetailValue walk, tighter HARD_* limits),
 *  and, only if that still is not enough, a small visible summary object
 *  replaces `detail` entirely, so a caller always sees that something was
 *  omitted rather than getting a truncated, possibly-misleading fragment. */
function enforceErrorBudget(err: TeachingError): TeachingError {
  if (serializeTeachingError(err).length <= ERROR_BUDGET_CHARS) return err;

  if (err.error.detail) {
    const reclamped: TeachingError = {
      ...err,
      error: {
        ...err.error,
        detail: reclampDetailHarder(err.error.detail),
      },
    };
    if (serializeTeachingError(reclamped).length <= ERROR_BUDGET_CHARS) return reclamped;
  }

  // Still over budget even after the harder reclamp (or there was no
  // `detail` to reclamp at all): replace `detail` with a small, fixed-size
  // summary instead of silently dropping or truncating it. `totalFailed` /
  // `totalKeys` are carried over when cheaply available (already computed
  // by the catalog entry or by clampDetailValue's own key-count marker)
  // since a caller who cannot see the detail at least learns how much of
  // it there was.
  const priorDetail = err.error.detail;
  const totalFailed = typeof priorDetail?.totalFailed === "number" ? priorDetail.totalFailed : undefined;
  const totalMissing = typeof priorDetail?.totalMissing === "number" ? priorDetail.totalMissing : undefined;
  const totalIssues = typeof priorDetail?.totalIssues === "number" ? priorDetail.totalIssues : undefined;
  const totalKeys =
    typeof priorDetail?.totalKeys === "number"
      ? priorDetail.totalKeys
      : priorDetail && typeof priorDetail === "object"
        ? Object.keys(priorDetail).length
        : undefined;
  return {
    ...err,
    error: {
      ...err.error,
      detail: {
        omitted: true,
        reason: "detail exceeded the error budget",
        ...(totalFailed !== undefined ? { totalFailed } : {}),
        ...(totalMissing !== undefined ? { totalMissing } : {}),
        ...(totalIssues !== undefined ? { totalIssues } : {}),
        ...(totalKeys !== undefined ? { totalKeys } : {}),
      },
    },
  };
}

// Observed live during rc-v1-C008 (2026-08-12): POST /tasks with an invalid
// templateData shape (acceptanceCriteria sent as an array, the schema wants
// a string) 400s with a raw zod SafeParseError spread verbatim into the
// body -- `@hono/zod-validator`'s default (no custom hook) failure path is
// `c.json(result, 400)` for `result = { success: false, error: ZodError }` --
// so the wire body is `{ success: false, error: { issues: [...], name:
// "ZodError" } }`, no top-level `details` field at all. Before this, the
// generic degrade path only ever looked at `body.details` for `detail` and
// only ever looked at `body.error` for a STRING code passthrough (see
// genericDegrade below); an OBJECT `body.error` matched neither, so this
// case degraded to `http_400` with NO detail whatsoever -- the caller had
// to go read backend source to find the actual schema mismatch.
// deriveGenericDetailSource picks what feeds clampGenericDetail: the
// backend's own top-level `details` (existing behavior, e.g. any future
// code's hand-rolled `details`, or the formErrors/fieldErrors zod-flatten
// shape covered by the tests above) is preferred when present and usable;
// otherwise, when `body.error` is itself an object (not a string code) and
// carries an `issues` array, a compact summary is built from it -- each
// surviving issue's own path/code/message, the three fields that actually
// explain WHAT was wrong and WHERE, same convention as the catalog
// entries' own structured detail shapes above (precondition_failed's
// failed[], low_confidence's missing[]).
//
// M2 fix-round finding (rc-v1-zod-degrade-details review): this summary
// used to feed ALL issues through the module's general DETAIL_CLAMP (5
// entries) / DETAIL_ENTRY_CHAR_BUDGET (60 chars), applied only later by
// clampGenericDetail. Measured: a realistic 5-issue zod-400 payload
// (templateData.acceptanceCriteria sent as an array, one issue per array
// index, "Expected string, received array") already sat at 1151/1200
// chars (96% of ERROR_BUDGET_CHARS) under that path; a longer but still
// perfectly ordinary message pushed the SAME 5-issue payload over budget
// and into enforceErrorBudget's emergency hard reclamp (2 entries, 20
// usable chars each) -- MORE issues produced STRICTLY LESS information.
// GENERIC_ISSUES_CLAMP / GENERIC_ISSUE_ENTRY_CHAR_BUDGET below give this
// summary its own tighter budget applied HERE, at derive time, before the
// general pass ever runs, so the common case never needs the general
// clamp or the emergency reclamp at all (measured post-fix: comfortably
// under half of ERROR_BUDGET_CHARS for the same 5-issue fixture -- see
// tests/errors.test.ts).
//
// L3 fix-round finding: a mapped issue with no recognizable path/code/
// message (a null/number/string/array entry, or an object missing all
// three) is dropped BEFORE the GENERIC_ISSUES_CLAMP cut, not after --
// slicing by raw position first (this module's usual idiom, e.g.
// preconditionFailedError's rawFailed.slice(0, DETAIL_CLAMP).map(...)
// above) would let leading junk push a real issue out of the window
// entirely (measured: 5 null entries then 1 real one used to clamp down
// to 5 EMPTY {} objects, silently losing the only informative issue).
// `failed[]`/`missing[]` are backend-contract-bounded arrays where every
// entry is already usable by construction, so slicing first is safe
// there; `issues` is explicitly untrusted (this whole branch exists
// because it can be a raw SafeParseError), so usability has to be checked
// first. The one-time O(issues.length) map+filter this costs is the same
// order of work the pre-fix version of this function already did
// unconditionally (it mapped the WHOLE array with no clamp at all), so
// this is not a new cost, just a reordering of an existing one. If
// nothing in `issues` survives the filter (including the plain `issues:
// []` case), this falls through to the same object-passthrough branch
// used when `issues` is not a recognizable array at all, rather than
// emitting a misleading {issues: [], totalIssues: N}.
//
// `path` (zod's own array-of-string|number) is joined into a single
// dot-separated string rather than kept as a nested array: clampDetailValue
// caps recursion at GENERIC_DETAIL_MAX_DEPTH (3), and this summary's own
// container nesting (the top-level object -> issues[] -> issue object)
// already spends 2 of those 3 levels before `path` is even reached, so a
// nested array here would push every path SEGMENT one level past the
// depth guard and silently replace each with the truncation marker
// instead of clamping it -- verified against clampDetailValue directly
// before landing this. A joined string is exactly one more clamped level,
// well within budget, and reads just as well ("acceptanceCriteria" or
// "tags.2.name" for a nested/array path). L4 fix-round finding: a path
// segment that is itself not a string or number (malformed/hostile input)
// used to be silently filtered OUT of the joined path -- a real 6-segment
// path could read as a plausible 2-segment one ("ok.3"), directly
// contradicting this module's never-silent doctrine. Each unusable
// segment is now rendered as a visible '?' placeholder instead, so the
// segment COUNT stays honest even when a segment's own value cannot be
// shown.
//
// `code` itself still stays `http_<status>` in this case (an object is not
// a code -- see genericDegrade's own check below, unchanged). When
// `body.error` is an object but carries no recognizable `issues` array (or
// `issues` carried nothing usable, per L3 above), the object itself is
// passed through instead of staying completely silent -- a judgment call:
// any structured object the backend sends as `error` is more useful
// surfaced (clamped, by the same machinery) than dropped outright, even
// when this module cannot name its shape specifically. L6 fix-round
// finding: that passthrough used to forward the object VERBATIM, including
// a `stack` key when present -- measured live, a raw backend/framework
// error object can carry a full server-side stack trace (internal file
// paths, and, for a Prisma error, query metadata), which this module must
// never leak to a caller. `stack` is dropped before passthrough,
// unconditionally, whether or not this particular object actually has one.
const GENERIC_ISSUES_CLAMP = 3;
const GENERIC_ISSUE_ENTRY_CHAR_BUDGET = 40;

/** Summarizes a single zod issue (untrusted -- may not even be an object)
 *  into {path?, code?, message?}, each clamped to
 *  GENERIC_ISSUE_ENTRY_CHAR_BUDGET. Never throws regardless of input shape:
 *  a non-object issue, or one missing every recognizable field, degrades to
 *  an EMPTY object, which deriveGenericDetailSource's caller filters out
 *  (see the L3 fix-round finding in the comment above). See the same
 *  comment's L4 entry for why an unusable `path` segment becomes a visible
 *  '?' rather than being filtered out of the path. */
function summarizeZodIssue(issue: unknown): Record<string, unknown> {
  const i = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
  const entry: Record<string, unknown> = {};
  if (Array.isArray(i.path) && i.path.length > 0) {
    const rendered = i.path
      .map((seg) => (typeof seg === "string" || typeof seg === "number" ? seg : "?"))
      .join(".");
    entry.path = clamp(rendered, GENERIC_ISSUE_ENTRY_CHAR_BUDGET);
  }
  if (typeof i.code === "string") entry.code = clamp(i.code, GENERIC_ISSUE_ENTRY_CHAR_BUDGET);
  if (typeof i.message === "string") entry.message = clamp(i.message, GENERIC_ISSUE_ENTRY_CHAR_BUDGET);
  return entry;
}

function deriveGenericDetailSource(details: unknown, bodyError: unknown): unknown {
  if (details && typeof details === "object" && !Array.isArray(details)) return details;
  if (bodyError && typeof bodyError === "object" && !Array.isArray(bodyError)) {
    const body = bodyError as Record<string, unknown>;
    const issues = body.issues;
    if (Array.isArray(issues)) {
      const usable = issues
        .map(summarizeZodIssue)
        .filter((entry) => Object.keys(entry).length > 0)
        .slice(0, GENERIC_ISSUES_CLAMP);
      if (usable.length > 0) {
        // totalIssues is always the TRUE original count, never the
        // filtered/sliced length.
        return { issues: usable, totalIssues: issues.length };
      }
      // Nothing usable survived (see L3 above) -- fall through to the
      // object-passthrough branch below.
    }
    const { stack: _stack, ...rest } = body; // L6: never leak a backend stack trace.
    return rest;
  }
  return details;
}

// The backend's own body.error string is the most specific code available
// and consumers key on it (the mcp-bridge governance suite asserts a 409
// claim_blocked stays visible end to end), so the degrade passes it
// through when present; the status-derived http_<status> form is only the
// fallback for bodies that carry no code at all (including an OBJECT
// body.error -- an object is not a code, see deriveGenericDetailSource
// above for how it is used instead). Clamped like every other
// caller-visible string so a pathological body cannot blow the budget.
function genericDegrade(
  status: number,
  message: string,
  details: unknown,
  bodyError?: unknown,
): TeachingError {
  const code =
    typeof bodyError === "string" && bodyError.length > 0
      ? clamp(bodyError, DETAIL_ENTRY_CHAR_BUDGET)
      : `http_${status}`;
  return buildTeachingError({
    code,
    message,
    recipe: "call workflow_primer for the full lifecycle reference and today's known traps",
    allowedNext: ["workflow_primer"],
    detail: clampGenericDetail(deriveGenericDetailSource(details, bodyError)),
  });
}

/**
 * Maps a backend AgentTasksApiError's (status, body) to the teaching-error
 * shape. `verbContext`, when supplied, is the calling tool's own registered
 * name — see the precondition_failed catalog entry above for the one place
 * it changes the output.
 */
export function mapBackendError(status: number, rawBody: unknown, verbContext?: string): TeachingError {
  const body = asBackendBody(rawBody);
  const code = typeof body.error === "string" ? body.error : undefined;
  const message = backendMessage(body, status);

  if (status === 403 && code === "forbidden" && NOT_CLAIMED_PATTERN.test(message)) {
    return notClaimedError(message);
  }
  if (status === 403 && code === "forbidden" && FORCE_ADMIN_ONLY_PATTERN.test(message)) {
    return forceAdminOnlyError(message);
  }
  if (status === 409 && code === "already_claimed") {
    return alreadyClaimedError(body, message);
  }
  if (status === 422 && code === "precondition_failed") {
    return preconditionFailedError(body, verbContext);
  }
  if (status === 422 && code === "low_confidence") {
    return lowConfidenceError(body, message);
  }
  if (status === 400 && code === "cross_repo_pr_rejected") {
    return crossRepoRejectedError(message, verbContext);
  }
  if (status === 403 && code === "pr_author_mismatch") {
    return prAuthorMismatchError(message);
  }
  if (status === 409 && code === "conflict" && RESPEC_CONFLICT_PATTERN.test(message)) {
    return respecConflictError(message);
  }

  return genericDegrade(status, message, body.details, body.error);
}
