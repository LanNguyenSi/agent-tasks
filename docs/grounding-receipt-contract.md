# Grounding receipt v1 consumer contract

`verifyGroundingReceipt` in `backend/src/services/grounding-receipt.ts` verifies signed `grounding-receipt/v1` bytes offline. Callers inject the server-recorded attempt context, the issuer/key trust store, and the server clock. Its only successful result is passing documentary `agent_asserted` evidence: receipt ID, assessment dossier digest, and evaluated/issued/expiry times. This does not authorize a task transition. There is no public signature-only success API.

Expected context must include audience, project/task/attempt IDs, a canonical unpadded base64url 32-byte nonce, positive context revision, exact workflow target (including nullable workflow ID), subject digest, session ID/revision, and the stored challenge creation/expiry times. Configuration is validated at runtime without coercion. Clock and challenge times are nonnegative safe integer epoch seconds; revisions are positive safe integers. Challenge expiry must be after creation and at most 24 hours later. Creation may be at most 60 seconds ahead of the injected clock.

Every trust record must contain token-shaped issuer/kid values, an Ed25519 public SPKI PEM, a profile digest, and nonempty explicit project-ID and audience lists. All records and keys are validated before selecting a key, including unused and revoked entries. Duplicate `(issuer, kid)` pairs make configuration unavailable. An empty store is valid but trusts no receipt. Rotation adds a separately scoped entry; revocation sets that exact entry's `revoked` boolean.

Verification follows this order: strict receipt syntax/schema/profile, complete local configuration and key validation, signature authentication, trust scope, exact context binding, freshness, then assessment outcome. Errors have a stable `GroundingReceiptVerificationError.code`:

| Code | Meaning |
| --- | --- |
| `grounding_receipt_invalid` | Malformed bytes, noncanonical payload, or invalid schema/value relationships |
| `grounding_receipt_unsupported` | Unsupported format, algorithm, schema version, subject kind, or policy profile |
| `grounding_verification_unavailable` | Missing or malformed local context, clock, trust configuration, or public key |
| `grounding_receipt_untrusted` | Unknown/revoked receipt key, bad signature, or project/audience/profile outside its trust scope |
| `grounding_receipt_mismatch` | Authenticated receipt differs from stored expected context |
| `grounding_receipt_stale` | Receipt or stored challenge expired, timestamp outside allowed skew, or receipt extends the stored challenge |
| `grounding_required` | Authenticated, bound and fresh assessment failed; `detail` is `assessment_failed` |

Evaluation and issuance may be at most 60 seconds before challenge creation or after the injected clock. Neither receipt nor challenge expiry receives a skew allowance: `now >= expiry` is stale. Receipt expiry may equal the stored challenge expiry but cannot exceed it. The producer profile separately requires evaluation ≤ issuance < expiry and at most 900 seconds from evaluation to receipt expiry. Signature, binding and freshness errors take precedence over a signed fail outcome.

The corpus is pinned to producer revision `0884c4054c446648aaaf44e2fe9eef5dff5648cf` and manifest SHA-256 `b8dd4a913b59cfc1195aba22518aef59736eefb3fa187cf24557f7c84ce68906`. Independent literal constants in `scripts/grounding-receipt-contract.mjs` anchor both values. Mutable `PIN.json` records those values and must match the constants; it is not the trust anchor. The offline check verifies exact manifest bytes, every specimen's length/digest, and the complete file inventory:

```sh
node scripts/grounding-receipt-contract.mjs check
```

Sync explicitly reads a local producer repository's pinned Git objects, independent of its working tree:

```sh
node scripts/grounding-receipt-contract.mjs sync --producer /path/to/agent-grounding --revision 0884c4054c446648aaaf44e2fe9eef5dff5648cf
```

Both commands accept `--target /path/to/fixture-dir`. Sync prepares and validates a unique temporary corpus before replacement. An existing target must be an empty directory or an intact previous corpus; unrelated directories and symlinks are rejected. To recover a damaged corpus, sync to a fresh destination and review the replacement. Changing the pinned version requires reviewing the literal constants and vendored bytes together. The executable has no pin override; helpers accept an injected pin for portable temporary-Git-repository tests.

