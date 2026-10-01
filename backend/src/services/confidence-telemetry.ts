/**
 * M5 calibration telemetry (task 698eeb01): collect the four signals the
 * overlay's "Milestone 5" names as future weight-tuning inputs, so a later,
 * DELIBERATELY SEPARATE milestone can calibrate the confidence-gate weights
 * against real outcomes. This milestone only COLLECTS — nothing here ever
 * auto-adjusts a threshold, a weight, or a project's `riskModifiers`. All
 * four are aggregated by `computeConfidenceTelemetryAggregates` / the read
 * endpoint (signal 2 via `recordClarification`, see below).
 *
 *   1. Review bounce-backs           -> `recordBounceBack` (task_finish
 *      outcome request_changes, cumulative per task across the rework loop)
 *   2. Agent clarification requests  -> `recordClarification`
 *      (`clarificationCount`). Counted LIVE at comment time, while the claim
 *      still exists, because every terminal transition NULLS
 *      `claimedByAgentId`/`claimedAt` and attributing a past comment to its
 *      claim-holder afterwards would need an `AuditLog` join. A comment
 *      counts only when it is posted through `POST /tasks/:id/comments`
 *      (`tasks_comment` / `task_note`) by an AGENT that holds the task's
 *      active work claim (`actor.tokenId === task.claimedByAgentId`) while
 *      the task sits in a work state. Human claim-holders, reviewers,
 *      comments in review, system comments and review-route comments do not
 *      count. Rows that predate the column read as 0.
 *   3. Override frequency            -> read directly off `AuditLog`'s
 *      `task.claim_override_used` rows, grouped per project per week, by
 *      `computeConfidenceTelemetryAggregates`'s `overrideRatePerWeek`.
 *      `overrideUsed` on the row below is a per-task convenience flag (was
 *      this task's claim EVER force-overridden), not the week-bucketed
 *      signal itself.
 *   4. Low-score success / high-score failure -> `scoreAtClaim` cross-
 *      referenced against the task's outcome, surfaced as `lowScoreSuccesses`
 *      / `highScoreFailures` plus the per-band breakdowns. The outcome is
 *      `finalDisposition ?? finalStatus`:
 *        - `finalDisposition` "done" is written by `recordTerminalSnapshot`
 *          (review-approve at a terminal transition; create and update).
 *        - `finalDisposition` "abandoned" is written by
 *          `recordAbandonDisposition` after a successful creator-abandon
 *          (`POST /tasks/:id/creator-abandon`). The realistic failure path
 *          is: an agent claims (a gate-scored snapshot lands in the audit
 *          trail), gives up via `task_abandon` (the task is open again), and
 *          the creator then creator-abandons it. A creator-abandon of a task
 *          that never had a scored claim writes nothing (no row is created).
 *        - `clearDisposition` nulls it when a project admin restores an
 *          abandoned task to the initial state (the task is no longer
 *          terminal); it never creates a row. An abandoned -> reopened ->
 *          reclaimed -> done sequence ends with "done" because the terminal
 *          upsert overwrites.
 *        - `task_abandon` and `POST /tasks/:id/release` only release a claim
 *          (status goes back to the initial state): they are not terminal
 *          and write no disposition. A backlog discard is never hooked: a
 *          backlog task is never claimable, so it cannot have a score
 *          snapshot.
 *        - `finalStatus` stays "done"-only (the status vocabulary is fixed);
 *          rows that predate `finalDisposition` keep counting as done via the
 *          `??` fallback.
 *      Only a task with a recorded scored claim can move `highScoreFailures`
 *      or the non-done share of `doneRateByScoreBand`; both start varying
 *      only as such tasks are creator-abandoned.
 *
 * `scoreAtClaim` / `effectiveThreshold` / `overrideUsed` are sourced from the
 * confidence-gate's OWN audit trail (`task.claim_would_block_shadow` /
 * `task.claim_override_used` / `task.claim_confidence_recorded` — see
 * services/confidence-gate.ts and services/audit.ts), recorded AT CLAIM TIME.
 * They are never recomputed here: the task's description can have changed
 * since (a respec), so recomputing at finish time would silently score the
 * WRONG snapshot. A task claimed by a human, or claimed under an
 * `enforcementMode=OFF` project, never has one of these audit rows — the
 * gate does not evaluate either case — so `scoreAtClaim` /
 * `effectiveThreshold` stay null for it. That is a known, documented gap,
 * not a bug: this milestone reuses the gate's existing instrumentation
 * rather than adding a parallel one.
 *
 * MED-7 (batch 18 review): reading `AuditLog` back as above is a deliberate,
 * documented EXCEPTION to this codebase's general audit policy ("audit
 * writes are fire-and-forget and swallow errors: never depend on audit
 * being load-bearing for any flow" — docs/domain-model.md, docs/events.md).
 * Chosen here (over adding a `snapshotSource` discriminator to the response)
 * as the cheaper fix for a collection-only milestone: a follow-up should
 * snapshot `scoreAtClaim`/`effectiveThreshold` directly inside the claim
 * transaction instead of reading them back off the audit trail, which would
 * close the gap properly rather than merely documenting it.
 *
 * Every write in this module is BEST-EFFORT and FAILS OPEN: a DB error is
 * logged and swallowed, never thrown, so a telemetry hiccup can never block
 * the task_finish transition it rides along with. See
 * `backend/tests/unit/confidence-telemetry.test.ts` for the pinned fail-open
 * behaviour.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/**
 * LOW-8 (batch 18 review): a single retry on P2002 (unique constraint
 * violation on `taskId`). Two concurrent calls into `recordBounceBack` /
 * `recordTerminalSnapshot` for the SAME task (e.g. a racing bounce-back and
 * terminal snapshot, or two retried task_finish requests) can both observe
 * no existing row and race on `upsert`'s internal create path; the loser
 * throws P2002 instead of falling through to `update`. Re-running the SAME
 * upsert once finds the winner's row and takes the `update` branch instead
 * of losing this write entirely. Any other error (including a P2002 on the
 * retry itself) propagates to the caller's fail-open try/catch unchanged.
 */
