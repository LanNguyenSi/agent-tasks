// Read-verb projection layer (docs/response-contract-v1.md's "include
// semantics replacing verbose" section; rc-v1-C006). Mirrors receipt.ts's
// role for write verbs: this is the one place tasks_get's summary
// projection and signals_poll's mcp-server-side cap+cursor live. The
// clamping / no-silent-truncation conventions receipt.ts established for
// write-verb deviations (entry count clamp + per-entry char clamp + a
// total count marker + a visible truncation marker, never a silent drop)
// are reused here via receipt.ts's own exported clampEntries /
// ENTRY_TRUNCATION_MARKER instead of a second parallel implementation.

import { clampEntries, ENTRY_TRUNCATION_MARKER } from "./receipt.js";

// ── tasks_get: summary projection ───────────────────────────────────────
//
// docs/response-contract-v1.md's per-verb defaults table: "tasks_get (and
// equivalents) | summary". Unlike the write-verb receipts, the backend's
// GET /tasks/:id (backend/src/routes/tasks.ts) has no summary/verbose
// toggle of its own (unlike /tasks/claimable's claimableSummarySelect) --
// it always returns the full `taskInclude` relation graph -- so the
// summary projection happens entirely mcp-server-side, on every call,
// before applying `include`.

/** Minimal structural types for the fields this projection actually reads.
 *  The real backend task (taskInclude) carries many more fields
 *  (description, comments, attachments, artifacts, templateData, ...);
 *  this projection intentionally touches only what the summary and its
 *  include-gated additions need. */
export interface RawClaimUser {
  id: string;
  login?: string | null;
  name?: string | null;
}

export interface RawClaimAgent {
  id: string;
  name?: string | null;
}

export interface RawBlockedByEntry {
  id: string;
  title: string;
  status: string;
}

export interface RawTask {
  id: string;
  title: string;
  status?: string;
  priority?: string;
  labels?: string[];
  prUrl?: string | null;
  description?: string | null;
  comments?: unknown[];
  artifacts?: unknown[];
  claimedByUser?: RawClaimUser | null;
  claimedByAgent?: RawClaimAgent | null;
  reviewClaimedByUser?: RawClaimUser | null;
  reviewClaimedByAgent?: RawClaimAgent | null;
  blockedBy?: RawBlockedByEntry[];
  // project_tasks-only fields (task 3653962f): not read by tasks_get's own
  // projection, only by projectTaskListSummary below.
  externalRef?: string | null;
  createdAt?: string;
  templateData?: Record<string, unknown> | null;
}

/** The shape client.getTask() resolves to: `{ task }`, matching GET
 *  /tasks/:id's own response envelope verbatim (see backend/src/routes/
 *  tasks.ts). include:["task"] returns this unchanged. */
export interface GetTaskResponse {
  task: RawTask;
}

// The full read-verb include vocabulary (docs/response-contract-v1.md:
// ["task", "description", "comments", "instructions", "artifacts"]) minus
// "instructions" -- that value is task_start's own per-state prose
// (receipt.ts's deriveStartInstructions), not a field a plain task object
// carries, so it does not apply to tasks_get.
export const TASKS_GET_INCLUDE_VALUES = ["description", "comments", "artifacts", "task"] as const;
export type TasksGetIncludeValue = (typeof TASKS_GET_INCLUDE_VALUES)[number];

/** Short claim label for ONE claimant pair (a single relation, e.g. just
 *  claimedByUser/claimedByAgent, or just reviewClaimedByUser/
 *  reviewClaimedByAgent -- never both at once, see the call site below):
 *  prefers a resolved name, falls back to login, then to the bare id,
 *  always resolving to SOMETHING when a claimant is present so the summary
 *  never silently drops a claim it has data for. A present `user` wins
 *  outright over `agent` (checked first, unconditionally); `agent` is only
 *  consulted when `user` itself is absent. */
function shortClaim(
  user: RawClaimUser | null | undefined,
  agent: RawClaimAgent | null | undefined,
): string | undefined {
  const raw = user ? user.name || user.login || user.id : agent ? agent.name || agent.id : undefined;
  // Clamped via the same clampEntries helper every other summary-projection
  // field uses (CLAIM_CHAR_BUDGET, defined below), not left unbounded: a
  // resolved `name` in particular is caller/human-influenced free text with
  // no length limit enforced anywhere upstream of this projection.
  return raw !== undefined ? clampEntries([raw], { max: 1, entryChars: CLAIM_CHAR_BUDGET })[0] : undefined;
}