The verifier reads no environment variables or key files, imports no wrapper/ledger/harness key, fetches no keys, and makes no network requests. The consumer tests use the vendored corpus and temporary local Git repositories; they require no producer checkout. Issuer isolation and rollout qualification remain separate work.

## Protected attempts and receipt ingest

`GroundingAttemptsService` adds dormant consumer storage and two authenticated routes. The application requires explicit server-owned service injection; unconfigured attempt routes return `503 grounding_verification_unavailable`. There is no HTTP enrollment endpoint. The server-only `provision({taskId, projectId, subjectMode})` method requires an existing matching task, an explicit audience, a supported pinned policy and a usable independently configured trust store. Repeating identical provisioning is idempotent; conflicting provisioning fails. It never reads task metadata, changes the legacy `requireGroundingForDebug` default, or creates protection from `debugFlavor`.

`subjectMode` is a protected configuration choice: `CODE_HEAD` requires a registered PR and a fresh authorized GitHub head; `TASK_SPEC` asserts only the task specification, including when explicitly chosen for a task in a code repository. A caller cannot select or downgrade this mode through either route.

| Route | Strict JSON request | Successful response |
| --- | --- | --- |
| `POST /api/tasks/:id/grounding-attempts` | `{"intent":"finish"}`; intent is `finish`, `approve`, or `merge` | Challenge with `audience`, `projectId`, `taskId`, `attemptId`, `nonce`, `contextRevision`, `target`, `subject`, `policy`, `createdAt`, `expiresAt` |
| `POST /api/tasks/:id/grounding-attempts/:attemptId/receipt` | `{"session":{"id":"producer-session","revision":1},"receipt":"<original receipt JSON bytes as a JSON string>"}` | `receiptId`, passing `agent_asserted` evidence and `replayed` |

Finish and approve attempts, and the generic service APIs, retain their existing
project-write, `tasks:transition`, claim, review-lock, distinct-reviewer and
workflow-role checks. The server derives their effective workflow row
(task-specific, then the sole project default, then built-in with null ID) and
target from the established finish/approval helpers. The derived edge must exist
and be unambiguous; malformed definitions, multiple defaults, absent edges and
divergence from those semantics fail closed.

The REST task-merge route has a separate server-owned authorization path. Its
validated `merge` intent can issue and ingest an attempt for a fresh task in a
review state with a single terminal workflow edge. It requires project write
access and `github:pr_merge` for an agent, and preserves required workflow
roles plus the existing self-merge and distinct-reviewer gates. It does not add
a universal work or review claim requirement when those gates permit a
non-claimant merger. The receipt route recovers this policy from the persisted
attempt's intent and actor under the authoritative task lock; callers cannot
supply a policy switch or substitute an actor or intent. These routes authorize
an attempt only: they do not evaluate completion prerequisites such as CI,
transition task status, release claims, merge a PR or reserve finalization.

Challenge bodies are limited to 1,024 actual streamed bytes; upload bodies to 200,000 bytes, allowing JSON string escaping overhead around the C01 limit of 32,768 receipt bytes. Invalid UTF-8, malformed JSON, unknown request fields and invalid nomination shapes fail with `400 grounding_receipt_invalid`. Receipt JSON is passed to the unchanged strict C01 parser as original UTF-8 bytes. The session nomination has no independent authority: it is staged and read inside the locked transaction, then C01 authenticates the signed matching tuple against independent server context and trust. Failure rolls the entire nomination back.

## Direct task-route authority

An authoritatively provisioned task uses the direct adapter before the historical task router for `POST /api/tasks/:id/transition`, `POST /api/tasks/:id/review`, and `PATCH /api/tasks/:id`. A positive direct operation first issues an attempt through strict JSON:

```json
{"version":1,"endpoint":"transition|patch|review","target":"<workflow-state>"}
```

The server validates the selector against the currently locked task, workflow, actor, role and review gates, then persists that descriptor on the attempt. Receipt ingest reauthorizes the stored descriptor; it never accepts a caller-selected semantic action or a descriptor from another endpoint. A direct attempt therefore cannot be used by the v2 attempt path, and a v2 attempt cannot complete a direct operation. Direct authorization deliberately does not add a general claim requirement where the installed direct endpoint policy permits the caller.

