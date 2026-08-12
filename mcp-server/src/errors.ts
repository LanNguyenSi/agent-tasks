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
// targets). Every other catalog entry is verb-independent by construction.
//
// Catalog seed (docs/response-contract-v1.md's "Catalog seed" list, plus
// pr_author_mismatch from the read_first context on backend/src/routes/
// tasks.ts): not_claimed, already_claimed, precondition_failed,
// cross_repo_pr_rejected, pr_author_mismatch, force_admin_only,
// respec_conflict, result_not_plain_string. Every other backend error
// degrades to the generic shape (status-derived code, message passthrough,
// recipe -> workflow_primer) rather than being forwarded as raw text.
//
// No em dashes in this file's exported/emitted prose (repo convention,
// enforced today only for primer.ts's exported strings, applied here too
// since these messages are caller-facing prose of the same kind).

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
    /** Present only for catalog entries that carry structured detail
     *  (today: precondition_failed's `failed[]`). */
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
/** Per-entry char bound for a detail array's own string fields. */
const DETAIL_ENTRY_CHAR_BUDGET = 60;
/** Char bound for the top-level `message` and `recipe` strings — these can
 *  carry a raw backend message (a zod validation error, for one, can run to
 *  thousands of chars) or, for `recipe`, a hand-authored corrective sentence
 *  that must itself never grow into a prose blob. */
const MESSAGE_CHAR_BUDGET = 300;
const RECIPE_CHAR_BUDGET = 240;
const TRUNCATION_MARKER = "...";

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
  return {
    ok: false,
    error: {
      code: opts.code,
      message: clamp(opts.message, MESSAGE_CHAR_BUDGET),
      recipe: clamp(opts.recipe, RECIPE_CHAR_BUDGET),
      allowedNext: opts.allowedNext,
      ...(opts.detail ? { detail: opts.detail } : {}),
    },
  };
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
// caller does not hold the claim on the task (backend/src/routes/tasks.ts
// ~lines 2262, 3292, 3530). The backend's own `error` code is the generic
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
// (backend/src/routes/tasks.ts ~lines 1473, 1692). The backend's own code
// is already specific, so it is kept verbatim as this entry's code.
function alreadyClaimedError(message: string): TeachingError {
  return buildTeachingError({
    code: "already_claimed",
    message,
    recipe: "call task_finish or task_abandon on your current task before claiming another",
    allowedNext: ["task_finish", "task_abandon"],
  });
}

// 3. Branch precondition. task_start / task_finish / (the two deprecated v1
// routes tasks_update [PATCH /tasks/:id] and tasks_claim [POST
// /tasks/:id/claim]) all return 422
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
// a test fixture, must not be able to blow the response budget.
function preconditionFailedError(body: BackendErrorBody, verbContext: string | undefined): TeachingError {
  const rawFailed = Array.isArray(body.failed) ? body.failed : [];
  const rules = rawFailed.map((f) => (typeof f.rule === "string" ? f.rule : "unknown"));
  // Both `rule` and `message` are clamped, not just `message`: the real
  // backend's TransitionRule values are short (branchPresent/prPresent/
  // ciGreen/prMerged), but this function's input is untrusted response
  // data, not a value this module controls, so a malformed/oversized
  // `rule` string must not be able to blow the budget either.
  const clampedFailed = rawFailed.slice(0, DETAIL_CLAMP).map((f) => ({
    rule: clamp(typeof f.rule === "string" ? f.rule : "unknown", DETAIL_ENTRY_CHAR_BUDGET),
    message: clamp(typeof f.message === "string" ? f.message : "", DETAIL_ENTRY_CHAR_BUDGET),
  }));
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

// 4. cross_repo_pr_rejected. task_submit_pr rejects a prUrl that does not
// point at project.githubRepo with 400 (backend/src/routes/tasks.ts
// ~line 3358; the same code also guards PATCH /tasks/:id, the deprecated
// tasks_update path, ~lines 4034/4106). Backend code kept verbatim.
function crossRepoRejectedError(message: string): TeachingError {
  return buildTeachingError({
    code: "cross_repo_pr_rejected",
    message,
    recipe:
      "call task_submit_pr again with a prUrl on this project's own repo, or set deliverableRepo at create time when the deliverable is intentionally a different repo",
    allowedNext: ["task_submit_pr"],
  });
}

// 5. pr_author_mismatch. task_submit_pr rejects a prUrl whose PR was not
// authored by the delegation user, 403 (backend/src/routes/tasks.ts
// ~line 3419). Backend code kept verbatim.
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
// non-admins (backend/src/routes/tasks.ts ~line 5819, message "Only team
// admins can force a transition"). Same generic backend code as
// not_claimed, message-pattern matched, own code minted. No self-service
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

// 8. task_finish `result` as plain string. Unlike the other seven entries,
// the backend performs NO validation of this today (`result` is stored
// verbatim as free text) — this trap exists only at the mcp-server layer,
// triggered locally in tools.ts's task_finish handler BEFORE any request is
// sent, not mapped from a backend error. Exported separately (not reachable
// via mapBackendError, which only ever sees a real AgentTasksApiError) and
// paired with looksLikeStructuredWrapper, the detector tools.ts calls.
const XML_WRAP_PATTERN = /^<([a-zA-Z][\w:-]*)\b[^>]*>[\s\S]*<\/\1>$/;

/** True when `value` (trimmed) is itself a single XML-tag-wrapped string
 *  (matching open/close tag pair) or valid whole-string JSON. Deliberately
 *  conservative: only a value that IS entirely a wrapper, not one that
 *  merely contains an angle bracket or a brace somewhere in prose, counts
 *  (a legitimate progress note like "fixed the <Foo> component" must not
 *  trip this). */
export function looksLikeStructuredWrapper(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (XML_WRAP_PATTERN.test(trimmed)) return true;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function resultMustBePlainStringError(): TeachingError {
  return buildTeachingError({
    code: "result_not_plain_string",
    message: "result must be plain prose or markdown text, not wrapped in XML or JSON tags",
    recipe: "resubmit task_finish with result as plain text (no <tag>...</tag> or {...} wrapping)",
    allowedNext: ["task_finish"],
  });
}

// ── Generic degrade path ────────────────────────────────────────────────
//
// Any backend error not matched by one of the eight catalog entries above
// degrades structurally instead of being forwarded as raw text: the code is
// derived from the HTTP status (NOT the backend's own `error` field — that
// field is only trustworthy as a catalog SIGNAL, matched explicitly above;
// echoing it verbatim here would silently grow the catalog by accident
// every time the backend adds a new code), the message is passed through
// (clamped), and the recipe points at workflow_primer, the one call every
// caller can always make to recover.
function genericDegrade(status: number, message: string): TeachingError {
  return buildTeachingError({
    code: `http_${status}`,
    message,
    recipe: "call workflow_primer for the full lifecycle reference and today's known traps",
    allowedNext: ["workflow_primer"],
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
    return alreadyClaimedError(message);
  }
  if (status === 422 && code === "precondition_failed") {
    return preconditionFailedError(body, verbContext);
  }
  if (status === 400 && code === "cross_repo_pr_rejected") {
    return crossRepoRejectedError(message);
  }
  if (status === 403 && code === "pr_author_mismatch") {
    return prAuthorMismatchError(message);
  }
  if (status === 409 && code === "conflict" && RESPEC_CONFLICT_PATTERN.test(message)) {
    return respecConflictError(message);
  }

  return genericDegrade(status, message);
}
