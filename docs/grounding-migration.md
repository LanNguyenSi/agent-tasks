# Grounding migration procedure

The grounding migration report is an inventory only. It separates unprovisioned, OFF, legacy-local, external-v1, and inconsistent cohort records, and reports recommended actions. A recommendation does not change a task, put it on hold, activate enforcement, or authorize a rollout.

Run the compiled inventory through the deployment entry point only with an explicitly supplied migration database URL:

```sh
GROUNDING_MIGRATION_DATABASE_URL='postgresql://…' node scripts/grounding-deployment-check.mjs --inventory-only
```

The entry point accepts an optional `--project <project-id-or-slug>` filter. It fails closed for every other argument, requires the compiled report, bounds output, and emits no activation action. Its output includes an explicit `activation.status: "blocked"`; a successful read-only report, zero counts, package version, or caller-provided value is never rollout approval.

Before an authorized migration, capture a backup and restore it into an isolated database. Run the inventory on the restored data and exercise the additive schema with both existing and upgraded consumers. Record the actual release versions, writer identities, backup/restore evidence, and results in the deployment record; do not place environment-specific measurements in this document.

Legacy phase data needs a separately validated migration rule. The inventory treats the pinned legacy wrapper's `complete` phase as compatible with claim evaluation; it still flags malformed and impossible phase data. Phase compatibility does not prove a successful evaluated outcome. The inventory cannot repair state and is not a safe hold. Do not use `OFF`, task metadata, malformed cohort rows, or a report recommendation as a maintenance state. A migration requires an audited, authorized conversion that preserves history, invalidates active attempts atomically, and has enforceable writer exclusion before it can claim a safe hold.

Activation requires an explicitly reviewed runtime configuration, exclusion of older writing instances, and separate operator evidence for host policy, state, and key isolation. The local separated-process qualification of the producer protocol is useful compatibility evidence only; it is not physical two-host or operating-system isolation proof.

## Server configuration and startup

The backend accepts one `GROUNDING_RUNTIME_CONFIG` environment value. Docker
Compose forwards it with an empty default. Absence, the empty string, or the
strict object `{"enabled":false}` requests the unconfigured runtime. Whitespace,
malformed JSON, duplicate keys (including escaped names), and unknown fields
are errors. Startup never logs the submitted value or falls back after an error.

An enabled configuration has this shape; placeholders must be replaced by
reviewed deployment values before use:

```json
{
  "enabled": true,
  "audience": "consumer.example",
  "challengeSeconds": 900,
  "trust": [{
    "issuer": "assessment.example",
    "kid": "public-key-version",
    "publicKeyPem": "<Ed25519 public SPKI PEM with escaped newlines>",
    "profileDigest": "<supported policy SHA-256>",
    "projectIds": ["<lowercase project UUID>"],
    "audiences": ["consumer.example"],
    "revoked": false
  }],
  "creationPolicy": [{
    "projectId": "<lowercase project UUID>",
    "subjectMode": "TASK_SPEC"
  }]
}
```

`creationPolicy` is required and may be empty. Selection is explicit per project;
`CODE_HEAD` is the other supported subject mode. Selected projects must exist
and be covered by an unrevoked trust record for the configured audience and
supported policy. Empty trust with empty selection is valid but cannot accept
external evidence. Every record is checked, even unused and revoked records.
Only Ed25519 public SPKI keys are accepted. Never supply a signing private key,
producer credential, producer address, or ledger key to this consumer.

The input is bounded to 64 KiB, with at most 64 trust records, 256 creation
selections, 256 project scopes and 64 audience scopes per trust record. Project
selections, trust identities, and each scope list must have no duplicates.
Audience, issuer and key identifiers are 1–128 letters, digits, `.`, `_`, `:` or
`-`. Challenge lifetime defaults to 900 seconds and accepts integers from 1 to
86,400; receipt freshness remains separately bounded by the receipt protocol.

Before opening its listener or scheduling the idempotency sweep, the real
server awaits read-only grounding startup admission. Disabled startup requires
all grounding tables to exist. Any row in any grounding table requires enabled
configuration, including OFF and legacy cohorts, completed commands or
deliveries, and every fence-intent row whatever its state. The one exemption is
an *unowned* GitHub repository-fence row: the repository-fence SQL trigger
bumps such a row on any ordinary task write that carries a GitHub repo, whether
or not grounding is ever configured, so it alone is not grounding history. An
*owned* fence still counts as history, and every other grounding table is
checked exactly as before. Missing tables or failed queries abort startup.
Once real history exists, removing the configuration is not a rollback:
restore valid configuration and a compatible consumer. Do not delete history to
obtain an unconfigured startup. Installing without ever configuring grounding
needs no special handling.