Positive transition, review approval and status-patch operations require an `Idempotency-Key`. The completion service chooses the workflow-semantic decision and atomically commits the required receipt consumption, task change, operation history, audit and route effects. A direct `force` is limited to a human project administrator on `transition` and needs a nonblank `forceReason`; it remains subject to the ordinary authorization and state checks. Receipt-free override and non-success decisions never create a producer receipt. Request-changes, abandon, backlog discard and similar dispositions are not success targets.

Non-status direct edits use the same locked mutation path. Changes to signed task context invalidate prior attempts atomically; no-op and cosmetic-only edits leave attempts intact. `respec` and `submit-pr` join that path for an enrolled task. The configured GitHub adapters use the grouped merge, durable PR-create and webhook observation services described below. Public MCP transport remains separate work.

## Exact task-context/v1 projection

The subject digest is lowercase SHA-256 over UTF-8 bytes of the following JSON projection. All listed fields are present; database null stays JSON null. Arbitrary JSON object keys are recursively sorted by ascending UTF-16 code-unit order. Arrays retain order. Scalars use ECMAScript `JSON.stringify` encoding (including `-0` as `0`); Unicode is neither normalized nor trimmed, line endings remain exact, and lone surrogates or non-finite numbers fail closed. There is no whitespace or trailing newline. Object ordering is implemented directly so integer-like keys also follow this lexical order.

| Field | Server source |
| --- | --- |
| `version` | Literal `task-context/v1` |
| `audience`, `projectId`, `taskId` | Protected binding audience and current task identity |
| `title`, `description`, `templateData` | Exact persisted task values |
| `protection` | `{protected, subjectMode}` from the protected binding |
| `policy` | `{id, revision, sha256}` from the protected binding, checked against the supported profile |
| `project` | `{teamId, githubRepo, taskTemplate, governanceMode}`; governance mode uses the existing legacy-compatible resolver |
| `workflow` | `{id, definition}` with effective row ID and the entire exact effective definition; null ID only for the built-in definition |
| `target` | `{workflowId, from, to, action}`; action is the validated intent token |
| `claims` | `{workUserId, workAgentId, reviewUserId, reviewAgentId}` from the task |
| `deliverable` | `{repo, prNumber, prUrl, branchName, headSha}`; repo is `task.deliverableRepo ?? project.githubRepo`, head is null only for `TASK_SPEC` |

Metadata, debug suggestions, comments, labels, priority, result text and display/audit timestamps do not enter this projection. Changing any projected value requires a new context. A first challenge uses revision 1; later issuance increments the protected revision when its projection bytes differ from the last issued projection. Issuance without a projection change retains the revision but always creates a fresh attempt and nonce. Upload rederives the current bytes and rejects divergence, including on an exact retry. Participating writers invalidate context atomically through the mutation protocol below, including configured PR-create and webhook binding updates. Local reprojection also detects current drift from other writers, but cannot detect a change that was reverted between observations. The repository fence separately excludes conflicting writes while a GitHub operation is active.

`CODE_HEAD` requires a positive registered PR number and the exact canonical
GitHub PR URL for the registered effective repository. Finish/approve and
generic attempt reads use the existing `allowAgentPrCreate` delegation consent.
The REST standalone task-merge route uses `allowAgentPrMerge` for its head and
CI reads, matching its merge authority; create consent is not a substitute.
Each read uses the fixed GitHub API destination with caching disabled, redirects
rejected, a five-second abort deadline, and a 256-KiB response ceiling. The
returned PR number, repository identity, URL and 40-character lowercase
hexadecimal head must match. A missing delegate, inaccessible/mismatched PR,
failed or timed-out provider has no fallback. The head is a sampled remote
snapshot, not a transaction with GitHub.

## Atomicity and persisted identity

Binding, Attempt, Receipt and Finalization are separate relational tables. Same-task composite foreign keys prevent an active pointer, receipt or finalization from referencing another task's attempt. Nonce, receipt ID, one receipt per attempt and one finalization per attempt/receipt are unique in PostgreSQL. `Binding.activeAttemptId` is the authoritative single active attempt pointer. The service has no receipt update/delete operation: it preserves original wire bytes, their digest, the accepted session tuple and documentary evidence.