async function upsertConfidenceTelemetryWithRetry(
  args: Parameters<typeof prisma.confidenceTelemetry.upsert>[0],
): Promise<void> {
  try {
    await prisma.confidenceTelemetry.upsert(args);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await prisma.confidenceTelemetry.upsert(args);
      return;
    }
    throw err;
  }
}

/** Score-at-claim below this is "low" for `lowScoreSuccesses` (exclusive upper bound). */
export const LOW_SCORE_MAX = 60;
/** Score-at-claim at/above this is "high" for `highScoreFailures` (inclusive lower bound). */
export const HIGH_SCORE_MIN = 90;
/** The outcome (`finalDisposition ?? finalStatus`) that counts as a success in `doneRateByScoreBand`. */
export const DONE_STATUS = "done";
/** The `finalDisposition` written for a creator-abandoned task (a failure outcome). */
export const ABANDONED_DISPOSITION = "abandoned";

/** Width of each score band in `bounceBackByScoreBand` / `doneRateByScoreBand`, e.g. "60-70". */
const BAND_WIDTH = 10;

/**
 * The three confidence-gate audit actions that carry a `score`/`threshold`
 * snapshot for a SUCCESSFUL agent claim (the claim actually went through).
 * `task.claim_blocked_low_readiness` is deliberately excluded: it means the
 * claim was DENIED, so it never became the task's active claim and must not
 * be read as "the" score-at-claim for whichever claim eventually succeeded.
 */
const CLAIM_SNAPSHOT_ACTIONS = [
  "task.claim_would_block_shadow",
  "task.claim_override_used",
  "task.claim_confidence_recorded",
] as const;

/** All four confidence-gate audit actions — every claim attempt the gate evaluated. */
export const CLAIM_EVALUATION_ACTIONS = [
  "task.claim_would_block_shadow",
  "task.claim_blocked_low_readiness",
  "task.claim_override_used",
  "task.claim_confidence_recorded",
] as const;