Enabled startup validates the canonical schema-local SQL fence installation and
selected project existence, then derives the enforced scope from
`creationPolicy`: the selected project ids, plus the canonical GitHub
repository each of those projects owns. Startup then refuses when a project
outside that enforced scope shares a (case-normalized) GitHub repository with
an enforced one, so the boundary between enforced and legacy routing is never
ambiguous per request. It also refuses when an enforced project's repository
is not a canonical `owner/repo` identity and, while the enforced scope owns a
repository, when any project's repository is not canonical (an escaped name
could be an alias of an enforced repository). A project created or re-pointed
after startup is not covered by these checks. It then creates attempts, grouped merge/completion, PR
creation, and migration services using one frozen configuration, scope, and
the same Prisma database.

Configured routing does not apply globally. A fresh remote operation (task
merge, finish with `autoMerge`, GitHub PR merge) on a task with no existing
keyed durable history returns `409 grounding_enrollment_required` when the
task's project is in the enforced scope, or when any target the legacy handler
could act on is guarded. Those targets are every candidate repository (the
request's owner/repo, the task's deliverable repository, its project
repository, and the repository of the task's or the request's PR URL) and
every candidate PR number (the path number, the task's PR number, and the
number of the task's or the request's PR URL). The request is guarded when any
candidate repository belongs to an enforced project, or when any candidate
repository and PR number pair is shared with a protected, `EXTERNAL_V1` or
held peer. A candidate repository string that is not a canonical `owner/repo`
identity (a dot segment, a percent-encoded name, an owner containing `/`)
cannot be compared, so it makes the request guarded as well. When the request
is not guarded but another operation owns the repository fence of any
candidate repository, it returns `409 grounding_finalization_pending` before
any GitHub call, because the legacy handler could not record its effect.
Otherwise it reaches the same unchanged legacy handler, including when no
operation key is supplied. PR creation for an unprovisioned task outside the
enforced scope is routed the same way: with or without an operation key it
reaches the legacy creator, which reads the key from the `Idempotency-Key`
header or the body `idempotencyKey`. A key that already has durable grounding
create history, or a task with an unfinished grounding create, stays with the
grouped create service; a guarded create follows the grouped create contract.

To decide, the GitHub create and merge routes read only the task id, the body
owner/repo, any well-formed key for the durable-history lookup, and the path
PR number parsed as the legacy handler parses it. A request routed to the
legacy handler reaches it unmodified: the Grounding key format, strict body,
path and header/body key checks apply only to requests the Grounding services
handle. Outside the enforced scope the differences from the unconfigured
application are therefore the guarded and fenced refusals above and the agent
and scope admission check that runs before routing. Enabling the configuration
is also not free of side effects: an enabled runtime writes grounding history (webhook deliveries, for
example) even for projects outside the scope, and a later unconfigured restart
refuses that history. Enabling configuration is therefore one-way. Rollback
from a first enabled deploy means keeping an enabled configuration with an
empty trust list and an empty `creationPolicy`, not removing it. Existing
history is never enrolled implicitly. Local compatibility behavior and
existing authorization remain as described in the
[receipt contract](grounding-receipt-contract.md).

The scope, peer and fence checks above are point-in-time reads, not locks. They
accept a residual race: any change between that read and the legacy handler's
GitHub call that would have made the request guarded is not seen. That covers
every change that makes some task a protected, `EXTERNAL_V1` or held peer of
the targeted PR or repository, for example an administrator rebinding a
task's repository or PR, a migration hold placed on a task, or a task's
enrollment, and a grouped operation acquiring a candidate repository's fence
after the read. Closing it would mean serializing every legacy remote write
against those paths, which this design deliberately does not do; the race is
accepted, not eliminated.

The same selection enrolls new REST tasks, import rows, and signed GitHub
issue-created tasks atomically with their creation. Agent REST creation still
enters backlog. Selected webhook creation preserves `open`, title, description
and audit behavior, and requires `open` to exist in the effective workflow
without being a review or terminal state. Invalid workflow or failed enrollment
rolls back the whole delivery and its task, cohort, binding and audit writes.

Configuration is loaded once and frozen for the process lifetime. Trust rotation,
revocation, audience or selection changes require replacing the configuration
and coordinating restart of every writing instance. Revocation is not immediate
across an already-running fleet. Exclude old writers before relying on new trust
or routing, preserve the deployment configuration with the restore procedure,
and validate an isolated restored database with the intended configuration and
canonical SQL. A passing startup does not prove backup restoration, writer
exclusion, producer key isolation, or production rollout readiness.

## Audited administrative commands

`POST /api/tasks/:id/grounding-migration` is available only when a
`GroundingMigrationService` is explicitly injected as the fourth `createApp`
argument. The server supplies it when the validated grounding runtime is enabled. There is no MCP migration
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
prerequisites. These interfaces do not qualify a production rollout; the inventory remains read-only.