Issuance and ingest serialize on the project, task, binding and cohort rows in a serializable transaction. Project-access, workflow-role and GitHub-delegation reads use that same transaction client, including with a one-connection pool. Existing callers of these helpers retain their default singleton client. Issuance supersedes prior active attempts and installs a new pointer with compare-and-set in the same commit. Ingest requires the active pointer, current context, authorized actor, fresh clock and usable current trust; it stages nomination, invokes C01 and creates the receipt atomically. Concurrent identical uploads yield one creation and one replay; differing bytes or session tuples conflict. Exact retries after reconnect return the persisted receipt only after full revalidation; expiry, supersession or revocation cannot be bypassed by a retry shortcut. Receipt storage and uniqueness failures roll back nomination and fail closed.

The transaction has a 20-second lifetime and 10-second acquisition bound, with at most three serializable attempts. The authorized head read occurs inside this bound: a slow provider can hold that task's lock until its deadline. Provider failure writes no protected state. This trades local ordering for bounded lock occupancy and promises no cross-system atomicity. Shared completion/finalization uses the same transaction protocol described below. Issuer isolation and rollout qualification remain separate prerequisites.

## Shared completion and finalization services

These are server service APIs. `GroundingAttemptsService.provision` atomically creates/checks an
`EXTERNAL_V1` cohort and protected binding. `provisionGroundingCohort` explicitly
provisions `LEGACY_LOCAL` or `OFF`, with a bounded server provenance token.
A missing or inconsistent cohort blocks the new service; neither task metadata,
project flags nor external verification failure selects a fallback mode.
External cohorts remain protected. OFF requires `protected: false`.
Legacy enrollment pins a session ID and phase snapshot from a trusted server;
protected legacy completion uses that session's actual ledger entry count and
the existing at-or-past-claim-evaluation phase allowlist. Updates to those
references must use the context mutation protocol. Generic metadata is not read.

## Provisioned completion transport

`createApp` mounts a per-app grounding completion router before the historical
task router. Authoritative cohort selection distinguishes an explicitly
provisioned task from the historical `UNPROVISIONED` case. An invalid cohort,
orphan binding, database failure or missing required configured service fails
closed. The absence of enrollment does not select OFF or LEGACY_LOCAL.

Configured fresh remote operations—task merge, GitHub merge and finish with
`autoMerge`—require explicit server enrollment. Without it they return
`409 grounding_enrollment_required` before a remote effect. An informational
read showing no protected peers cannot authorize a legacy fallback: membership
could change after that read. Existing durable operations retain their
operation-bound recovery path. Unprovisioned local completion and the original
unconfigured application retain their defined compatibility behavior.

Server-only enrollment must exclude active legacy requests and workers before
activation. Explicit OFF or LEGACY_LOCAL enrollment provides compatibility
without requiring an external receipt for every task. Configuration and schema
installation do not themselves enroll production tasks or qualify a rollout.

`createApp(corsOrigins, grounding?, completion?)` selects configured guards when
either grounding dependency is supplied. `completion` carries `db`, optional
`service`, optional `githubCreate`, and optional `creationPolicy`. Remote merge
requires `service` to be a `GroundingGithubMergeService`; the base finalization
service alone is insufficient. PR creation requires an explicitly supplied
`GroundingGithubCreateService` in `githubCreate`. Missing capability returns
`503 grounding_verification_unavailable` and cannot fall through to a legacy
GitHub writer. Configured webhooks use `GroundingGithubWebhookService` at
`POST /api/webhooks/github`. The production server supplies no grounding
dependencies by default.

| Configured GitHub endpoint | Request identity and response |
| --- | --- |
| `POST /api/github/pull-requests/:prNumber/merge` | Agent `tasks:transition` and `github:pr_merge`; body `taskId`, `owner`, `repo`, optional `merge_method` (default `squash`). URL PR number must be a full positive integer and is part of the stored fingerprint. Success preserves `{merged, sha, message, task}`. |
| `POST /api/github/pull-requests` | Agent `tasks:update` and `github:pr_create`; body `taskId`, `owner`, `repo`, `head`, `title`, optional `base` (default `main`) and `body` (default empty). Success remains `201 {pullRequest, task}`. |

