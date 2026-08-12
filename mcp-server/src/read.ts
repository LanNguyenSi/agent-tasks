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

/** Short claim label: prefers a resolved name/login over the bare id, but
 *  always resolves to SOMETHING when a claimant is present, so the summary
 *  never silently drops a claim it has data for. Work claim wins ties
 *  against a stray review claim on the same field (a task cannot be both
 *  work- and review-claimed by the same relation slot). */
function shortClaim(
  user: RawClaimUser | null | undefined,
  agent: RawClaimAgent | null | undefined,
): string | undefined {
  if (user) return user.name || user.login || user.id;
  if (agent) return agent.name || agent.id;
  return undefined;
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

  if (task.prUrl) summary.prUrl = task.prUrl;

  if (include?.includes("description") && task.description) summary.description = task.description;
  if (include?.includes("comments") && task.comments) summary.comments = task.comments;
  if (include?.includes("artifacts") && task.artifacts) summary.artifacts = task.artifacts;

  return { task: summary };
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
  /** Present only when more signals exist beyond this page (report by
   *  exception, same philosophy as receipt.ts's deviations tier: never
   *  silently truncated). */
  truncated?: boolean;
  /** Pass back as `cursor` on the next call to resume exactly where this
   *  page left off. Present only alongside truncated:true. */
  cursor?: string;
}

/**
 * Slices `all` (the full backend-fetched backlog, oldest-first) starting
 * just after `cursor` (or from the start when absent/not found -- a
 * cursor whose signal has since been acked or aged out of the backend's
 * own fetch window falls back to the start rather than silently dropping
 * everything), returning at most `limit` entries. Sets truncated+cursor
 * whenever more remain, so a caller can never lose a signal by not
 * noticing the response was capped.
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
  return result;
}
