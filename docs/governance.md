# Governance

How agent-tasks enforces *when* work may move forward: claim gates, transition preconditions, and the project-level governance modes that decide whether review is mandatory, optional, or bypassed.

## Confidence scoring (claim gate)

Every task gets a deterministic confidence score (0–100%) measuring whether it has enough information for an agent to work on. On projects whose `enforcementMode` is `BLOCK`, agent claims below the threshold, or claims violating a keystone, are rejected with `422 low_confidence`. The default (`WARN`, also used when the field is unset) records a `task.claim_would_block_shadow` audit event and allows the claim, and `OFF` skips the check (see [scorer-v2-enforcement.md](scorer-v2-enforcement.md)). Humans see the score as a UI warning.

The score is **deterministic, no LLM, pure heuristics**:

| Signal | What it measures |
|--------|-----------------|
| Title | Is there a title at all? |
| Description quality | Length (diminishing returns), information density (unique content words vs stop words, EN+DE), structure (lists, sections, line breaks), concreteness (file paths, URLs, code refs, numbers) |
| Template fields | Goal, acceptance criteria, context, constraints, only counted when enabled per project |

The score normalises against what's configured: a project without templates can still reach 100% with a well-written description. A project with all template fields enabled requires more structured input.

**Template presets** let teams define reusable starting points (Bug Fix, Feature, Refactoring) that pre-fill description and template fields with actionable placeholder text. One click, then replace the `[brackets]`.

```
GET /api/tasks/{id}/instructions → { ..., confidence: { score, missing, threshold } }
POST /api/tasks/{id}/start       → 422 if BLOCK and below threshold (agents only; the deprecated /claim runs the same gate)
                                   override: ?force=true&forceReason=<at least 10 characters>,
                                   only with the confidence:override scope (403 without it)
```

## Backlog routing (agent-created tasks)

Agents claim tasks in `open` status only. A task created by an agent via `task_create` is hard-routed to `backlog` status (requesting any other status at create time fails with `400 backlog_routing_enforced`); human-created tasks default to `open`.

While a task sits in `backlog`:

- it is **invisible to `task_pickup`** and to the default `GET /api/tasks/claimable` pool,
- `task_start` and the legacy claim route reject it with `403 backlog_not_promoted`,
- it is an unreviewed **draft space**: `task_respec` is open to any caller (the creating agent can sharpen its own proposal, a human can edit before promoting), instead of the creator-only rule that applies from `open` onward,
- a task that depends on it stays blocked; a `backlog` blocker counts as unresolved until promoted.

Only a human moves a task out of `backlog`: **promote** to `open` (board affordance or `PATCH /api/tasks/:id { status: "open" }`, audited as `task.backlog_promoted`) when it is ready for the claimable pool, or **discard** to `abandoned` (audited as `task.backlog_discarded`). No implicit promotion happens on any other event. The creating agent may also retire its own unpromoted draft via `task_creator_abandon`.

The reverse move, **demote**, takes a task promoted by mistake from `open` back to `backlog` (`PATCH /api/tasks/:id { status: "backlog" }`, audited as `task.backlog_demoted`; the board offers it as "Move to backlog"). The rules:

- it needs the same project write tier as promote and discard; agents cannot demote, because the `status` field is closed to them,
- it applies to an `open` task with no work or review claim: it answers `409` while anyone holds a claim, and a `task_start` that claims first wins the race and makes the demote answer `409`,
- from every status other than `open` it answers `400`, also when the project stores an older workflow definition with an edge into `backlog` or an initial state of `backlog`,
- a grounding-enrolled task follows the same rules (`400` from a status other than `open`, `409` with the same message while a claim is held, including when a claim or status change lands after the request was read), and a successful demote is audited and acknowledges the signals the same way,
- after a successful demote the task's pending signals are acknowledged, so they stop waking agents.

Together with the confidence gate this closes the loop on agent-generated work: agents may propose tasks at any time, but nothing an agent wrote enters the claimable pool without a human decision. Full state chart in [docs/state-machines.md](state-machines.md).

## Transition preconditions

Per-transition rules like `branchPresent`, `prPresent`, `prMerged`, `ciGreen` are defined in the workflow schema and enforced server-side. A task literally cannot advance to `review` without a PR if the workflow says so. Full rule list and authoring guide: [docs/workflow-preconditions.md](workflow-preconditions.md).

