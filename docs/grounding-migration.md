# Grounding migration procedure

The grounding migration report is an inventory only. It separates unprovisioned, OFF, legacy-local, external-v1, and inconsistent cohort records, and reports recommended actions. A recommendation does not change a task, put it on hold, activate enforcement, or authorize a rollout.

Run the compiled inventory through the deployment entry point only with an explicitly supplied migration database URL:

```sh
GROUNDING_MIGRATION_DATABASE_URL='postgresql://…' node scripts/grounding-deployment-check.mjs --inventory-only
```

The entry point accepts an optional `--project <project-id-or-slug>` filter. It fails closed for every other argument, requires the compiled report, bounds output, and emits no activation action. Its output includes an explicit `activation.status: "blocked"`; a successful read-only report, zero counts, package version, or caller-provided value is never rollout approval.

Before an authorized migration, capture a backup and restore it into an isolated database. Run the inventory on the restored data and exercise the additive schema with both existing and upgraded consumers. Record the actual release versions, writer identities, backup/restore evidence, and results in the deployment record; do not place environment-specific measurements in this document.

Legacy phase data needs a separately validated migration rule. The inventory treats the pinned legacy wrapper's `complete` phase as compatible with claim evaluation; it still flags malformed and impossible phase data. Phase compatibility does not prove a successful evaluated outcome. The inventory cannot repair state and is not a safe hold. Do not use `OFF`, task metadata, malformed cohort rows, or a report recommendation as a maintenance state. A migration requires an audited, authorized conversion that preserves history, invalidates active attempts atomically, and has enforceable writer exclusion before it can claim a safe hold.

Activation remains blocked until the runtime composes the trusted receipt service, selects a cohort for new protected tasks, excludes older writing instances, and has separate operator evidence for host policy, state, and key isolation. The local separated-process qualification of the producer protocol is useful compatibility evidence only; it is not physical two-host or operating-system isolation proof.

## Audited administrative commands

`POST /api/tasks/:id/grounding-migration` is available only when a
`GroundingMigrationService` is explicitly injected as the fourth `createApp`
argument. The default server does not configure it. There is no MCP migration
tool. The authenticated actor must be a human with current team `ADMIN` or
project `PROJECT_ADMIN` membership; the service rechecks membership inside its
Serializable transaction, including exact retries.

Every strict JSON request includes `action`, a nonblank `reason` of at most
2,000 characters, an `expectedRevision`, and a `key` of 1–128 token characters
(letters, digits, `.`, `_`, `:`, `-`). State absence means revision zero and
unheld. Successful commands advance the revision and append immutable command
history and a mandatory audit containing the actor, exact request, reason,
and before/after state. Reusing the key with the same actor and exact request
returns its historical result, even after later commands; it does not restore
that historical state. Changed actors or requests and stale revisions conflict.

| Action | Source | Result and additional input |
| --- | --- | --- |
| `hold` | Nonterminal task, including unprovisioned or malformed cohort | Preserves cohort and binding; sets the independent durable hold |
| `pin_legacy` | Held unprovisioned or legacy task without external history | Creates/repairs protected legacy state with explicit `sessionId` and pinned-wrapper `phase`; remains held |
| `migrate_external` | Held unprovisioned, valid legacy, OFF, or compatible external task | Requires `subjectMode` (`TASK_SPEC` or `CODE_HEAD`); binds only current server audience, policy and trust; remains held |
| `resume` | Held valid protected legacy or compatible external task | Validates readiness and releases the hold; OFF cannot resume |

Fresh commands reject terminal/unknown task state, a stored merge SHA, unresolved
reservation/operation/finalization, or a conflicting GitHub repository or
PR-create fence. They invalidate active attempts and clear active nomination
while advancing the binding context revision. Task metadata, claims, status,
attempts, receipts, operations and finalizations are retained. Audit failure
rolls back the whole command. An external binding cannot be converted to legacy
or OFF, and receipts are never imported as local ledger evidence.

Legacy resume reads the backend-local ledger for the pinned session. It requires
a positive safe-integer entry count and phase `claim-evaluation` or `complete`.
A reference with valid syntax is insufficient; a missing, unavailable or
incompatible local ledger keeps the hold. Operational reliance therefore
requires a backend with access to that legacy ledger. External resume validates
current trust, audience and policy again, and completion needs a fresh attempt
and receipt after release.

## Full task freeze and rollback

A hold freezes all task-row UPDATE and DELETE operations, including no-op
updates and negative dispositions. It has no normal-writer bypass token.
The canonical database fence SQL installs and validates this guard and the
migration-overlay repository fence; Prisma schema synchronization alone does
not install them. Entering hold advances the task row version before setting
the overlay, so a stale Serializable writer cannot miss the hold.

Current route selection rejects held tasks before unprovisioned fallback or
cohort validation. Evidence issue/ingest and fresh completion reject holds
before override, force or remote effects. Group merges include held unenrolled
peers. Configured webhooks retain matching held-task facts as pending
observations, including events that would ordinarily change PR fields or
request changes. A completed exact operation retry can return its existing
result without new effects. Inventory reports `held` counts separately from
cohort classification and recommends an authorized readiness review.

Rollback of external enrollment means hold, deploy a compatible consumer, and
explicitly resume when ready. It never means dropping protection, deleting
history or silently falling back. This task-row freeze does not freeze parent
project/workflow configuration, every related table, or remote GitHub itself.
Exclude old writers and qualify the complete writer fleet before relying on it;
untracked remote writes and physical isolation remain separate deployment
prerequisites. These interfaces do not qualify a production rollout or enable project-level
external creation policy; the inventory remains read-only.
