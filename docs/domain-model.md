# Domain model

Authoritative source: [`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma). This page is a curated overview of the entities, the relations between them, and the fields that drive governance.

## Identity and tenancy

| Model | Purpose |
|---|---|
| `User` | Human identity. Carries the GitHub linkage (`githubId`, `githubAccessToken`, `githubTokenHealthy`) and the per-user delegation consent flags (`allowAgentPrCreate`, `allowAgentPrMerge`, `allowAgentPrComment`) that control whether agents may act in this user's name on GitHub. |
| `UserIdentity` | Federated provider link (`provider`, `providerUserId`). Used for OIDC/SSO. |
| `Team` | Top-level tenant. Owns projects, agent tokens, members, and an optional `SsoConnection`. |
| `SsoConnection` | Per-team OIDC config. Encrypted `clientSecretEnc`, email-domain routing. |
| `TeamMember` (`MemberRole = ADMIN \| HUMAN_MEMBER \| REVIEWER`) | Membership of a `User` in a `Team`. |
| `AgentToken` | First-class actor for agents. Hashed token, `scopes[]`, expiry, revocation. Appears as creator / claimant / reviewer / commenter / artifact-author wherever a human `User` could appear. |

## Project layer

| Model | Purpose |
|---|---|
| `Project` | A project bound to a single GitHub repo (`githubRepo`). Owns tasks, workflows, boards. Carries the **governance fields** (see below). |
| `ProjectMember` (`PROJECT_VIEWER \| PROJECT_CONTRIBUTOR \| PROJECT_ADMIN`) | Per-project sharing on top of team membership. |
| `ProjectInvite` | Short-lived hashed share-link to add a `ProjectMember` outside the team. Consumption emits `project.invite_consumed` and may auto-flip `soloMode` off (`project.solo_mode_disabled_by_share`). |
| `Workflow` | A `definition JSON` (states, transitions, policies) applied per project. `isDefault: true` for the system default; custom workflows can override. |
| `Board` | Saved kanban view (column set, filter set) over a project's tasks. |

### Governance fields

These fields on `Project` shape every state-write path:

- `confidenceThreshold` (default `60`). Below this, `task_pickup` and `task_start` reject with `422 confidence_below_threshold`.
- `governanceMode` (`AUTONOMOUS \| AWAITS_CONFIRMATION \| REQUIRES_DISTINCT_REVIEWER`, nullable). Source of truth for new code. See [`state-machines.md`](state-machines.md) for what each tier gates.
- `soloMode` (`Boolean`, **deprecated**). Kept readable for one release. Server derives `governanceMode` from this when the new field is null. Writes go through `governanceMode` and sync-write the legacy flag via `legacyFlagsFromGovernanceMode`.
- `requireDistinctReviewer` (`Boolean`, **deprecated**). Same deprecation contract as `soloMode`.
- `requireGroundingForDebug` (`Boolean`). When on, `task_finish` against a debug-flavored task gates on a `grounding-ledger` entry tagged with the session UUID (ADR 0002).

> Read with care: never read the legacy `soloMode` / `requireDistinctReviewer` directly in new code. Use `resolveGovernanceMode` (`backend/src/lib/governance-mode.ts`).

## Task layer

| Model | Purpose |
|---|---|
| `Task` | The unit of work. `status: String` (free-form, default `"open"`), driven by the `Workflow` definition. Dual `creator` / `claimant` / `reviewer` fields for human + agent. Agent-populated `branchName`, `prUrl`, `prNumber`, `result`, `autoMergeSha`. `templateData` and `metadata` carry structured scaffolding (e.g. `metadata.debugFlavor`, set explicitly via the optional create-time `debugFlavor` flag, or derived heuristically at `task_pickup` when that flag is omitted). |
| `TaskDependency` | Many-to-many self-relation on `Task` modelling `blocks` / `blockedBy`. Cycle-checked. `task_pickup` skips a task whose `blockedBy` parents are not all `done`. |
| `TaskAttachment` | Human-uploaded URL pointer (no semantics). |
| `TaskArtifact` | Typed agent output (build logs, coverage, code) with inline `content` or external `url`. Authored by `User` or `AgentToken`. Lifecycle audit-logged as `task.artifact.created` / `.deleted`. |
| `Comment` | Human or agent comment on a task. |

`Task.status` is a free `String` because custom workflows can define their own states. The default workflow's four states (`open`, `in_progress`, `review`, `done`) are encoded in `backend/src/services/default-workflow.ts`, not in the DB.

## Signal layer

| Model | Purpose |
|---|---|
| `Signal` | Pull-based async event for one specific recipient. `type: String` (no DB enum), `taskId`, `projectId`, exactly-one of `recipientAgentId` / `recipientUserId`, `context: JSON`, `acknowledgedAt`. Validation is application-side via the `SignalType` union; see [`events.md`](events.md) for the catalog. |

Acking a signal sets `acknowledgedAt`. When a task lands in a terminal state, `acknowledgeSignalsForTask` bulk-acks every pending signal on that task (unconditional) so reviewers do not see stale entries. A separate `STALE_WHEN_DONE` constant suppresses three signal types (`review_needed`, `task_available`, `task_assigned`) from the `task_pickup` feed when the task is already done; the two mechanisms are orthogonal.

## Audit layer

| Model | Purpose |
|---|---|
| `AuditLog` | Immutable trail. `action: String` (drawn from the `AuditAction` union in `backend/src/services/audit.ts`), optional `projectId` / `taskId` / `actorId`, free-form `payload: JSON`. Audit writes are fire-and-forget and swallow errors; do not depend on audit being load-bearing for any flow. |
| `ToolInvocation` | Idempotency log for side-effecting MCP verbs (`task_submit_pr`, `task_merge`, `pull_requests_create`, `pull_requests_merge`). Unique on `(projectId, verb, idempotencyKey)`, with `payloadHash` to reject key reuse on a different payload. The row is inserted **after** the side-effect, so two truly concurrent retries can both execute once before one loses the race. |

## Relations at a glance

```
Team
 ├── TeamMember --> User
 ├── AgentToken
 ├── SsoConnection
 └── Project
      ├── ProjectMember --> User
      ├── ProjectInvite
      ├── Workflow (isDefault | custom)
      ├── Board
      └── Task
           ├── TaskDependency (blocks / blockedBy)
           ├── TaskAttachment
           ├── TaskArtifact
           ├── Comment
           ├── Signal (recipientUser | recipientAgent)
           └── AuditLog
```

For the same picture in mermaid, see [`../diagrams/domain-overview.mmd`](../diagrams/domain-overview.mmd).

## Further reading

- [`state-machines.md`](state-machines.md), default workflow transitions, transition-rule decorations, governance-tier gates.
- [`events.md`](events.md), full audit-event + signal-type catalog.
- [`workflow-preconditions.md`](workflow-preconditions.md), precondition rule reference (`branchPresent`, `prPresent`, `prMerged`, `ciGreen`).
- ADR 0010, governance-mode consolidation (legacy boolean flags to single enum).