Both GitHub endpoints require an `Idempotency-Key` header or body
`idempotencyKey`; supplying both with different normalized values returns
`409 grounding_operation_conflict`. Merge keys are 1–128 token characters;
create keys are trimmed, nonempty and at most 255 characters. Repository/PR
input never silently rewrites a merge seed's authoritative binding. Pending
remote results return 202; retry the original endpoint, actor, key and body.
PR-create replay additionally requires a fresh read as described below.

Provisioned requests require an `Idempotency-Key` and a JSON object body. The
key identifies one logical operation for its actor. The finish body defaults
`autoMerge` to `false` and `mergeMethod` to `squash`; omitted defaults and
their explicit equivalents have the same canonical transport identity. Merge
accepts its `mergeMethod` with the same default, and abandon accepts an empty
object. History is checked with the canonical transport before mutable
claim/status dispatch: an identical authorized retry returns its durable result,
while a changed transport or actor conflicts. A new logical operation needs a
new key.

The completion router preserves semantic workflow actions: normal work uses
`finish`, review and permitted self-approval use `approve`, and task merge uses
`merge`. Inline PR input must equal the task's authoritative pre-bound PR before
assessment. A first merge request from a terminal task is denied; only an
existing durable operation may recover an interrupted dispatch. A bare stored
merge SHA is not authority to create that operation.

External pickup and start guidance uses that same semantic attempt intent:
`finish` for work, `approve` for review, and `merge` for a merge operation. The
guidance contains only REST references and producer session fields; it never
contains a backend wrapper-session reference.

`GroundingCompletionService.complete(taskId, actor, key, request)` accepts
`action: finish | approve`. The service selects the semantic workflow edge,
checks project write authority, agent transition scope, claims, workflow roles,
review governance and transition rules, then owns the task/claim effect.
A review handoff retains the work claimant; terminal completion clears both
claims. External completion reprojects current context, invokes C01 with current
trust and time, and atomically persists receipt consumption, task changes, an
immutable operation result and mandatory audit. Expiry during awaited local
writes aborts the whole transaction. A missing active receipt returns
`grounding_required`; expired or superseded evidence remains stale.

For provisioned lifecycle routes, the selected operation also stores a typed
route-effect plan and the task projection used for its response. Task, receipt,
operation, route audit, signal rows, comments and signal acknowledgement commit
together. Historical replay returns that stored result and does not recreate
those durable effects. Outbound signal webhooks and the optional calibration
observer run after commit on the newly committed invocation only; their
best-effort delivery is not crash-proof exactly-once behavior.

Requests have a bounded `key` (1–128 token characters), optional bounded result,
reason and `overrideReason`, and a merge method (`squash` by default). Unknown
request fields fail. The task/key pair is unique; actor type/ID, normalized
caller request fingerprint and the initially selected server decision are
immutable. Identical completed retries from the same actor with current project
write access return the original result before checking the released claim,
new workflow state, receipt expiry or current trust. A different request with
that key conflicts. No second transition, receipt consumption or audit occurs.

A nonblank `overrideReason` is a separate grounding-only decision requiring a
human project admin. It still requires the ordinary state, claim, review,
transition-rule and merge-consent checks. Receipt-free legacy, OFF, override and
non-success decisions never manufacture producer receipts. Accepted overrides
carry their reason in the operation and mandatory audit.

`dispose` accepts only `request_changes`, `abandon`, `release`,
`creator_abandon` or `reopen`. Request-changes requires the review holder, clears
the review claim and retains the author on the semantic return-to-work edge.
Abandon requires a current work/review claim and resets work to the initial
state; a work author cannot abandon while awaiting review. Release requires the
work holder and refuses to orphan a reviewer. Creator-abandon requires an agent
creator with `tasks:update` on open/backlog and fully unclaimed work, and writes
`abandoned`. Reopen requires a human project admin and an unclaimed abandoned
task, and selects only the effective initial state. Other claim dispositions
require `tasks:claim`; request-changes uses `tasks:transition`. These accepted
non-success decisions are audited, supersede active attempts and increment the
context revision. They cannot be used to choose a success target.

## Grouped GitHub reservation, dispatch and recovery

