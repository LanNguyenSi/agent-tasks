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

`GroundingAttemptsService` adds dormant consumer storage and two authenticated routes. `createApp(corsOrigins, groundingService?)` requires explicit service injection; the default returns `503 grounding_verification_unavailable`. There is no HTTP enrollment endpoint. The server-only `provision({taskId, projectId, subjectMode})` method requires an existing matching task, an explicit audience, a supported pinned policy and a usable independently configured trust store. Repeating identical provisioning is idempotent; conflicting provisioning fails. It never reads task metadata, changes the legacy `requireGroundingForDebug` default, or creates protection from `debugFlavor`.

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

Metadata, debug suggestions, comments, labels, priority, result text and display/audit timestamps do not enter this projection. Changing any projected value requires a new context. A first challenge uses revision 1; later issuance increments the protected revision when its projection bytes differ from the last issued projection. Issuance without a projection change retains the revision but always creates a fresh attempt and nonce. Upload rederives the current bytes and rejects divergence, including on an exact retry. This is local revalidation, not the later integration of every context writer: changes which are reverted between observations are not detected by this milestone, and unchanged existing writers do not yet all participate in the mutation protocol below.

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
task router. It handles `POST /api/tasks/:id/finish`, `/merge`, and `/abandon`
only when authoritative cohort selection finds a provisioned cohort. An absent
cohort and binding is the separate historical `UNPROVISIONED` case; an invalid
cohort, orphan binding, database failure, or missing trusted configured service
fails closed and never enters the compatibility handler. Server-only enrollment
must quiesce active legacy requests before enrolling them; live conversion is
not a concurrency guarantee.

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

## Remote reservation, dispatch and recovery

`GroundingFinalizationService` extends the shared completion service with
`reserveMerge`, `dispatchMerge`, `recoverMerge` and `cancelMerge`. Reservation
persists the operation, exact repository/PR/source head/method, local context
snapshot and selected decision. Receipt-backed reservations retain the required
same-task receipt foreign key. A single cohort reservation pointer blocks
competing operations, C02 issuance/uploads and participating context mutations.
Required CI uses the existing check-run classification and cache policy, but its
reported SHA must equal a fresh authorized head sample. That CI head is stored
in the decision and must also match receipt reprojection, reservation and final
dispatch head samples. A cached result for an earlier head blocks until normal
cache refresh; neither grounding override nor OFF mode skips required CI.
Merge refuses foreign deliverables and requires `github:pr_merge` for agents
and an eligible `allowAgentPrMerge` delegate. Required CI/rules still run;
`prMerged` is discharged only by the later exact merged proof.

A fresh standalone merge remains review-only and must satisfy that route's
terminal edge and governance gates. Once its operation is durably reserved,
dispatch and recovery use the stored task-merge identity: they still recheck
current project access, merge scope, merge consent, CI and exact source-head
proof, but do not reinterpret a historical operation as a new claim or review
admission. A completed replay is likewise operation-bound and never repeats
its durable effects.

Dispatch rechecks current authority, gates, context, head, trust and receipt
freshness before a durable RESERVED-to-DISPATCHED compare-and-set. Only the
winner issues a remote write, outside the database transaction. The GitHub
adapter sends `PUT /repos/{repo}/pulls/{number}/merge` with the expected source
`sha`, on a fixed GitHub API host, with redirects disabled, a five-second abort
deadline and 256-KiB body bound. The resulting merge commit is separate from the
source head. Trust is sampled in this process; this does not provide atomic
configuration revocation across instances or a transaction with GitHub.

A timeout or uncertain dispatch remains DISPATCHED. Retries/recovery perform
reads only and require the exact repository, PR number, merged state and source
`head.sha`, plus a valid separate merge commit. An open PR, wrong head, missing
proof or read failure does not unlock the reservation or cause another merge.
Matching recovery applies the stored decision and consumes evidence once even
after its TTL, with task/claim/audit changes in one transaction. It also compares
the original local snapshot and receipt projection, without requiring renewed
TTL/trust, so a nonparticipating writer cannot substitute new work or claims
under the old decision. Such drift remains unresolved. A crash after dispatch
claim but before network send is conservatively uncertain too.

`cancelMerge(taskId, actor, key, reason)` provides recovery only for RESERVED,
provably undispatched operations. It requires the originating actor's current
project write access and a bounded nonblank reason, then atomically marks
CANCELLED, invalidates the attempt, clears the reservation and writes mandatory
audit. Repeating the same cancellation returns its stored result; changing its
reason conflicts. A dispatch/cancel race has one serialized winner. DISPATCHED
operations cannot be cancelled, even if their PR currently appears open.
A new operation after cancellation requires a new challenge/evidence decision.

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
parent-before-task protocol; unchanged existing routers are not yet covered.

The new boundary reports reservation conflicts as
`409 grounding_finalization_pending`, including on existing C02 routes.
Changed-key identity returns `409 grounding_operation_conflict`; failed shared
transition preconditions return `409 precondition_failed`. Historical
`UNPROVISIONED` completion route error shapes and behavior are unchanged;
provisioned completion requests use their documented transport and grounding
error responses.

The staged boundary does not activate production enrollment. Other positive
status writers, indirect workflow/team writers, GitHub/webhook writers, public
MCP routing, and issuer/rollout qualification remain separate work. They must
join the same context and authorization rules before productive activation.
