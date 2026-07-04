# Governance

How agent-tasks enforces *when* work may move forward: claim gates, transition preconditions, and the project-level governance modes that decide whether review is mandatory, optional, or bypassed.

## Confidence scoring (claim gate)

Every task gets a deterministic confidence score (0–100%) measuring whether it has enough information for an agent to work on. Agents are blocked from claiming low-confidence tasks via the API (`422 unprocessable_entity`); humans see the same signal as a UI warning.

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
POST /api/tasks/{id}/claim       → 422 if score < threshold (agents only, bypass with ?force=true)
```

## Transition preconditions

Per-transition rules like `branchPresent`, `prPresent`, `prMerged`, `ciGreen` are defined in the workflow schema and enforced server-side. A task literally cannot advance to `review` without a PR if the workflow says so. Full rule list and authoring guide: [docs/workflow-preconditions.md](workflow-preconditions.md).

Server-side enforcement, not prompt suggestion. Every rule is checked by the API, not by the agent's prompt. Admin override exists, but it emits an audit row so nothing is silently bypassed.

### Human override from the task page

A project admin (team `ADMIN`, or a per-project `PROJECT_ADMIN` with no team-level role) gets two escape hatches directly on the task detail page, both audited and both absent for agents:

- **Force a status transition** past a failed precondition. Picking a target state that a blocked transition would reject surfaces the failing rules inline with a "force" affordance; confirming requires a non-empty reason and is audited as `task.transitioned.forced`.
- **Release a work or review claim held by anyone** — a stuck agent, an absent teammate, or their own claim — via an admin-only release control next to the assignee/reviewer, audited as `task.claim_released_by_admin` / `task.review_claim_released_by_admin`.

Non-admin humans see both controls disabled with the reason, never hidden. See [docs/workflow-preconditions.md](workflow-preconditions.md#forcing-a-transition-past-a-failed-precondition) for the forced-transition wire format.

## Governance modes (per project)

`governanceMode` (formerly `soloMode` + `requireDistinctReviewer`, see ADR-0010) decides what happens when a PR is merged and how strict the reviewer rule is.

| Mode | Behaviour on PR merge | Self-merge allowed? | Use case |
|------|-----------------------|---------------------|----------|
| `AUTONOMOUS` (formerly `soloMode: true`) | Task moves straight to `done`, no review state | Yes | Solo projects, agent demos, low-stakes batches |
| `AWAITS_CONFIRMATION` (formerly `soloMode: false`, `requireDistinctReviewer: false`) | Task moves to `review`; emits `self_merge_notice` to humans on subsequent self-merge to `done` | Yes, but everyone gets a signal | Default for most teams |
| `REQUIRES_DISTINCT_REVIEWER` (formerly `requireDistinctReviewer: true`) | Task moves to `review`; `checkSelfMergeGate` blocks the author from merging their own work | No | Regulated / two-person-rule contexts |

See [docs/review-automation-policy.md](review-automation-policy.md) for the full rule set, including how custom workflows interact with the modes, and [docs/signal-payload-design.md](signal-payload-design.md) for the `self_merge_notice` signal schema.

## Audit

Every claim, transition, update, and override is recorded with actor and timestamp, scoped per project and per task.

```
GET /api/projects/:id/audit
GET /api/tasks/:id/audit
```