`GroundingGithubMergeService` extends `GroundingFinalizationService` with the
same `reserveMerge`, `dispatchMerge`, `recoverMerge` and `cancelMerge` APIs. A
configured remote operation uses this grouped service. The original
finalization service remains the source of shared completion primitives and
recovery for previously dispatched task operations; a pre-group RESERVED
operation cannot bypass participant checks by using the old dispatch path.

Reservation acquires the canonical repository fence before discovering all
protected tasks linked to the same PR, across projects and effective
repositories (`task.deliverableRepo ?? project.githubRepo`). Repository case
is normalized for coordination and verified remote identity, while signed
context and receipt bytes remain exact. Recognizable but inconsistent PR
bindings fail closed. Foreign deliverables remain subject to the existing
merge prohibition. A missing cohort on the seed is not fabricated from peers.

Every protected peer receives a standalone task-merge decision under the
originating actor: project write access, agent `github:pr_merge`, current
`allowAgentPrMerge` delegation, a review state with one terminal workflow edge,
required roles and review governance, plus its authoritative cohort's evidence.
No general claim requirement is added where the standalone merge policy does
not require one. The seed preserves its requested route semantics. All members
reserve their exact repository, PR, source head, method and local context in
one transaction. Receipt-backed reservations retain their same-task receipt
foreign keys; cohort reservation pointers exclude competing completion,
challenge issuance, receipt uploads and participating mutations.

Required CI uses the existing check-run classification and cache policy. Its
reported SHA must equal the fresh authorized head sample, receipt reprojection
and final dispatch head for every participant. A cached earlier head blocks
until normal cache refresh. OFF, legacy or grounding-only overrides do not
skip CI, merge consent or ordinary transition requirements. `prMerged` is
discharged only by exact merged proof.

Dispatch rechecks all participants' current authority, gates, context, head,
trust and receipt freshness before durable RESERVED-to-DISPATCHED
compare-and-set claims. Expiry during awaited dispatch writes aborts the local
transaction. Only the winner may issue one remote write outside that
transaction. The GitHub adapter sends `PUT /repos/{repo}/pulls/{number}/merge`
with the expected source `sha`, a fixed API host, redirects disabled, a
five-second deadline and a 256-KiB response bound. The merge commit is distinct
from the source head. These checks do not provide a transaction with GitHub or
atomic trust-store revocation across instances.

The group stores the original actor, key, canonical request and seed route
response plan. A changed actor or body under that key conflicts. Lookup occurs
before mutable status/claim admission. A fresh standalone merge is review-only;
a terminal task can replay or recover an existing operation, but cannot create
one from a bare `autoMergeSha`.

A timeout or uncertain dispatch remains DISPATCHED, including a crash after the
dispatch claim but before the network send. Retrying the original operation
performs reads only. Recovery rechecks current project authority, merge scope
and eligible delegation, and requires the exact repository, PR number, merged
state and original source `head.sha`, plus a valid separate merge commit.
An open PR, wrong head, missing proof or read failure neither unlocks the
reservation nor permits another merge.

Matching recovery checks each original local snapshot and receipt projection,
then atomically applies the seed's stored task/claim/route effects, consumes
member evidence, records mandatory audits and releases the group and all
reservations. Guard peers retain their status, claims and signals; their
consumed external receipt requires a fresh attempt for later completion. The
stored dispatched decision does not require renewed receipt TTL, trust or CI.
Local context drift stays unresolved. A database failure rolls back all local
effects and leaves the operation retryable. Completed replay returns the stored
response without repeating durable effects.

`cancelMerge(taskId, actor, key, reason)` applies only to a wholly RESERVED,
provably undispatched group. The originating actor needs current authority and
a bounded nonblank reason. Cancellation atomically invalidates attempts,
records the decision and releases reservations and the fence. A repeated
cancellation returns its stored result; a changed reason conflicts. Dispatch
and cancellation have one serialized winner. DISPATCHED groups cannot be
cancelled even when the PR appears open, and TTL expiry never unlocks them.

### Repository exclusion