// Summary-projection clamps. Deliberately separate constants from
// receipt.ts's own DETAIL_CLAMP/ENTRY_CHAR_BUDGET (5 entries / 19 chars):
// those are tuned for the tier-2 DEVIATION budget (~400 tokens), a
// different, tighter target than tasks_get's own summary budget (see the
// budget tests in tests/read.test.ts). The clamp TECHNIQUE (count cap +
// per-entry char cap + total marker + visible "..." marker) is reused via
// clampEntries; only the numbers differ.
const LABELS_SUMMARY_CLAMP = 10;
const LABEL_CHAR_BUDGET = 60;
const BLOCKED_BY_SUMMARY_CLAMP = 10;
const BLOCKED_BY_TITLE_CHAR_BUDGET = 60;
// Per-entry char bound for a resolved claim label (shortClaim's own
// return value) and for prUrl. Both are, in principle, unbounded caller-
// or-backend-influenced strings: prUrl in particular has no max length on
// task_submit_pr's own input schema (tools.ts), so a caller could in
// principle submit an arbitrarily long one and have it echoed back
// verbatim by a later tasks_get call. Clamped here the same way
// labels/blockedBy already are (rc-v1-C006 round-2 review, LOW: the
// WORST CASE ceiling test previously left both unclamped, relying only on
// realistic-length fixture values rather than an actual bound). `title` is
// deliberately NOT clamped this way: unlike prUrl, it IS genuinely bounded
// today, independently, by both the backend's own createTaskSchema
// (backend/src/routes/tasks.ts: `title: z.string().min(1).max(255)`) and
// mcp-server's own task_create inputShape (tools.ts, same 255 max) -- and a
// caller reading a summary needs the task's actual title to identify the
// task, so silently shortening it would cost more in usability than the
// (already externally-bounded) worst case saves in budget. See the WORST
// CASE test's own comment in tests/read.test.ts for the same reasoning
// pinned alongside the fixture it documents.
const CLAIM_CHAR_BUDGET = 60;
const PRURL_CHAR_BUDGET = 100;

function clampBlockedBy(entries: RawBlockedByEntry[] | undefined): {
  blockedBy?: RawBlockedByEntry[];
  totalBlockedBy?: number;
} {
  if (!entries || entries.length === 0) return {};
  const clamped = entries.slice(0, BLOCKED_BY_SUMMARY_CLAMP).map((b) => ({
    id: b.id,
    title:
      b.title.length > BLOCKED_BY_TITLE_CHAR_BUDGET
        ? b.title.slice(0, BLOCKED_BY_TITLE_CHAR_BUDGET - ENTRY_TRUNCATION_MARKER.length) +
          ENTRY_TRUNCATION_MARKER
        : b.title,
    status: b.status,
  }));
  return entries.length > BLOCKED_BY_SUMMARY_CLAMP
    ? { blockedBy: clamped, totalBlockedBy: entries.length }
    : { blockedBy: clamped };
}

/** tasks_get's default response shape: id/title always present, every
 *  other field present only when the source data has it (never emitted as
 *  null/empty -- same presence convention as receipt.ts's Receipt). */
export interface TaskSummary {
  id: string;
  title: string;
  status?: string;
  priority?: string;
  labels?: string[];
  totalLabels?: number;
  claims?: { work?: string; review?: string };
  blockedBy?: RawBlockedByEntry[];
  totalBlockedBy?: number;
  prUrl?: string;
  // include-gated additions (TASKS_GET_INCLUDE_VALUES, minus "task" which
  // bypasses this projection entirely).
  description?: string;
  comments?: unknown[];
  artifacts?: unknown[];
}

/**
 * Builds the field set every summary projection shares (id/title/status/
 * priority/labels/claims/blockedBy/prUrl), independent of which verb is
 * calling it or which include-gated extras that verb layers on top.
 * Factored out so tasks_get (projectTaskSummary) and project_tasks
 * (projectTaskListSummary, task 3653962f) project the SAME core fields
 * the SAME way instead of maintaining two copies of this logic that could
 * drift apart.
 */
function projectTaskCore(task: RawTask): TaskSummary {
  const summary: TaskSummary = { id: task.id, title: task.title };
  if (task.status !== undefined) summary.status = task.status;
  if (task.priority !== undefined) summary.priority = task.priority;

  if (task.labels && task.labels.length > 0) {
    summary.labels = clampEntries(task.labels, {
      max: LABELS_SUMMARY_CLAMP,
      entryChars: LABEL_CHAR_BUDGET,
    });
    if (task.labels.length > LABELS_SUMMARY_CLAMP) summary.totalLabels = task.labels.length;
  }

  // Work and review claims are resolved by two independent shortClaim
  // calls, one per relation, never passed to a single call together --
  // there is no "work wins the tie against review" logic anywhere, because
  // shortClaim itself never sees both relations at once. Both can end up
  // present in `summary.claims` simultaneously (a task can be work-claimed
  // by one caller and separately review-claimed by another).
  const work = shortClaim(task.claimedByUser, task.claimedByAgent);
  const review = shortClaim(task.reviewClaimedByUser, task.reviewClaimedByAgent);
  if (work || review) {
    summary.claims = {};
    if (work) summary.claims.work = work;
    if (review) summary.claims.review = review;
  }

  const { blockedBy, totalBlockedBy } = clampBlockedBy(task.blockedBy);
  if (blockedBy) summary.blockedBy = blockedBy;
  if (totalBlockedBy !== undefined) summary.totalBlockedBy = totalBlockedBy;

  // Clamped like the claim labels above: task_submit_pr's own input schema
  // (tools.ts) has no max length on prUrl, so this is genuinely unbounded
  // upstream, unlike `title` (see PRURL_CHAR_BUDGET's own doc comment).
  if (task.prUrl) {
    summary.prUrl = clampEntries([task.prUrl], { max: 1, entryChars: PRURL_CHAR_BUDGET })[0];
  }

  return summary;
}