/**
 * Half-open score band containing `score`: `[lower, lower+10)`, except the
 * top band `"90-100"` which is closed on both ends (there is no `100-110`
 * band). `score` is clamped to `[0, 100]` first so an out-of-range value
 * (should not happen — `calculateConfidence` always returns 0-100 — but this
 * reads audit-log JSON, an unvalidated boundary) never produces a malformed
 * band label.
 */
export function scoreBand(score: number): string {
  const clamped = Math.max(0, Math.min(100, score));
  const lower = clamped >= 100 ? 90 : Math.floor(clamped / BAND_WIDTH) * BAND_WIDTH;
  return `${lower}-${lower + BAND_WIDTH}`;
}

/**
 * Best-effort, fail-open snapshot write for a `task_finish` outcome of
 * `request_changes` on this task's review. Called from BOTH the review-finish
 * and self-approve branches of `POST /tasks/:id/finish` in routes/tasks.ts —
 * see the Rework-Loop note in the M5 task brief.
 *
 * Upserts because a task can bounce back multiple times before eventually
 * reaching a terminal transition (or never does); each call increments the
 * existing row's `bounceBackCount`, or creates a fresh row (with whatever
 * claim-time snapshot is available right now) if this is the first bounce.
 */
export async function recordBounceBack(taskId: string, projectId: string): Promise<void> {
  try {
    const claimFields = await resolveClaimSnapshotFields(taskId);
    await upsertConfidenceTelemetryWithRetry({
      where: { taskId },
      create: { taskId, projectId, bounceBackCount: 1, ...claimFields },
      update: { bounceBackCount: { increment: 1 } },
    });
  } catch (err) {
    logger.error(
      { component: "confidence-telemetry", op: "recordBounceBack", taskId, projectId, errMessage: (err as Error).message },
      "confidence telemetry bounce-back snapshot failed — task_finish transition proceeds regardless",
    );
  }
}

/**
 * Best-effort, fail-open counter for signal 2 (agent clarification comments).
 * The caller decides eligibility (agent claim-holder, work state); this only
 * upserts: increments `clarificationCount` on the task's row, or creates the
 * row with a count of 1 and whatever claim-time snapshot is available now.
 * A failure (including the snapshot lookup) is logged and swallowed, so the
 * comment that triggered it is never blocked or altered.
 */
export async function recordClarification(taskId: string, projectId: string): Promise<void> {
  try {
    const claimFields = await resolveClaimSnapshotFields(taskId);
    await upsertConfidenceTelemetryWithRetry({
      where: { taskId },
      create: { taskId, projectId, clarificationCount: 1, ...claimFields },
      update: { clarificationCount: { increment: 1 } },
    });
  } catch (err) {
    logger.error(
      { component: "confidence-telemetry", op: "recordClarification", taskId, projectId, errMessage: (err as Error).message },
      "confidence telemetry clarification count failed - comment is posted regardless",
    );
  }
}

/**
 * Best-effort, fail-open snapshot write for a `task_finish` review-approve
 * outcome that reached a terminal transition (`isTerminalState` at the
 * caller). Called from BOTH the review-finish and self-approve branches,
 * for every autoMerge variant — the terminal-transition check already
 * happened by the time either branch calls this, so autoMerge vs. manual
 * close makes no difference here.
 *
 * Upserts so a task that bounced back earlier (an existing row with
 * `bounceBackCount > 0`) keeps that count when the terminal snapshot lands.
 */
