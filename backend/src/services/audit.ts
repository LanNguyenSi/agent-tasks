/**
 * Audit Log Service
 *
 * Records all significant actions in the system.
 * Every task creation, claim, transition, token creation, etc. is logged here.
 * Audit logs are immutable — never deleted, never edited.
 */
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export type AuditAction =
  | "task.created"
  | "task.claimed"
  | "task.released"
  | "task.transitioned"
  | "task.transitioned.forced"
  | "task.commented"
  | "task.reviewed"
  | "task.review_rejected_self_reviewer"
  | "task.merge_rejected_bad_status"
  | "task.pr_submitted"
  | "project.created"
  | "project.updated"
  | "project.synced"
  | "token.created"
  | "token.revoked"
  // Emitted by renameAgentToken (services/agent-token-service.ts) with
  // payload { tokenId, from, to } capturing the old and new display name.
  // NOTE: `token.created` and `token.revoked` above are declared but
  // nothing emits them yet — a pre-existing gap, out of scope here.
  | "token.renamed"
  | "user.login"
  | "user.logout"
  | "user.registered"
  | "github.pr_created"
  | "github.pr_merged"
  | "github.pr_merge_failed"
  | "github.pr_commented"
  | "task.auto_merged"
  | "task.auto_merge_post_assert_failed"
  | "task.imported"
  | "task.artifact.created"
  | "task.artifact.deleted"
  // Human file-attachment uploads (image + text) and their deletion. The
  // sibling artifact events use created/deleted; attachments use `uploaded`
  // to distinguish a disk-backed file upload from the legacy URL-pointer
  // create path (which emits no audit event).
  | "task.attachment.uploaded"
  | "task.attachment.deleted"
  | "task.merged"
  | "task.pr_merged.blocked_self_merge"
  | "task.self_merge_notice_emitted"
  // Workflow mutations — added so admins editing gates, renaming
  // states, or dropping a custom workflow leave a reconstructible
  // trail. Previously the only record was `updated_at` on the row,
  // which made it impossible to see who disabled a gate or when.
  | "workflow.created"
  | "workflow.customized"
  | "workflow.updated"
  | "workflow.reset"
  | "workflow.template_applied"
  // Phase 3 grounding finish-gate. Fires on `/tasks/:id/finish` work-claim
  // path when a debug-flavored task would have hit the gate but the project
  // is not opted in (`requireGroundingForDebug=false`). Lets operators
  // retroactively see what would have been blocked.
  | "task.grounding_gate.bypassed"
  // Per-project sharing. Track invite lifecycle and member removal so
  // the audit trail shows who shared a project with whom and why a
  // ProjectMember row appeared or vanished.
  | "project.invite_created"
  | "project.invite_consumed"
  | "project.invite_revoked"
  | "project.member_removed"
  // Auto-flip emitted by the invite accept-handler when the first
  // ProjectMember consumes an invite on a previously-soloMode project.
  // soloMode bypasses the distinct-reviewer gate; once a second human is
  // in the loop, the gate must become real.
  | "project.solo_mode_disabled_by_share"
  // ADR-0011 confidence-gate events. Blocked: agent claim refused
  // because score < threshold. Override: agent claim allowed via
  // ?force=true + forceReason where the score would have been blocked.
  // Override-with-passing-score is NOT recorded (force is a no-op).
  | "task.claim_blocked_low_readiness"
  | "task.claim_override_used"
  // scorer-v2 (T5): in WARN enforcement mode, a claim that WOULD have blocked
  // (below threshold or a violated keystone) but was allowed through. The
  // shadow signal that quantifies block blast radius before a project flips to
  // BLOCK. Carries score/threshold/keystoneBlocked/caps in the payload.
  | "task.claim_would_block_shadow"
  // M5 (task 698eeb01): calibration telemetry needs `scoreAtClaim` for EVERY
  // agent claim the confidence gate evaluates, not just the three decision
  // branches above (would-block / blocked / override) — otherwise the most
  // common outcome, a clean claim with nothing to shadow or block, would
  // leave no claim-time score on record for task_finish's snapshot hook to
  // read later (see services/confidence-telemetry.ts). Fired once per
  // successful agent claim that did NOT already produce one of the three
  // events above. Carries the same score/threshold/thresholdSource/
  // triggeredRiskModifiers/route/actorType shape.
  | "task.claim_confidence_recorded"
  // Opt-in reclassification of the debugFlavor flag. Fired when a caller
  // passes `reclassify=true` on task_pickup or task_start and the classifier
  // produces a different result than the persisted value.
  | "task.debugFlavor.reclassified"
  // Outbound Signal-webhook delivery. Fired by
  // services/notification-webhook.ts after every POST attempt the project's
  // `notificationWebhookUrl` produces. `delivered` records the final
  // success (2xx after at most one retry); `failed` records the give-up
  // after the retry. Both carry the signalId so operators can correlate
  // with the originating Signal row.
  | "signal.webhook_delivered"
  | "signal.webhook_failed"
  // Cross-repo deliverable override (ADR-0010 §5c). `_set` fires at create
  // time (non-null only); `_changed` fires on a PATCH set/change/clear (the
  // admin-only path — see routes/tasks.ts). `foreign_pr_linked` fires on any
  // write path that links a prUrl while the task's effective deliverable
  // repo diverges from project.githubRepo.
  | "task.deliverable_repo_set"
  | "task.deliverable_repo_changed"
  | "task.foreign_pr_linked"
  // Human-project-admin escape hatch (POST /tasks/:id/admin-release): an
  // admin force-releases a work or review claim held by ANYONE, without
  // touching task.status. One event per claim actually released (no event
  // for an idempotent no-op where the claim was already gone).
  | "task.claim_released_by_admin"
  | "task.review_claim_released_by_admin"
  // Respec verb (POST /tasks/:id/respec): an agent (creator, or any agent
  // when the project's allowNonCreatorRespec flag is set) or a human with
  // project write access corrected description/templateData on an OPEN+
  // UNCLAIMED task instead of delete+recreate. Payload carries the full
  // {from,to} of every changed field (capped per field beyond 8KB
  // serialized — see respecAuditValue in routes/tasks.ts) plus the
  // before/after confidence score. Fired only when at least one field
  // actually changed.
  | "task.respec"
  // Create-time workflowId project-ownership check (task 28bdcdfd, follow-up
  // to task 5107416c / task.deliverable_repo_set's sibling). Fires when the
  // `findFirst({ id, projectId })` lookup in routes/tasks.ts comes back
  // empty for a caller-supplied workflowId — which covers BOTH a workflow
  // that belongs to a DIFFERENT project and a workflowId that does not
  // exist at all; the compound filter cannot tell the two apart, so this
  // event does not claim the id was necessarily foreign, only that it was
  // rejected. The request is rejected with 400 before any task row exists,
  // so this carries no taskId. Without this event the denial was invisible:
  // no audit trail of who tried to route a create through a workflow id
  // this project does not own (potentially a gate-relaxing template from
  // another project).
  | "task.workflow_id_rejected_cross_project"
  // Creator-abandon verb (POST /tasks/:id/creator-abandon, task 7a1360da):
  // lets the agent that CREATED a task retire it to status="abandoned"
  // without ever claiming it. Narrow authz: creator-only (no
  // allowNonCreatorRespec-style relaxation), open-only, fully unclaimed
  // (mirrors task_respec's CAS guard); see the route's block comment in
  // routes/tasks.ts for why "abandoned" is safe to write directly even
  // though it is outside the workflow engine's fixed state vocabulary.
  // Payload carries { actorType: "agent", agentTokenId, previousStatus,
  // reason } so operators can see who gave up on the task and why.
  | "task.creator_abandoned"
  // Unabandon: the ONE recovery path out of the `abandoned` sink (review
  // finding on task 7a1360da's follow-up). PATCH /tasks/:id, human lane
  // only, project-admin-only, and only `abandoned -> effectiveDef.
  // initialState` — every other from=abandoned target still 400s. See the
  // "abandoned" block comment above POST /tasks/:id/creator-abandon in
  // routes/tasks.ts for why this is the one door back in. Distinct from
  // "task.transitioned" so the audit trail can tell a workflow-engine move
  // apart from this out-of-band recovery write.
  | "task.unabandoned";

