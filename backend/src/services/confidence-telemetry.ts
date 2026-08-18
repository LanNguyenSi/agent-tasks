/**
 * M5 calibration telemetry (task 698eeb01): collect the four signals the
 * overlay's "Milestone 5" names as future weight-tuning inputs, so a later,
 * DELIBERATELY SEPARATE milestone can calibrate the confidence-gate weights
 * against real outcomes. This milestone only COLLECTS — nothing here ever
 * auto-adjusts a threshold, a weight, or a project's `riskModifiers`. Only
 * THREE of the four are aggregated by `computeConfidenceTelemetryAggregates`
 * / the read endpoint today (see signal 2 below and MED-3, batch 18 review).
 *
 *   1. Review bounce-backs           -> `recordBounceBack` (task_finish
 *      outcome request_changes, cumulative per task across the rework loop)
 *   2. Agent clarification requests  -> NOT modeled here, and NOT because the
 *      data is already queryable elsewhere (a prior version of this comment
 *      claimed the `Comment` table alone was sufficient — that was wrong,
 *      corrected MED-3, batch 18 review): `Task` carries only the CURRENT
 *      claim (`claimedByAgentId`/`claimedByUserId`), and every terminal
 *      transition NULLS it, so which agent authored a given `Comment` on a
 *      task that has since changed hands or finished cannot be reconstructed
 *      from `Task` alone — it would need a join against the `AuditLog`
 *      claim-history trail (`task.claimed`/`task.released`/`task.reviewed`)
 *      to attribute each comment to the claim-holder at the time it was
 *      posted. That reconstruction is real work, not a free read, and is
 *      explicitly OUT OF SCOPE for this milestone — a follow-up task, not
 *      built here.
 *   3. Override frequency            -> read directly off `AuditLog`'s
 *      `task.claim_override_used` rows, grouped per project per week, by
 *      `computeConfidenceTelemetryAggregates`'s `overrideRatePerWeek`.
 *      `overrideUsed` on the row below is a per-task convenience flag (was
 *      this task's claim EVER force-overridden), not the week-bucketed
 *      signal itself.
 *   4. Low-score success / high-score failure -> `scoreAtClaim` cross-
 *      referenced against `finalStatus`, surfaced as `lowScoreSuccesses` /
 *      `highScoreFailures` plus the per-band breakdowns.
 *
 *      HIGH-2 (batch 18 review): `finalStatus` can currently only ever be
 *      `"done"` in production. `routes/workflows.ts`'s `FIXED_TERMINAL_STATES`
 *      locks the terminal-state set to `{"done"}` server-side (the state
 *      vocabulary itself is fixed, not just its terminal flag), and no verb
 *      writes any other terminal disposition — `task_abandon` resets
 *      `status` back to the workflow's `initialState`, it does not write
 *      `"abandoned"`. Until a non-done terminal disposition exists (a filed
 *      follow-up), `highScoreFailures` is STRUCTURALLY 0 and
 *      `doneRateByScoreBand`'s `doneRate` is STRUCTURALLY 1.0 for every
 *      band with any terminal tasks in it — that is not evidence the
 *      confidence gate is well-calibrated, it is an artifact of there being
 *      only one reachable terminal outcome to measure against. This module
 *      and its tests still exercise a non-"done" `finalStatus` (fixture rows
 *      commented accordingly) to keep the aggregator's logic correct AHEAD
 *      of that write-path follow-up landing, per the "collect first" design
 *      — it is read-side support for a state production cannot reach yet,
 *      not a claim that the gap is already closed.
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
/** The `finalStatus` value that counts as a success in `doneRateByScoreBand`. */
export const DONE_STATUS = "done";

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
    await upsertConfidenceTelemetryWithRetry({
      where: { taskId },
      create: { taskId, projectId, finalStatus, taskType, ...claimFields },
      update: { finalStatus, taskType, ...updateClaimFields },
    });
  } catch (err) {
    logger.error(
      { component: "confidence-telemetry", op: "recordTerminalSnapshot", taskId, projectId, errMessage: (err as Error).message },
      "confidence telemetry terminal snapshot failed — task_finish transition proceeds regardless",
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
 * Not exported: internal to this module's two snapshot writers. Callers
 * that need it get it via `recordBounceBack` / `recordTerminalSnapshot`.
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
  bounceBackCount: number;
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

export interface ScoreBandDoneRate {
  band: string;
  taskCount: number;
  doneRate: number;
}

export interface ConfidenceTelemetryAggregates {
  overrideRatePerWeek: WeekBucket[];
  bounceBackByScoreBand: ScoreBandBounceBack[];
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

  // doneRateByScoreBand only counts rows that actually reached a terminal
  // transition (finalStatus set) — a task still mid-rework has no verdict yet.
  const terminal = scored.filter((r) => r.finalStatus !== null);
  const doneBuckets = new Map<string, { taskCount: number; doneCount: number }>();
  for (const row of terminal) {
    const band = scoreBand(row.scoreAtClaim);
    const bucket = doneBuckets.get(band) ?? { taskCount: 0, doneCount: 0 };
    bucket.taskCount += 1;
    if (row.finalStatus === DONE_STATUS) bucket.doneCount += 1;
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
    (r) => r.scoreAtClaim < LOW_SCORE_MAX && r.finalStatus === DONE_STATUS,
  ).length;
  const highScoreFailures = terminal.filter(
    (r) => r.scoreAtClaim >= HIGH_SCORE_MIN && r.finalStatus !== DONE_STATUS,
  ).length;

  return { overrideRatePerWeek, bounceBackByScoreBand, doneRateByScoreBand, lowScoreSuccesses, highScoreFailures };
}