Server-side enforcement, not prompt suggestion. Every rule is checked by the API, not by the agent's prompt. Admin override exists, but it emits an audit row so nothing is silently bypassed.

### Human override from the task page

A project admin (team `ADMIN`, or a per-project `PROJECT_ADMIN` with no team-level role, see [permissions.md](permissions.md#project-roles)) gets escape hatches on the task: all three below are controls on the task detail page. All are audited and none is available to agents:

- **Force a status transition** past a failed precondition. Picking a target state that a blocked transition would reject surfaces the failing rules inline with a "force" affordance; confirming requires a non-empty reason and is audited as `task.transitioned.forced`.
- **Release a work or review claim held by anyone** — a stuck agent, an absent teammate, or their own claim — via an admin-only release control next to the assignee/reviewer, audited as `task.claim_released_by_admin` / `task.review_claim_released_by_admin`.
- **Reassign a work or review claim to a specific actor**: hand the claim from its current holder straight to a chosen human or agent with the reassign picker next to the release control (`POST /tasks/:id/admin-reassign`), without releasing it first. The candidates come from `GET /projects/:id/eligible-actors` (project and team members who can write, plus the team's live agent tokens). Both calls are human-project-admin-only; an agent token is refused. An agent target must not already hold another active claim, and on a project that requires a distinct reviewer the review claim cannot go to the work claimant nor the work claim to the review holder. Audited as `task.claim_reassigned`.

Non-admin humans see the force and release controls disabled with the reason; the reassign picker is shown only to project admins and not on `done` tasks. See [docs/workflow-preconditions.md](workflow-preconditions.md#forcing-a-transition-past-a-failed-precondition) for the forced-transition wire format.

### Inspecting a project's gates

`GET /api/projects/:id/effective-gates` (MCP `projects_get_effective_gates`, CLI `agent-tasks projects effective-gates <slug-or-id>`) returns the gates and the task-creation requirements in force for a project. Call it before `task_create` or `task_submit_pr`.

### Debug-grounding finish gate (opt-in)

Off by default. With `requireGroundingForDebug: true` on the project, finishing a work claim on a debug-flavored task requires an active grounding session on the task, at least one evidence-ledger entry for that session, and a session phase of `claim-evaluation` or later (`complete`); otherwise `task_finish` answers `409 grounding_required` with the `missing` items. On projects without the flag, finishing a debug-flavored task writes `task.grounding_gate.bypassed` as a record that the gate would have applied. `AGENT_TASKS_DISABLE_GROUNDING=1` replaces the grounding client with one that reports no ledger entries, so an opted-in project then fails the ledger check (with `docker-compose.prod.yml`, the variable must be added to the backend service's `environment:` block, which forwards only the variables it lists). Background: [ADR 0013](adr/0013-grounding-finish-gate.md).

## Governance modes (per project)

`governanceMode` (formerly `soloMode` + `requireDistinctReviewer`, see ADR-0010) decides what happens when a PR is merged and how strict the reviewer rule is.

| Mode | Behaviour on PR merge | Self-merge allowed? | Use case |
|------|-----------------------|---------------------|----------|
| `AUTONOMOUS` (formerly `soloMode: true`) | Task moves straight to `done`, no review state | Yes | Solo projects, agent demos, low-stakes batches |
| `AWAITS_CONFIRMATION` (formerly `soloMode: false`, `requireDistinctReviewer: false`) | Task moves to `review`; emits `self_merge_notice` to humans on subsequent self-merge to `done` | Yes, but everyone gets a signal | Default for most teams |
| `REQUIRES_DISTINCT_REVIEWER` (formerly `requireDistinctReviewer: true`) | Task moves to `review`; `checkSelfMergeGate` blocks the author from merging their own work | No | Regulated / two-person-rule contexts |

See [docs/review-automation-policy.md](review-automation-policy.md) for the full rule set (a webhook merge picks the same target for default and custom workflows), and [docs/signal-payload-design.md](signal-payload-design.md) for the `self_merge_notice` signal schema.

## Audit

Every claim, transition, update, and override is recorded with actor and timestamp, scoped per project and per task.

```
GET /api/projects/:id/audit
GET /api/tasks/:id/audit
```