export async function recordTerminalSnapshot(params: {
  taskId: string;
  projectId: string;
  finalStatus: string;
  taskType: string | null;
}): Promise<void> {
  const { taskId, projectId, finalStatus, taskType } = params;
  try {
    const claimFields = await resolveClaimSnapshotFields(taskId);
    // LOW-8 (batch 18 review): `claimFields.scoreAtClaim` / `effectiveThreshold`
    // can resolve to null (no claim-snapshot audit row for this task — see
    // the module header). Spreading them into `create` unconditionally is
    // safe (a fresh row has nothing to clobber), but spreading into `update`
    // unconditionally is NOT: it would overwrite a PREVIOUSLY recorded
    // non-null snapshot with null if a later resolve ever regresses to
    // null. Only include them in `update` when non-null, so an existing
    // value is preserved rather than clobbered. `overrideUsed` is monotonic
    // (the AuditLog query behind it is "did an override event EVER happen",
    // which can only go false -> true, never back) so it is always safe to
    // include as-is.
    const updateClaimFields = {
      ...(claimFields.scoreAtClaim !== null ? { scoreAtClaim: claimFields.scoreAtClaim } : {}),
      ...(claimFields.effectiveThreshold !== null ? { effectiveThreshold: claimFields.effectiveThreshold } : {}),
      overrideUsed: claimFields.overrideUsed,
    };
    // A terminal review-approve at the done status is the "done" disposition.
    // Writing it in BOTH create and update lets a reclaimed-then-done task
    // overwrite an earlier "abandoned" disposition.
    const dispositionFields = finalStatus === DONE_STATUS ? { finalDisposition: DONE_STATUS } : {};
    await upsertConfidenceTelemetryWithRetry({
      where: { taskId },
      create: { taskId, projectId, finalStatus, taskType, ...dispositionFields, ...claimFields },
      update: { finalStatus, taskType, ...dispositionFields, ...updateClaimFields },
    });
  } catch (err) {
    logger.error(
      { component: "confidence-telemetry", op: "recordTerminalSnapshot", taskId, projectId, errMessage: (err as Error).message },
      "confidence telemetry terminal snapshot failed — task_finish transition proceeds regardless",
    );
  }
}

/**
 * Best-effort, fail-open disposition write for a successful creator-abandon.
 * Called post-commit by `POST /tasks/:id/creator-abandon`, never inside the
 * status transaction. An existing row is updated to `finalDisposition`
 * "abandoned" (`finalStatus` is left untouched). A new row is created only
 * when `resolveClaimSnapshotFields` finds a scored claim (`scoreAtClaim !==
 * null`: the task was once gate-evaluated and claimed); otherwise nothing is
 * written, since an unscored row carries no score-vs-outcome signal.
 */
export async function recordAbandonDisposition(taskId: string, projectId: string): Promise<void> {
  try {
    const claimFields = await resolveClaimSnapshotFields(taskId);
    if (claimFields.scoreAtClaim !== null) {
      await upsertConfidenceTelemetryWithRetry({
        where: { taskId },
        create: { taskId, projectId, finalDisposition: ABANDONED_DISPOSITION, ...claimFields },
        update: { finalDisposition: ABANDONED_DISPOSITION },
      });
    } else {
      await prisma.confidenceTelemetry.updateMany({
        where: { taskId },
        data: { finalDisposition: ABANDONED_DISPOSITION },
      });
    }
  } catch (err) {
    logger.error(
      { component: "confidence-telemetry", op: "recordAbandonDisposition", taskId, projectId, errMessage: (err as Error).message },
      "confidence telemetry abandon disposition failed - creator-abandon proceeds regardless",
    );
  }
}

/**
 * Best-effort, fail-open reset of `finalDisposition` to null for a task that
 * is no longer terminal (an abandoned task restored to the initial state).
 * `updateMany` so it never creates a row and a missing row is a no-op.
 */
export async function clearDisposition(taskId: string): Promise<void> {
  try {
    await prisma.confidenceTelemetry.updateMany({
      where: { taskId },
      data: { finalDisposition: null },
    });
  } catch (err) {
    logger.error(
      { component: "confidence-telemetry", op: "clearDisposition", taskId, errMessage: (err as Error).message },
      "confidence telemetry disposition clear failed - restore proceeds regardless",
    );
  }
}

/**
 * Resolve `scoreAtClaim` / `effectiveThreshold` / `overrideUsed` for a task
 * from the confidence-gate's existing audit trail. `scoreAtClaim` /
 * `effectiveThreshold` come from the MOST RECENT of the three claim-snapshot
 * actions (a task can be reclaimed after a respec changes its score — the
 * latest claim's snapshot is the one describing the currently active claim).
 * `overrideUsed` is true if `task.claim_override_used` was EVER logged for
 * this task, even if a later reclaim superseded it — an override having
 * happened at all is the durable signal, not just the most recent claim.
 *
 * Not exported: internal to this module's three snapshot writers. Callers
 * that need it get it via `recordBounceBack`, `recordTerminalSnapshot` or
 * `recordClarification`.
 */
