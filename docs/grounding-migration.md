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
after startup is not covered by these checks. It then creates attempts,
grouped merge/completion, PR creation, and migration services and the
effect-boundary check described below, using one frozen configuration, scope,
and the same Prisma database.

Configured routing does not apply globally. The routers make only exact
decisions: agent and scope admission, task lookup, the caller's project
access, durable keyed history, enrollment mode, and whether the task's own
project is in the enforced scope. A fresh remote merge (task merge, finish
with `autoMerge`, GitHub PR merge) on an unprovisioned task with no keyed
durable history returns `409 grounding_enrollment_required` when the task's
project is in the enforced scope, and a PR create for such a task follows the
grouped create contract. Outside the scope the request reaches the legacy
handler with the untouched request, including without an operation key; an
unprovisioned task's PR create outside the scope reaches the legacy creator
with or without a key, and the legacy creator reads the key from the
`Idempotency-Key` header or the body `idempotencyKey`. A key that already has
durable grounding create history, or a task with an unfinished grounding
create, stays with the grouped create service.

The legacy handlers are functionally unchanged except for a target check at
the effect boundary. With configuration enabled, `performPrMerge` checks the
exact repository and PR number immediately before the GitHub merge call, which
covers the GitHub PR merge route, task merge, and the review, self-approve and
work finishes with `autoMerge`; the legacy PR creator checks the repository it
posts to immediately before the POST; and the legacy PR commenter checks the
repository and PR number it posts to immediately before the POST. The check
refuses with `409 grounding_enrollment_required` (body `{error, message}`)
when the repository string is not exactly a canonical `owner/repo` identity
(surrounding whitespace, a dot segment, a percent-encoded name, an owner
containing `/`), when it belongs to an enforced project, or when the PR is a
protected, `EXTERNAL_V1`, bound or held task's, including such a task whose own
repository string is not canonical and that shares the PR number. It refuses a
merge or create the same way when the requesting task is itself protected,
`EXTERNAL_V1`, bound or held, whatever PR number it sends. It refuses a merge
or create with `409 grounding_finalization_pending` when another operation
owns the fence of the target repository or of any repository the legacy task
write checks for the requesting task (its effective repository, its stored PR
URL repository and the repositories its own active PR-create intents fence),
because that task write would then fail after the GitHub effect; comments
write no task and take no fence. A create sends no PR number, so the peer
check does not apply to it. A legacy gate that refuses first answers as in the
unconfigured application.

A comment is refused on an enforced repository and on a protected,
`EXTERNAL_V1`, bound or held task's PR whoever sends it, including a task
commenting on the PR it stores: an agent can set a task's PR number and
repository, so they prove no authorship. As defense in depth, an enforced
repository must still not run comment-triggered merge or deploy automation.
The check governs only the GitHub writes agent-tasks sends; direct GitHub
access outside agent-tasks (tokens, the GitHub UI, other apps) is not governed
by it.

With configuration enabled the three legacy writes do not follow a GitHub
redirect. GitHub redirects a write to a renamed or transferred repository to
its new location, which the check never saw, so the configured application
sends each write with `redirect: "manual"` and answers a redirect with
`409 github_redirect_refused` (body `{error, message}`) without re-sending the
write to the redirect target. Update the project or
request to the repository's current name. The unconfigured application keeps
the previous behavior and follows the redirect.

Every Grounding router checks the caller's access before it reads or locks any
Grounding state, and answers a caller without access the same way whatever the
task's or project's Grounding state: the GitHub create and merge routes with
the legacy handler's own `404` or `403`, the completion, direct, attempt and
migration routes with one `403 {"error":"forbidden"}`, and the creation router
with the legacy creator's own validation and `403`, so whether a project is
selected by `creationPolicy` is not observable without access. A request handed
to a legacy handler reaches it unmodified: the Grounding key format, strict
body, path and header/body key checks apply only to requests the Grounding
services handle. Outside the enforced scope the principal differences from the
unconfigured application are therefore:

- the effect-boundary refusals (`409 grounding_enrollment_required`,
  `409 grounding_finalization_pending`) above, including a refused comment on a
  peer's or an enforced repository's PR;
- renamed or transferred repository writes are refused: a legacy write that
  GitHub redirects is answered with `409 github_redirect_refused` instead of
  being followed;
- the router's `409 grounding_enrollment_required` for a task whose project is
  in the enforced scope;
- the agent and scope admission check that runs before routing;
- a transient `503 grounding_verification_unavailable` when the routing read,
  which runs in a Serializable transaction, cannot be serialized; a retry
  resolves it;
- on the GitHub merge route, a `503` from the Grounding path carries a message
  asking the caller to retry with the same key and unchanged request.