`GroundingGithubRepositoryFence` stores a canonical, case-insensitive GitHub
repository identity and a version written even when inactive. Durable MERGE
and PR_CREATE intents own exclusion across transactions. This is coordination
state, not actor authorization. Acquisition precedes participant discovery;
release follows the owning operation's safe local completion or undispatched
cancellation. Existing RESERVED or DISPATCHED task operations prevent a new
acquisition. Serialization failures roll back local work and never authorize
repeating a remote effect.

The SQL backstop covers task writes through old/new effective repositories and
explicit GitHub URL repositories, project context, binding/cohort enrollment
and task-operation reservations. It conservatively excludes conflicting task
changes throughout the repository while an intent is active. Identical writes,
project display-name changes and append-only comments, signals and audits
retain their permitted behavior. Internal write callbacks are scoped to the
exact active intent, repository and one task, with transaction-local settings
reset afterwards. PR_CREATE also protects its durable task identity when the
task has no prior repository binding. Services still own ordinary authorization
and atomic assessment invalidation.

Prisma schema synchronization alone does not install this backstop. Local
`db:push`, the production migration one-shot and isolated PostgreSQL test setup
also execute `backend/prisma/grounding-github-fence.sql`. Acquisition fails
closed when required schema-local triggers are missing or disabled. Installation
does not activate a product lane.

## Durable GitHub PR creation

`GroundingGithubCreateService.createOrResume(taskId, actor, key, request)`
requires an agent with `tasks:update`, `github:pr_create`, current project
access and eligible creation delegation. It normalizes repository identity
and request defaults, then persists the original actor, key, request
fingerprint and task-bound PR_CREATE intent before remote dispatch. A changed
actor or request conflicts; a repeated request revalidates current authority.

The persisted random operation UUID supplies a per-intent correlation marker.
The provider appends `<!-- agent-tasks:pr-create:<operation-id> -->` to the wire
body. This internal marker does not alter the user's normalized request or
fingerprint and grants no authority by itself. Only the durable dispatch winner
sends the PR-create POST.

After dispatch, retries perform bounded reads instead of sending another POST.
A complete candidate set must contain exactly one PR carrying that exact
marker. Untagged historical or newer PRs are not candidates. The correlated PR
must also pass the strict base repository/ref, source repository/owner/ref,
positive PR number and exact GitHub URL checks. Missing or edited markers,
multiple correlated candidates, incomplete results and unavailable proof stay
pending. The sampled source SHA remains diagnostic for creation because a
branch may advance without becoming a different logical PR.

An uncertain dispatch returns `202 grounding_github_create_pending` and retains
its fence. Once valid proof is recorded, one owned transaction binds branch/PR
fields, invalidates affected grounding context, records mandatory audits,
stores the success response and releases the intent. Binding and invalidation
cannot partially commit. A failed local commit retries from the stored logical
PR identity without creating another PR.

Every completed retry also performs a fresh bounded correlation/identity read
and rechecks current actor authority and delegation before returning the
original 201 response. Proof loss can therefore make a previously successful
operation return pending. Its stored operation remains COMPLETED and its binding remains unchanged;
its released fence is not reacquired. A pending response reports the actual
stored state when readable, or omits it when storage is unavailable.

Late POST responses and later reads are compared with the frozen observed PR
before any saved success is returned. Conflicting positive proof records an
immutable diagnostic, visible comment and mandatory system-observation audit
atomically. It returns `202 grounding_github_create_conflict` with the operation
ID and remains unresolved on later retries. The original binding, result,
operation state and fence ownership are preserved. A failed diagnostic write
returns pending; subsequent completed retries still re-read remote proof
instead of blindly replaying saved success. This is an observation of
inconsistent evidence, not authority to overwrite a task or cancel a dispatch.

## Configured GitHub webhook observations

`GroundingGithubWebhookService` is mounted through the configured webhook
router. A configured webhook secret is verified before event processing;
production requires a secret. Delivery identity is mandatory.
The delivery ID is bound to the event and exact raw-payload fingerprint. An
exact duplicate returns its committed result; reuse with changed bytes or event
returns `409 grounding_operation_conflict`. The delivery claim, observations,
visible comments, task effects and mandatory audit share one serializable
transaction. An audit, reservation or database failure rolls everything back,
allowing the same delivery to retry.