async function resolveClaimSnapshotFields(taskId: string): Promise<{
  scoreAtClaim: number | null;
  effectiveThreshold: number | null;
  overrideUsed: boolean;
}> {
  const [latest, overrideEvent] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { taskId, action: { in: [...CLAIM_SNAPSHOT_ACTIONS] } },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    }),
    prisma.auditLog.findFirst({
      where: { taskId, action: "task.claim_override_used" },
      select: { id: true },
    }),
  ]);
  const payload = (latest?.payload ?? {}) as { score?: unknown; threshold?: unknown };
  return {
    scoreAtClaim: typeof payload.score === "number" ? payload.score : null,
    effectiveThreshold: typeof payload.threshold === "number" ? payload.threshold : null,
    overrideUsed: overrideEvent !== null,
  };
}

// ── Read-side aggregation (GET /projects/:id/telemetry/confidence) ─────────

export interface ConfidenceTelemetryRow {
  scoreAtClaim: number | null;
  finalStatus: string | null;
  /** Absent/null on rows that predate the column; the outcome falls back to `finalStatus`. */
  finalDisposition?: string | null;
  bounceBackCount: number;
  clarificationCount: number;
}

export interface ClaimEventRow {
  action: string;
  createdAt: Date;
}

export interface WeekBucket {
  weekStart: string;
  overrideCount: number;
  totalClaims: number;
  rate: number;
}

export interface ScoreBandBounceBack {
  band: string;
  taskCount: number;
  avgBounceBackCount: number;
}

export interface ScoreBandClarification {
  band: string;
  taskCount: number;
  avgClarificationCount: number;
}

export interface ScoreBandDoneRate {
  band: string;
  taskCount: number;
  doneRate: number;
}

export interface ConfidenceTelemetryAggregates {
  overrideRatePerWeek: WeekBucket[];
  bounceBackByScoreBand: ScoreBandBounceBack[];
  clarificationByScoreBand: ScoreBandClarification[];
  doneRateByScoreBand: ScoreBandDoneRate[];
  lowScoreSuccesses: number;
  highScoreFailures: number;
}

/** Monday (UTC) of the ISO week containing `date`, formatted `YYYY-MM-DD`. */
function isoWeekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDay = d.getUTCDay() || 7; // Sunday (0) -> 7, so Monday is always day 1
  if (isoDay !== 1) d.setUTCDate(d.getUTCDate() - (isoDay - 1));
  return d.toISOString().slice(0, 10);
}

/** Ascending sort of `"lower-upper"` band labels by their numeric lower bound. */
function bandLower(band: string): number {
  return Number(band.split("-", 1)[0]);
}

/**
 * Pure aggregator behind `GET /projects/:id/telemetry/confidence`. Takes
 * already-fetched rows (the route does the prisma queries; this stays a pure
 * function so band-boundary behaviour is unit-testable with plain fixtures,
 * no DB or mocking required).
 */