/**
 * Projects a raw GET /tasks/:id response to the summary shape, or (on
 * include:["task"]) returns it unchanged. Defensive guard mirrors
 * receipt.ts's hasTaskId: a malformed body (no task.id) is returned raw
 * rather than crashing on a dereference.
 */
export function projectTaskSummary(
  response: GetTaskResponse,
  include?: readonly string[],
): GetTaskResponse | { task: TaskSummary } {
  if (include?.includes("task")) return response;
  if (!response?.task?.id) return response;

  const task = response.task;
  const summary = projectTaskCore(task);

  if (include?.includes("description") && task.description) summary.description = task.description;
  if (include?.includes("comments") && task.comments) summary.comments = task.comments;
  if (include?.includes("artifacts") && task.artifacts) summary.artifacts = task.artifacts;

  return { task: summary };
}

// ── project_tasks: summary-rows-by-default list projection (task 3653962f)
//
// GET /projects/:id/tasks returns `{ tasks: RawTask[], nextCursor }` with
// every row carrying the FULL backend task shape (description,
// templateData, timestamps, claim relations, ...). A 40-row listing where
// several rows carry multi-kB descriptions/templateData blows well past a
// comfortable tool-result size for a browse-scoped verb whose whole point
// is "what is open in project X", so each row is now projected down to a
// summary the same way tasks_get's single-task projection already is
// (shared core: projectTaskCore above), plus two list-specific fields
// (externalRef, createdAt) that are useful for browsing/dedup identification
// and cheap (short, bounded-ish strings) to carry on every row.
// `nextCursor` is untouched -- it addresses full backend task ids, not
// projected rows, so no interaction with the projection.

/** project_tasks's own include vocabulary. Narrower than tasks_get's
 *  (TASKS_GET_INCLUDE_VALUES): no "comments"/"artifacts" -- a project_tasks
 *  row has no per-row comments/artifacts use case the way a single
 *  tasks_get call does -- but adds "templateData", the one full-row field
 *  a project_tasks caller plausibly wants back without paying for
 *  include:["task"]'s full raw rows. */
export const PROJECT_TASKS_INCLUDE_VALUES = ["description", "templateData", "task"] as const;
export type ProjectTasksIncludeValue = (typeof PROJECT_TASKS_INCLUDE_VALUES)[number];

/** project_tasks's default row shape: projectTaskCore's fields plus
 *  externalRef/createdAt (list-only; tasks_get's TaskSummary does not
 *  carry either), plus the two include-gated additions this verb accepts. */
export interface TaskListSummary extends TaskSummary {
  externalRef?: string;
  createdAt?: string;
  templateData?: Record<string, unknown>;
}

/** The shape client.listProjectTasks() resolves to: `{ tasks, nextCursor }`,
 *  matching GET /projects/:id/tasks's own response envelope verbatim.
 *  include:["task"] returns this unchanged. */
export interface ListProjectTasksResponse {
  tasks: RawTask[];
  nextCursor: string | null;
}

/**
 * Projects a raw GET /projects/:id/tasks response to summary rows, or (on
 * include:["task"]) returns it unchanged. Defensive guard mirrors
 * projectTaskSummary's own: a malformed body (no `tasks` array) is
 * returned raw rather than crashing on a dereference. `nextCursor` passes
 * through untouched in both branches.
 */
export function projectTaskListSummary(
  response: ListProjectTasksResponse,
  include?: readonly string[],
): ListProjectTasksResponse | { tasks: TaskListSummary[]; nextCursor: string | null } {
  if (include?.includes("task")) return response;
  if (!response || !Array.isArray(response.tasks)) return response;

  const tasks = response.tasks.map((task): TaskListSummary => {
    const summary: TaskListSummary = projectTaskCore(task);
    if (task.externalRef) summary.externalRef = task.externalRef;
    if (task.createdAt) summary.createdAt = task.createdAt;
    if (include?.includes("description") && task.description) summary.description = task.description;
    if (include?.includes("templateData") && task.templateData) summary.templateData = task.templateData;
    return summary;
  });

  return { tasks, nextCursor: response.nextCursor ?? null };
}

