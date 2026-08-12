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
// text.
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
    /** Present when this entry carries structured detail: today,
     *  precondition_failed's `failed[]`, low_confidence's
     *  score/threshold/missing[]/totalMissing, and, for the generic
     *  degrade path, a clamped passthrough of whatever `details` object
     *  the backend itself sent. */
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
  // low_confidence's structured payload (backend/src/middleware/error.ts's
  // lowConfidence: `errorResponse(..., confidence)` spreads the confidence
  // report in as `details`). Typed loosely (not `ConfidenceObj`-shaped)
  // since this module treats it as untrusted response data, same stance as
  // `failed` above.
  details?: unknown;
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
const KNOWN_RULE_CORRECTIVES: Record<string, string> = {
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
  // must not be able to blow the budget either. `message` is the known
  // rule's own-authored corrective (whole, never truncated) when the rule
  // is one of the four real ones, or the backend's own message clamped
  // otherwise (see KNOWN_RULE_CORRECTIVES above). The optional per-rule
  // `error` field (present today on ciGreen/prMerged when the underlying
  // GitHub call itself failed — e.g. "GitHub unreachable" vs. a clean "CI
  // red", the only thing distinguishing the two) is included, clamped,
  // whenever the backend actually sent one.
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

  return hasSuspiciousTagPair(trimmed);
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

/** Recursively clamps an arbitrary JSON-ish detail value: every string is
 *  char-clamped, every array is entry-clamped (both reuse
 *  DETAIL_ENTRY_CHAR_BUDGET / DETAIL_CLAMP, the same constants the catalog
 *  entries above use), and every object's keys are walked and KEPT (never
 *  dropped) with their own values clamped the same way. `depth` guards
 *  against a pathological/cyclic input from untrusted response data. */
function clampDetailValue(value: unknown, depth: number): unknown {
  if (depth > GENERIC_DETAIL_MAX_DEPTH) return "[detail nested too deep, truncated]";
  if (typeof value === "string") return clamp(value, DETAIL_ENTRY_CHAR_BUDGET);
  if (Array.isArray(value)) {
    return value.slice(0, DETAIL_CLAMP).map((v) => clampDetailValue(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = clampDetailValue(v, depth + 1);
    }
    return out;
  }
  // number, boolean, null, undefined: passed through unchanged.
  return value;
}

/** Clamps a whole `details` object for the generic degrade path. Returns
 *  undefined (so buildTeachingError omits `detail` entirely) when the
 *  backend sent nothing usable — not an object, an array, or empty. */
function clampGenericDetail(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    out[k] = clampDetailValue(v, 0);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function genericDegrade(status: number, message: string, details: unknown): TeachingError {
  return buildTeachingError({
    code: `http_${status}`,
    message,
    recipe: "call workflow_primer for the full lifecycle reference and today's known traps",
    allowedNext: ["workflow_primer"],
    detail: clampGenericDetail(details),
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

  return genericDegrade(status, message, body.details);
}