export interface AuditPayload {
  [key: string]: unknown;
}

export async function logAuditEvent(opts: {
  action: AuditAction;
  // MUST be a valid `users.id` or omitted/undefined — `AuditLog.actorId` FKs
  // to `users(id)` (schema.prisma), never to an agent token id. An agent
  // caller has no user-scoped identity to attribute the action to here; use
  // the repo idiom `actor.type === "human" ? actor.userId : undefined` (33
  // call sites in routes/tasks.ts) and put the token id in `payload`
  // instead (e.g. `actorTokenId`). Passing a token id here is a SILENT bug:
  // the resulting 23503 FK violation is swallowed below (see the try/catch
  // comment), so the row simply never persists — no error surfaces anywhere.
  // HIGH-1 (batch 18 review, task 698eeb01 fix round): this exact mistake
  // dropped every `task.claim_confidence_recorded` /
  // `task.claim_would_block_shadow` / `task.claim_blocked_low_readiness` /
  // `task.claim_override_used` row for an agent claim until fixed — see
  // services/claim-policy-evaluator.ts and services/confidence-gate.ts.
  actorId?: string;
  projectId?: string;
  taskId?: string;
  payload?: AuditPayload;
}): Promise<void> {
  // Audit writes are fire-and-forget (`void logAuditEvent(...)`) from
  // every call site so the 200 response isn't blocked on audit latency.
  // That means any rejection here becomes an unhandled promise rejection,
  // which crashes the Node process under the default `throw` policy.
  // Swallow the rejection with a structured log line so a DB hiccup or
  // constraint violation can't take the backend down — audit is
  // supplementary, not load-bearing. NOTE: this also means an invalid
  // `actorId` (e.g. an agent token id — see the doc comment above) fails
  // SILENTLY from every caller's perspective; there is no runtime signal
  // short of reading this log line.
  try {
    await prisma.auditLog.create({
      data: {
        action: opts.action,
        actorId: opts.actorId ?? null,
        projectId: opts.projectId ?? null,
        taskId: opts.taskId ?? null,
        payload: (opts.payload ?? {}) as object,
      },
    });
  } catch (err) {
    logger.error(
      {
        component: "audit",
        action: opts.action,
        actorId: opts.actorId ?? null,
        projectId: opts.projectId ?? null,
        taskId: opts.taskId ?? null,
        errMessage: (err as Error).message,
      },
      "audit log write failed",
    );
  }
}

export async function getAuditLogs(opts: {
  projectId?: string;
  taskId?: string;
  actorId?: string;
  action?: string;
  actionPrefix?: string;
  limit?: number;
  offset?: number;
}) {
  return prisma.auditLog.findMany({
    where: {
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      ...(opts.action ? { action: opts.action } : {}),
      ...(opts.actionPrefix ? { action: { startsWith: opts.actionPrefix } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
    skip: opts.offset ?? 0,
  });
}