Enabling the configuration is also not free of side effects: an enabled
runtime writes grounding history (webhook deliveries, for example) even for
projects outside the scope, and a later unconfigured restart refuses that
history. Enabling configuration is therefore one-way. Rollback from a first
enabled deploy means keeping an enabled configuration with an empty trust list
and an empty `creationPolicy`, not removing it; that configuration is not
equivalent to the unconfigured application. Existing history is never enrolled
implicitly. Local compatibility behavior and existing authorization remain as
described in the [receipt contract](grounding-receipt-contract.md).

The effect-boundary check is a point-in-time read, not a lock, and it runs one
database round trip before the GitHub call. Two residual races are accepted
within that window; they are narrowed, not closed, and closing them would mean
serializing every legacy remote write, which this design deliberately does not
do:

- A change after the read that makes some task a protected, `EXTERNAL_V1` or
  held peer of the targeted PR, for example an administrator rebinding a
  task's repository or PR, a migration hold placed on a task, or a task's
  enrollment, is not seen.
- A grouped operation that acquires one of the checked fences (the target
  repository's, or one of the requesting task's own repositories') after the
  read is not seen either. The legacy handler then performs its GitHub effect
  and its own task write fails on the fence: a merge can land on GitHub while
  the task stays in review, and a PR create can leave a PR that is not linked
  to its task.

A change to the requesting task between routing and the legacy handler's own
task read, such as a concurrent update of its PR number, is not a race: the
check reads the target the handler actually sends.

Before enabling configuration, confirm with read-only SQL, run in a read-only
transaction against the database the runtime will use, that no project
repository or task deliverable repository fails `grounding_github_repo()` or
carries surrounding whitespace (the whitespace the effect-boundary check
rejects, which `grounding_github_trim()` removes, including no-break spaces
and a byte order mark), and that no task PR URL in the GitHub pull-request
shape fails `grounding_github_pr_repo()`. Such a string cannot be
compared with the enforced scope or with peers, so every remote operation
that sends it is refused with `409 grounding_enrollment_required` even for a
project outside the scope, and every operation that shares a PR number with a
protected, `EXTERNAL_V1`, bound or held task that stores it is refused as
well. Each query should return no rows:

```sql
-- Project repositories
SELECT id FROM projects
WHERE "githubRepo" IS NOT NULL
  AND ("githubRepo" = '' OR "githubRepo" <> grounding_github_trim("githubRepo") OR grounding_github_repo("githubRepo") IS NULL);
-- Task deliverable repositories
SELECT id FROM tasks
WHERE "deliverableRepo" IS NOT NULL
  AND ("deliverableRepo" <> grounding_github_trim("deliverableRepo") OR grounding_github_repo("deliverableRepo") IS NULL);
-- Task PR URLs in the GitHub pull-request shape whose repository the check cannot name
SELECT id FROM tasks
WHERE "prUrl" ~* 'github[.]com/[^/]+/[^/]+/pull/'
  AND grounding_github_pr_repo("prUrl") IS NULL;
```

Correct any row these return before enabling, or accept that its operations
are refused until it is corrected. A clean result describes the stored values
at the time of the check, not the behavior of later writes.

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

## Runtime database role

The fence and hold guarantees are enforced by triggers. A superuser, a role
granted `SET` on `session_replication_role`, or the table owner (or a member of
it) can switch them off (`session_replication_role = replica`,
`ALTER TABLE ... DISABLE TRIGGER`), so the backend should connect as a role that
is none of these. In `docker-compose.prod.yml`, set both `POSTGRES_APP_USER`
and `POSTGRES_APP_PASSWORD` (or neither) to a role created along these lines,
run by the owner role:

```sql
CREATE ROLE agent_tasks_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD '...';
GRANT CONNECT ON DATABASE agent_tasks TO agent_tasks_app;
GRANT USAGE ON SCHEMA public TO agent_tasks_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent_tasks_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agent_tasks_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO agent_tasks_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agent_tasks IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_tasks_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agent_tasks IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO agent_tasks_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agent_tasks IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO agent_tasks_app;
```

`migrate` keeps the owner role, since `prisma db push` and the fence SQL need
it; the default privileges make tables and functions it creates later usable
by the runtime role. Set both variables or neither: unset, both fall back to
the owner role, while setting only one leaves the backend with a user and
password that do not match, and it cannot connect. The password is placed into
the connection URL unencoded, so use a URL-safe value such as
`openssl rand -hex 32`.

This role cannot disable the triggers. It still writes the fence, fence-intent
and hold tables and sets the settings the triggers read, as the backend must, so
SQL executed as the backend can still release a hold or a fence. The split
removes trigger bypass from the runtime connection; it does not protect against
arbitrary SQL run as the backend. Anyone holding the owner role's password can
still bypass the triggers, so that credential stays with operators.

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