export function computeConfidenceTelemetryAggregates(
  rows: ConfidenceTelemetryRow[],
  claimEvents: ClaimEventRow[],
): ConfidenceTelemetryAggregates {
  // overrideRatePerWeek: every claim-evaluation event bucketed by ISO week;
  // rate = overrides / all evaluated claims that week (0 when the week saw
  // no evaluated claims at all, never NaN/Infinity).
  const weekBuckets = new Map<string, { overrideCount: number; totalClaims: number }>();
  for (const event of claimEvents) {
    const week = isoWeekStart(event.createdAt);
    const bucket = weekBuckets.get(week) ?? { overrideCount: 0, totalClaims: 0 };
    bucket.totalClaims += 1;
    if (event.action === "task.claim_override_used") bucket.overrideCount += 1;
    weekBuckets.set(week, bucket);
  }
  const overrideRatePerWeek: WeekBucket[] = [...weekBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, { overrideCount, totalClaims }]) => ({
      weekStart,
      overrideCount,
      totalClaims,
      rate: totalClaims > 0 ? overrideCount / totalClaims : 0,
    }));

  // Score-banded aggregates only consider rows with a known scoreAtClaim
  // (human claims / OFF-mode projects have none — see module header).
  const scored = rows.filter((r): r is ConfidenceTelemetryRow & { scoreAtClaim: number } => r.scoreAtClaim !== null);

  const bounceBuckets = new Map<string, { taskCount: number; totalBounceBack: number }>();
  for (const row of scored) {
    const band = scoreBand(row.scoreAtClaim);
    const bucket = bounceBuckets.get(band) ?? { taskCount: 0, totalBounceBack: 0 };
    bucket.taskCount += 1;
    bucket.totalBounceBack += row.bounceBackCount;
    bounceBuckets.set(band, bucket);
  }
  const bounceBackByScoreBand: ScoreBandBounceBack[] = [...bounceBuckets.entries()]
    .sort(([a], [b]) => bandLower(a) - bandLower(b))
    .map(([band, { taskCount, totalBounceBack }]) => ({
      band,
      taskCount,
      avgBounceBackCount: taskCount > 0 ? totalBounceBack / taskCount : 0,
    }));

  const clarificationBuckets = new Map<string, { taskCount: number; totalClarification: number }>();
  for (const row of scored) {
    const band = scoreBand(row.scoreAtClaim);
    const bucket = clarificationBuckets.get(band) ?? { taskCount: 0, totalClarification: 0 };
    bucket.taskCount += 1;
    bucket.totalClarification += row.clarificationCount;
    clarificationBuckets.set(band, bucket);
  }
  const clarificationByScoreBand: ScoreBandClarification[] = [...clarificationBuckets.entries()]
    .sort(([a], [b]) => bandLower(a) - bandLower(b))
    .map(([band, { taskCount, totalClarification }]) => ({
      band,
      taskCount,
      avgClarificationCount: taskCount > 0 ? totalClarification / taskCount : 0,
    }));

  // doneRateByScoreBand only counts rows that actually reached a terminal
  // outcome (finalDisposition ?? finalStatus set): a task still mid-rework
  // has no verdict yet. The outcome falls back to finalStatus so rows that
  // predate finalDisposition (finalStatus "done") keep counting as done.
  const outcomeOf = (r: ConfidenceTelemetryRow): string | null => r.finalDisposition ?? r.finalStatus;
  const terminal = scored.filter((r) => outcomeOf(r) !== null);
  const doneBuckets = new Map<string, { taskCount: number; doneCount: number }>();
  for (const row of terminal) {
    const band = scoreBand(row.scoreAtClaim);
    const bucket = doneBuckets.get(band) ?? { taskCount: 0, doneCount: 0 };
    bucket.taskCount += 1;
    if (outcomeOf(row) === DONE_STATUS) bucket.doneCount += 1;
    doneBuckets.set(band, bucket);
  }
  const doneRateByScoreBand: ScoreBandDoneRate[] = [...doneBuckets.entries()]
    .sort(([a], [b]) => bandLower(a) - bandLower(b))
    .map(([band, { taskCount, doneCount }]) => ({
      band,
      taskCount,
      doneRate: taskCount > 0 ? doneCount / taskCount : 0,
    }));

  const lowScoreSuccesses = terminal.filter(
    (r) => r.scoreAtClaim < LOW_SCORE_MAX && outcomeOf(r) === DONE_STATUS,
  ).length;
  const highScoreFailures = terminal.filter(
    (r) => r.scoreAtClaim >= HIGH_SCORE_MIN && outcomeOf(r) !== DONE_STATUS,
  ).length;

  return {
    overrideRatePerWeek,
    bounceBackByScoreBand,
    clarificationByScoreBand,
    doneRateByScoreBand,
    lowScoreSuccesses,
    highScoreFailures,
  };
}
