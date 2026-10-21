---
type: invariant
title: "Signals: recipients, pull inbox, acknowledgement and webhook push delivery"
description: "A Signal row is the durable notification and the pull inbox is authoritative; recipients are fixed per signal type, done paths acknowledge pending asks before they emit outcome signals, and a project's notification webhook gets a best-effort push copy of each new row behind an egress guard."
tags: [signals, notifications, webhook, pickup, egress]
timestamp: 2026-10-21T04:59:16Z
sources:
  - backend/prisma/schema.prisma
  - backend/src/services/signal.ts
  - backend/src/services/notification-webhook.ts
  - backend/src/services/review-signal.ts
  - backend/src/services/task-signal.ts
  - backend/src/services/force-transition-signal.ts
  - backend/src/services/self-merge-notice.ts
  - backend/src/services/grounding-route-effects.ts
  - backend/src/services/grounding-completion.ts
  - backend/src/routes/grounding-creation.ts
  - backend/src/routes/signals.ts
  - backend/src/routes/tasks.ts
  - backend/src/routes/projects.ts
  - backend/src/routes/github.ts
  - backend/src/services/github-webhook.ts
  - backend/src/lib/url-guard.ts
---

**What a signal is**: a `Signal` row (`backend/prisma/schema.prisma`) with a `type`, the `taskId` and `projectId`, one recipient (`recipientAgentId` for an agent token, `recipientUserId` for a human), an inline `context` JSON and `acknowledgedAt`, which stays null until the recipient acknowledges it. The `type` column is a plain `String`; the set of values is the `SignalType` union in `backend/src/services/signal.ts`. On the legacy (non-grounding) paths `createSignal` is the only writer: it inserts the row, then voids `maybeDeliverSignalWebhook`, so a push failure can never fail the request that created the signal. The context carries the task title and status, the project slug and name, the branch and PR fields and the acting `actor`, plus `reviewComment`, `assigneeName` or `forceTransition` for the types that need them; `docs/signal-payload-design.md` is the human-facing payload description.

**Types and recipients**: each type has a fixed recipient rule (`backend/src/services/signal.ts:17-23#"self_merge_notice"`). The emitters are called with `void` from the routes, after the task write.

- `task_available`: `emitTaskAvailableSignal` (`backend/src/services/task-signal.ts`) on the routes that `docs/events.md` lists under Signal types. Recipients: every agent token of the project's team that is not revoked, not expired and carries `tasks:claim`. Humans never receive it.
- `review_needed`: `emitReviewSignal` (`backend/src/services/review-signal.ts`) when a task enters review. `findEligibleReviewers` selects the team's active agent tokens with `tasks:transition` and the team members whose team role is `REVIEWER` or `ADMIN`, minus the task's assignee. Per-project members (`ProjectMember`) are not looked up. The emitter also writes a `[system]` timeline comment that lists the recipients, or says that none were found.
- `changes_requested` and `task_approved`: to the task's work claimant, agent or human, with the review comment; nothing is sent when the task has no claimant.
- `task_force_transitioned`: `emitForceTransitionedSignal` (`backend/src/services/force-transition-signal.ts`) after an admin `force` transition, to the work claimant and the review claimant, agent or human, deduplicated, and never to the forcing admin.
- `self_merge_notice`: `emitSelfMergeNoticeIfApplicable` (`backend/src/services/self-merge-notice.ts`) after a merge to done, only when the project's governance mode resolves to `AWAITS_CONFIRMATION` (see `governance-merge.md`). Recipients: every team member of the project's team except a merging human. Agent tokens never receive it.

**Grounding-configured paths**: when the grounding runtime is configured (see `architecture.md`), the route plan in `backend/src/services/grounding-route-effects.ts` computes the same recipient sets for `review_needed`, `task_approved`, `changes_requested`, `self_merge_notice`, `task_available` and, on a forced direct transition, `task_force_transitioned` (the work and review claimants, without the forcing human) and writes the rows inside the task transaction (`applyGroundingRoutePlan`); task creation does the same for `task_available` in `backend/src/routes/grounding-creation.ts`. Webhook delivery runs after the commit, once per signal and best effort, so it cannot undo the transaction (`backend/src/services/grounding-completion.ts:240-245#"deliver(signal)"`).