// ── signals_poll: mcp-server-side cap + cursor ──────────────────────────
//
// The motivating measurement (docs/response-contract-v1.md): a single
// observed signals_poll call cost 9.5k tokens -- an unbounded backlog
// returned in one shot. The backend route (backend/src/routes/signals.ts)
// already accepts `limit` (default 50, hard max 200) but has no cursor
// param of its own, and backend pagination is explicitly out of scope for
// this task, so the cap and the "no signal is silently lost" guarantee are
// both implemented here, entirely client-side: fetch up to the backend's
// own max in one call (client.ts's pollSignals(SIGNALS_BACKEND_FETCH_LIMIT)),
// then slice+cursor that array locally. Signals are ordered oldest-first
// and stable across calls as long as none are acked/created in between
// (backend/src/services/signal.ts: `orderBy: { createdAt: "asc" }`), so a
// signal id is a valid resume point.

export const SIGNALS_DEFAULT_LIMIT = 10;
/** Caller-requestable ceiling on a single signals_poll response. */
export const SIGNALS_MAX_LIMIT = 100;
/** What mcp-server itself asks the backend for, regardless of the caller's
 *  own `limit` -- the backend's own hard max (backend/src/routes/
 *  signals.ts), so the full pending backlog (up to that ceiling) is always
 *  in hand to slice+cursor locally. */
export const SIGNALS_BACKEND_FETCH_LIMIT = 200;

export interface RawSignal {
  id: string;
  [key: string]: unknown;
}

export interface SignalsPollResult {
  signals: RawSignal[];
  /** Present only when more signals exist beyond this page WITHIN `all`
   *  (report by exception, same philosophy as receipt.ts's deviations
   *  tier: never silently truncated). This is local pagination only -- see
   *  atBackendFetchCeiling for the separate "the fetch itself might be an
   *  undercount" signal. */
  truncated?: boolean;
  /** Pass back as `cursor` on the next call to resume exactly where this
   *  page left off. Present only alongside truncated:true. */
  cursor?: string;
  /** rc-v1-C006 round-2 review (HIGH): set (true) whenever `all.length` hit
   *  SIGNALS_BACKEND_FETCH_LIMIT -- the single backend fetch this array came
   *  from may itself be an undercount of the true pending backlog (the
   *  backend has no cursor of its own; mcp-server always asks for its hard
   *  max in one shot). Before this field existed, the LAST local page of an
   *  at-ceiling fetch reported truncated:false (nothing left in `all`),
   *  which read as "backlog fully drained" even when the backend backlog
   *  was actually larger than what this one fetch could return (measured: a
   *  260-signal backlog delivers only 200, and the final local page over
   *  those 200 said truncated:false). truncated and atBackendFetchCeiling
   *  answer two different questions ("more left in what I already fetched"
   *  vs "what I fetched might not be everything") and are therefore
   *  independent flags, not one folded into the other -- forcing
   *  truncated:true here would make a caller loop forever re-requesting a
   *  cursor that never advances past the fetched window's own end. A caller
   *  that sees this on ANY page (not only the final one, since it describes
   *  the underlying fetch, not the page) should ack what it received and
   *  poll again rather than treating the backlog as drained once
   *  truncated stops appearing. */
  atBackendFetchCeiling?: boolean;
}

/**
 * Slices `all` (the full backend-fetched backlog, oldest-first) starting
 * just after `cursor` (or from the start when absent/not found -- a
 * cursor whose signal has since been acked or aged out of the backend's
 * own fetch window falls back to the start rather than silently dropping
 * everything), returning at most `limit` entries. Sets truncated+cursor
 * whenever more remain WITHIN `all`, so a caller can never lose a signal
 * by not noticing the response was capped; sets atBackendFetchCeiling
 * independently whenever `all` itself reached the backend's own fetch
 * ceiling, since that is a fact about the fetch, not about which page of
 * it a caller happens to be reading.
 */
export function paginateSignals(
  all: readonly RawSignal[],
  opts: { cursor?: string; limit?: number } = {},
): SignalsPollResult {
  const limit = opts.limit ?? SIGNALS_DEFAULT_LIMIT;
  let startIndex = 0;
  if (opts.cursor) {
    const idx = all.findIndex((s) => s.id === opts.cursor);
    startIndex = idx === -1 ? 0 : idx + 1;
  }
  const page = all.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + page.length < all.length;
  const result: SignalsPollResult = { signals: page };
  if (hasMore) {
    result.truncated = true;
    const last = page[page.length - 1];
    if (last) result.cursor = last.id;
  }
  if (all.length >= SIGNALS_BACKEND_FETCH_LIMIT) {
    result.atBackendFetchCeiling = true;
  }
  return result;
}