For provisioned tasks, including OFF, issue-close and merged-PR events record
pending observations without writing success/review, clearing claims,
acknowledging signals or consuming receipts. The audit actor is explicitly a
system observation; the sender's GitHub login does not become an authorized
application actor. A valid stored receipt alone cannot grant a webhook a
completion decision. Partial or invalid enrollment remains pending and cannot
select legacy completion.

Weak branch/title PR matches are observation-only regardless of enrollment.
Exact unprovisioned PR bindings retain defined legacy governance/status effects,
and legacy unprovisioned issue-title matches retain issue-close completion.
These local compatibility writes still obey the repository fence. They do not
permit configured unprovisioned remote merge initiation.

PR-open can fill missing PR binding fields only when existing PR number and
URL identity agree. It fills a missing branch and preserves an existing branch,
including qualified fork refs. Actual binding changes and context invalidation
commit together, or collide with an active reservation. No-op binding updates
and comments leave attempts intact. Review changes requested preserve claims
while moving review back to work and invalidating context. Reopen records an
observation; it invalidates when an observed changed head alters an active
CODE_HEAD assessment context, not merely because a new delivery arrived. It
does not invent a new task status.

## Context mutation protocol

`mutateGroundingContext(db, {projectIds, audit, selectAndAuthorize, mutate})`
accepts trusted server callbacks only. It first locks all parent projects in
sorted order, then selects and authorizes the affected scope inside that
serializable transaction, then locks task/binding/cohort rows in sorted task
order. Every selected reservation is checked before any callback write.
The callback uses only the supplied transaction, mutates only its selected
scope and performs no remote effects. Context invalidation and an attributed
mandatory audit commit with its actual writes, or all roll back. Enrollment,
project-wide policy/workflow writers and reassignment must join this common
parent-before-task protocol. Configured GitHub observation and creation writers
use the corresponding locked transaction primitives with the same invalidation
and reservation requirements.

The new boundary reports reservation conflicts as
`409 grounding_finalization_pending`, including on existing C02 routes.
Changed-key identity returns `409 grounding_operation_conflict`; failed shared
transition preconditions return `409 precondition_failed`. Historical unconfigured routes retain their error shapes. Configured
unprovisioned fresh remote merges return `409 grounding_enrollment_required`;
provisioned completion requests use their documented transport and grounding
error responses.

The staged boundary does not activate production enrollment. The direct REST
adapter, project PATCH path, and indirect workflow and project-member writers join the
mutation protocol. Workflow customization, template application, reset,
default creation or replacement, definition changes, and member removal select
their affected tasks before writing. That selection includes tasks inheriting a
project default through a null `workflowId`; an explicit workflow reference is
also selected when its definition changes or reset detaches it. Name-only
workflow writes and non-default workflow creation leave active attempts intact.
Member removal clears the affected live work/review claims, invalidates their
contexts, and deletes the membership in one transaction. Configured GitHub
creation and webhook writers participate as described above. Public MCP
transport, issuer isolation and rollout qualification remain separate work;
this contract does not claim production activation.

An actual `Project.requireGroundingForDebug` toggle is a project context
change: it atomically invalidates affected attempts and writes the mandatory
attributed context audit. Repeating its current value preserves attempts. The
toggle does not enroll, downgrade or otherwise alter the protected
binding/cohort.

## Dormant creation policy and retained history

The app may receive a server-owned, readonly per-project creation policy with one explicit `projectId` and `subjectMode` (`TASK_SPEC` or `CODE_HEAD`) entry. Its default is empty: it is not selected from environment, project flags, metadata, labels or other tasks. A selected project creates its initial task, cohort and protected binding in one transaction. Agent creation still enters backlog; a selected request that tries to create a review or terminal task is rejected with grounding guidance rather than manufacturing a protected success. Imports preserve their existing per-row atomic, partial-result behavior. There is no historical administrative import in this contract, and this dormant configuration does not constitute production enrollment or issuer/rollout qualification.

For an enrolled task or project, deletion first checks an unresolved reservation, then rejects retained grounding history with `409 grounding_history_retained`. The rejection preserves the task/project and its history; it is not archival, disposal or an abandon transition. Unenrolled task deletion retains the historical behavior. No project-reassignment feature is introduced.