**Pull inbox**: `GET /api/agent/signals` (`backend/src/routes/signals.ts`, behind the same `authMiddleware` as the task routes) returns the caller's own signals, oldest first: an agent token sees the rows addressed to its token id, a human the rows addressed to the user. The `status` query selects unread (the default), acknowledged or all; `limit` defaults to 50 and is capped at 200 (`backend/src/routes/signals.ts:21#"Math.min"`). `POST /api/agent/signals/:id/ack` sets `acknowledgedAt`; a signal addressed to someone else answers 404. `POST /tasks/pickup` returns the oldest pending signal and acknowledges it in the same step (see `claim-model.md`).

**Acknowledgement when a task finishes**: `acknowledgeSignalsForTask` (`backend/src/services/signal.ts:199#"export async function acknowledgeSignalsForTask"`) acknowledges every pending signal of one task. The task routes that land a task in done (`/transition` for any terminal state of the workflow), the legacy GitHub merge route (`backend/src/routes/github.ts`) and the legacy webhook handlers that move a task to a terminal state (`done` in the built-in workflow) (`backend/src/services/github-webhook.ts`) call it, and the review and transition routes call it before they emit the outcome signals, so a `task_approved` or `task_force_transitioned` sent against the finished task stays pending for its recipient (`backend/src/routes/tasks.ts:7983#"Ack BEFORE emitting"`). Pickup also skips a pending `review_needed` or `task_available` row whose task is done (`backend/src/routes/tasks.ts:57#"const STALE_WHEN_DONE"`).

**Webhook configuration**: a project's `notificationWebhookUrl` and optional `notificationWebhookSecret` are set through `PATCH /api/projects/:id`, which refuses agent tokens and requires the project admin role (see `permissions-model.md`). The URL is validated for shape and an http or https scheme only (`httpUrl`, `backend/src/lib/url-guard.ts`), nothing probes it, and an empty string or null clears either field (`backend/src/routes/projects.ts:106-112#"Never echoed in responses"`). The secret is never returned; project responses carry `hasNotificationWebhookSecret` instead (`redactProject`).

**Push delivery**: `deliverSignalWebhook` (`backend/src/services/notification-webhook.ts`) POSTs a JSON body with `signalId`, `type`, `taskId`, `projectId`, `projectSlug`, both recipient ids, `context` and an ISO `createdAt`. Headers: `X-AgentTasks-Event` (the signal type prefixed with `signal.`), `X-AgentTasks-Signal-Id`, and, only when the project has a secret, `X-AgentTasks-Signature`, an HMAC-SHA256 hex digest of the raw body prefixed with `sha256=`. Each attempt has a 5 s timeout; a non-2xx answer, a network error, a timeout or an egress-guard rejection leads to one retry after 2 s, so there are at most two attempts (`backend/src/services/notification-webhook.ts:268-272#"RETRY_DELAY_MS"`). The outcome is audited as `signal.webhook_delivered` or `signal.webhook_failed` with the attempt count and duration, and a final failure is also logged as a warning. There is no outbox: a signal whose delivery failed is not sent again later, and the pull inbox stays the authoritative record.

**Egress guard**: before every attempt `assertPublicWebhookUrl` rejects a scheme other than http or https, and a host that is, or resolves through any of its DNS records to, a private, loopback, link-local, carrier-grade NAT, benchmarking, multicast or reserved address, including IPv4 addresses embedded in IPv6 forms; redirects are not followed. A rejected target counts as a failed attempt and nothing is sent. The operator setting `WEBHOOK_ALLOWED_PRIVATE_HOSTS` (comma-separated exact host names or IP addresses, empty by default) exempts the listed hosts from the address check for self-hosted receivers. The receiver contract is in `docs/notification-webhooks.md`.

Related: `claim-model.md`, `governance-merge.md`, `permissions-model.md`.
