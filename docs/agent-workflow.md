# Agent workflow guide

End-to-end reference for AI agents working with agent-tasks. For a quicker introduction, see the [getting started guide](getting-started.md).

## CLI or API?

All examples below show both the [@agent-tasks/cli](../cli/README.md) command and the equivalent curl/API call.

**CLI setup** (the CLI is not published to npm yet; install it from a checkout as described in [cli/README.md](../cli/README.md#try-it-in-60-seconds)):
```bash
export AGENT_TASKS_ENDPOINT=https://agent-tasks.opentriologue.ai
export AGENT_TASKS_TOKEN=at_...
```

**API setup:**
```bash
TOKEN="at_..."
BASE="https://agent-tasks.opentriologue.ai/api"
```

## Authentication

Agents authenticate with team-scoped Bearer tokens.

**Task scopes:** `tasks:read` `tasks:create` `tasks:claim` `tasks:comment` `tasks:transition` `tasks:update` `projects:read` `boards:read`

**GitHub delegation scopes** (opt-in, required for server-side PR create/merge): `github:pr_create` `github:pr_merge`

**Override scope** (operator-only): `confidence:override`: on projects whose `enforcementMode` is `BLOCK`, required to use `?force=true` to claim a task below the project's confidence threshold (or one violating a keystone). It is withheld from ordinary task-executing tokens so the gated agent cannot wave itself through; an operator (team admin) mints a token carrying it for a deliberate, audited override. Without it, `force=true` returns `403` under `BLOCK`, and the override is recorded with the operator identity. Under `WARN` (the default) and `OFF`, a low-confidence claim goes through without `force`, and `force` is ignored.

Existing tokens do not automatically gain the GitHub scopes. Re-mint a token with `scopes: [..., "github:pr_create", "github:pr_merge"]` if you want agents to open and merge PRs through agent-tasks instead of via a separate GitHub identity on the agent side. Projects using the legacy gh-CLI flow (agents carry their own GitHub credential and pass the resulting URL via `task_finish { prUrl }`) don't need these scopes. Every `403` refusal on the PR create, PR merge, task merge, task finish, task abandon and grounding-attempt issue (`POST /tasks/:id/grounding-attempts`) routes keeps `error: "forbidden"` and names the failed precondition in its `message`, with three exceptions that can be a bare `{ "error": "forbidden" }`: the answer to a caller without access to the project on the grounding-attempt issue route and, on the GitHub create and merge routes, the legacy handler's own answer (so a task's existence is not observable without access); a linked task of another project that the caller cannot write inside a multi-task merge; and a refusal caused by access, the token or a claim changing while the request is in flight. The grounding-attempt issue route admits a caller through the claim and scope check (an agent token with `tasks:transition`, or a human, with project write access and the work or review claim on the task) or else through merge eligibility (the `task_merge` checks), both before it reads the request's `intent`, so the intent never changes the admission answer; an admitted caller's intent then selects the issuance policy (a merge-only token admitted on a review task gets `Token missing scope: tasks:transition` for `intent: "finish"`). When neither admits the caller, the answer is the claim or scope refusal (`Token missing scope: tasks:transition` for an agent token without that scope, otherwise `You hold neither the work claim nor the review claim on this task`), also for `intent: "merge"`, with two exceptions. First, a caller that passes merge eligibility's actor check (a human, or an agent token with `github:pr_merge`) and meets its `409 bad_state` on a task in its initial or a terminal state, or in a review state with no single terminal edge (an ambiguous workflow), gets that `409 bad_state`, whether or not it holds a claim and whether or not it has `tasks:transition`; an unavailable workflow definition keeps its own answer likewise. The `bad_state` of a work state outside review, such as `in_progress`, is not an exception: the claim or scope refusal stays. Second, a merge-only token (an agent token with `github:pr_merge` and project write access, without `tasks:transition`, holding no claim on the task) can never pass the claim path, so it gets whatever merge eligibility refused with, the same answer `task_merge` gives that caller: the missing `allowAgentPrMerge` consent, the review lock or the review approval gate, the transition role, or `409 bad_state` in any state, a work state included. A token without `github:pr_merge` is not merge-capable and always gets the claim or scope refusal. A caller without project access gets one bare 403 before any of this. Per agent-token combination of claim held, `tasks:transition` and `github:pr_merge`: a held claim with `tasks:transition` is admitted by the claim path; a held claim without `tasks:transition` or `github:pr_merge` gets the `tasks:transition` refusal; a held claim with `github:pr_merge` and without `tasks:transition` is admitted when merge eligibility admits, otherwise gets the `tasks:transition` refusal, except for the first exception above; no claim with `tasks:transition` and without `github:pr_merge` gets the claim refusal; no claim with `tasks:transition` and `github:pr_merge` is admitted when merge eligibility admits, otherwise gets the claim refusal, except for the first exception above; no claim, no `tasks:transition` and no `github:pr_merge` gets the `tasks:transition` refusal; no claim, no `tasks:transition` and `github:pr_merge` is the merge-only token of the second exception. A human has no scope: with a claim it is admitted by the claim path; without one it is admitted when merge eligibility admits, otherwise it gets the claim refusal, except for the first exception above. The messages are `Token missing scope: ...` for one or more absent scopes (`Agent token required` for a non-agent caller), `No write access to this project`, `You hold neither the work claim nor the review claim on this task`, `Finishing work requires the work claim on this task and no review claim`, `Approving or requesting changes requires the review claim on this task, or the work claim while no review claim is held`, `Review approval is blocked: ...` naming the missing review lock, the lock held by the work claimant or the work claimant approving their own work, `The transition to <state> requires the <role> project role`, `Self-merge is blocked: a distinct reviewer must merge`, `No team member allows agent PR merges (allowAgentPrMerge)`, `No team member with a connected GitHub account allows agent PR creation (allowAgentPrCreate)`, `The task's PR lives in a repository foreign to this project, ...`, `This Idempotency-Key was already used on this task by a different caller` and `The active grounding attempt was issued to a different caller; ...`.

## Typical flow

| Step | MCP v2 verb | CLI | REST |
|---|---|---|---|
| Check inbox | `signals_poll` | `agent-tasks signals` | `GET /api/agent/signals` |
| Find work | `task_pickup` | `agent-tasks pickup` | `POST /api/tasks/pickup` |
| Claim a task | `task_start` | `agent-tasks tasks start <id>` | `POST /api/tasks/{id}/start` |
| Read instructions | (returned by `task_start`) | `agent-tasks tasks instructions <id>` | `GET /api/tasks/{id}/instructions` |
| Do the work | (branch, code, commit, push) | (same) | (same) |
| Record PR metadata (after `gh pr create`) | `task_submit_pr` | `agent-tasks tasks submit-pr <id> ...` | `POST /api/tasks/{id}/submit-pr` |
| Submit for review / approve | `task_finish` | `agent-tasks tasks finish <id> ...` | `POST /api/tasks/{id}/finish` |
| Merge | `task_merge` | `agent-tasks github pr merge <pr-number> --task <id> --owner <owner> --repo <repo>` (not equivalent: it calls `POST /api/github/pull-requests/{prNumber}/merge`, see the note below) | `POST /api/tasks/{id}/merge` |
| Done | (set by `task_merge`, by a reviewer's `task_finish` approve, or by the merge webhook in `AUTONOMOUS` projects) | (same) | (same) |

The CLI has no task-scoped merge command: `agent-tasks github pr merge` takes
the PR number and calls `POST /api/github/pull-requests/{prNumber}/merge`.
For the task-scoped merge, use the MCP verb `task_merge` or
`POST /api/tasks/{id}/merge`, or let the reviewer merge on approval with
`agent-tasks tasks finish <id> --outcome approve --auto-merge`.

> **Claim boundary.** Agents claim tasks in `open` status only. Tasks an
> agent creates land in `backlog`: invisible to `task_pickup` and
> `GET /api/tasks/claimable`, and rejected by `task_start` / claim with
> `403 backlog_not_promoted` until a human promotes them to `open`
> (`PATCH /api/tasks/{id} { status: "open" }` or the board). See
> [docs/governance.md](governance.md#backlog-routing-agent-created-tasks).

The MCP v2 verbs are the recommended surface for new agent code. They wrap
the same REST endpoints the CLI hits, with governance state and the
self-merge gate baked into each call. The v1 verbs (`tasks_claim`,
`tasks_release`, raw `tasks_transition`) were pruned from the default MCP
tool registration by rc-v1-C007; they remain reachable only with
`AGENT_TASKS_MCP_LEGACY=1` set in the server process's environment. New
code should use `task_start` (replaces `tasks_claim`), `task_abandon`
(replaces `tasks_release`), and `task_start` / `task_finish` (replace raw
`tasks_transition`) instead.

### Step by step

```bash
TOKEN="at_..."
BASE="https://agent-tasks.opentriologue.ai/api"

# 1. Pick up work: returns a pending signal, a review to do, a claimable
#    task, or idle. To browse the claimable pool instead, use
#    GET $BASE/tasks/claimable (25 per page by default; when the response
#    says "truncated": true, pass its nextCursor as ?cursor= to see the rest)
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/tasks/pickup"

# 2. Start the task: claims it and moves it to in_progress
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/tasks/{id}/start"

# 3. Read instructions (recommended action, allowed transitions, confidence)
curl -H "Authorization: Bearer $TOKEN" "$BASE/tasks/{id}/instructions"
# → { recommendedAction, allowedTransitions, updatableFields, confidence }

# 4. Create branch, do the work, push, open the PR (gh pr create)

# 5. Record branch and PR on the task (all three fields are required)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"branchName":"feat/my-branch","prUrl":"https://github.com/<owner>/<repo>/pull/1","prNumber":1}' \
  "$BASE/tasks/{id}/submit-pr"

# 6. Finish the work claim: the task moves to review
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"result":"..."}' \
  "$BASE/tasks/{id}/finish"

# 7. A reviewer starts the task in review (this takes the review lock),
#    then finishes it with an outcome
curl -X POST -H "Authorization: Bearer $REVIEWER_TOKEN" "$BASE/tasks/{id}/start"
curl -X POST -H "Authorization: Bearer $REVIEWER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"outcome":"approve"}' \
  "$BASE/tasks/{id}/finish"
```

The v1 routes `POST /tasks/{id}/claim`, `PATCH /tasks/{id}` for the PR
fields and `POST /tasks/{id}/transition` still work, but `/start`,
`/submit-pr` and `/finish` are the sequence the MCP verbs and the CLI use.

## GitHub credentials

This repository does not ship a GitHub token helper. When the project has a linked GitHub repo and a team member has connected GitHub and granted the `allowAgentPrCreate` consent on their own account (the owner of the submitting token is preferred), `task_submit_pr` checks that the PR author is that delegation user and rejects other authors with `403 pr_author_mismatch`. It reads the PR author through the delegation token and does not create the PR; if the GitHub API call fails, the check is skipped. Open the PR with `pull_requests_create` (team delegation, no agent-side credential) or with `gh` authenticated as that user; a token that authors as a GitHub App bot fails the check. `task_merge` and `pull_requests_*` act through the delegation user's GitHub identity.

## Task ↔ PR binding

Always set `branchName` and `prNumber` on your task so webhooks can reliably match PR events back to the task. The binding strategy (in priority order):

1. **`prNumber`**: strongest, set via `task_submit_pr` (or PATCH)
2. **`prUrl`**: set via `task_submit_pr` (or PATCH)
3. **`branchName`**: matches PR's `head.ref`
4. **title pattern**: fallback, matches `[PR #N]`

**Cross-repo PR guard.** `task_finish` (and `task_submit_pr`) reject a
`prUrl` whose `owner/repo` does not match the bound `project.githubRepo`.
If the agent opens a PR in the wrong repo by accident, the call fails
fast with `400 cross_repo_pr_rejected` instead of letting the binding
silently drift. Verify `project.githubRepo` before opening the PR. Tasks
whose legitimate deliverable is a PR in a *different* repo (benchmark/
measurement/docs tasks) can set `deliverableRepo` at `task_create` time —
the guard then compares against that repo instead. Merge automation still
refuses to merge a foreign deliverable; see
[workflow-preconditions.md](workflow-preconditions.md#cross-repo-deliverable-override-deliverablerepo).

**Merge paths land tasks in different states.** `task_merge` calls
`POST /api/tasks/{id}/merge` and `pull_requests_merge` calls
`POST /api/github/pull-requests/:n/merge`; both run the self-merge gate and
land the task on `done` directly. A PR merged through the GitHub UI or
`gh pr merge` arrives via the webhook path, where tasks in any
non-`AUTONOMOUS` project (default or custom workflow) land in `review` and
need an explicit `task_finish { outcome: "approve" }` to reach `done`.
`AUTONOMOUS` projects (legacy `soloMode=true`) always land on `done`
regardless of merge path.

## Key endpoints

| Endpoint | CLI equivalent | Purpose |
|---|---|---|
| `GET /api/agent/signals` | `agent-tasks signals` | Poll signal inbox |
| `POST /api/agent/signals/{id}/ack` | `agent-tasks ack <id>` | Acknowledge a signal |
| `POST /api/tasks/pickup` | `agent-tasks pickup` | Next signal, review or claimable task |
| `GET /api/tasks/claimable` | `agent-tasks tasks list` | Browse available work |
| `POST /api/tasks/{id}/start` | `agent-tasks tasks start <id>` | Claim an open task, or take the review lock on a task in review |
| `GET /api/tasks/{id}/instructions` | `agent-tasks tasks instructions <id>` | Get agent context |
| `POST /api/tasks/{id}/submit-pr` | `agent-tasks tasks submit-pr <id> --branch ... --pr-url ... --pr-number ...` | Record branchName, prUrl, prNumber |
| `POST /api/tasks/{id}/finish` | `agent-tasks tasks finish <id>` | Finish the work claim or the review claim |
| `POST /api/tasks/{id}/abandon` | `agent-tasks tasks abandon <id>` | Release the held claim |
| `PATCH /api/tasks/{id}` | `agent-tasks tasks update <id>` | Update branchName, prUrl, prNumber, result |
| `POST /api/tasks/{id}/comments` | `agent-tasks tasks comment <id> "..."` | Add a comment |
| `POST /api/tasks/{id}/claim` | `agent-tasks tasks claim <id>` (deprecated) | Deprecated v1 claim; use `/start` |
| `POST /api/tasks/{id}/transition` | `agent-tasks tasks status <id> <status>` (deprecated) | Deprecated v1 status change; use `/start` and `/finish` |
| `POST /api/tasks/{id}/release` | `agent-tasks tasks release <id>` (deprecated) | Deprecated v1 release; use `/abandon` |
| `POST /api/tasks/{id}/review` | `agent-tasks review approve/request-changes <id>` (deprecated) | v1 review; use `/finish` with `outcome` |
| `POST /api/tasks/{id}/review/claim` | `agent-tasks review claim <id>` (deprecated) | v1 review lock; use `/start` |
| `GET /api/projects/available` | — | Discover accessible projects |

Route overview: [v2-api.md](v2-api.md). A running backend also serves Swagger UI at `/docs` and the OpenAPI JSON at `/api/openapi.json` (hosted: [Swagger UI](https://agent-tasks.opentriologue.ai/docs), [OpenAPI JSON](https://agent-tasks.opentriologue.ai/api/openapi.json)); the OpenAPI document covers a subset of the routes, see [api-contract.md](api-contract.md).

## Confidence scoring

On projects whose `enforcementMode` is `BLOCK`, an agent claim (`task_start`, or the deprecated `/claim`) below the project's confidence threshold, or one violating a keystone, is rejected with `422 low_confidence`. The default `WARN` (also used when the field is unset) records a `task.claim_would_block_shadow` audit event and lets the claim through, and `OFF` skips the check (see [scorer-v2-enforcement.md](scorer-v2-enforcement.md)). Under `BLOCK`, a token with the `confidence:override` scope can override with `?force=true&forceReason=<at least 10 characters>` (see [Authentication](#authentication)). Check `GET /api/tasks/{id}/instructions` for the score and missing fields.

## Governance mode (opt-in)

Projects set `governanceMode` in the settings modal. Three values:

- `REQUIRES_DISTINCT_REVIEWER` (legacy: `requireDistinctReviewer=true`) — a `review → done` transition is rejected if the actor attempting it is the task's claimant, or if no review lock is held, or if the review lock is held by the claimant. Prevents a single agent from self-approving its own work by calling `POST /tasks/{id}/transition` directly and bypassing `POST /tasks/{id}/review`.
- `AWAITS_CONFIRMATION` (legacy: both flags false) — self-approval is allowed, but every human on the team receives a `self_merge_notice` signal when the task reaches `done`. Async HITL.
- `AUTONOMOUS` (legacy: `soloMode=true`) — no gates, no notifications.

The legacy `requireDistinctReviewer` / `soloMode` boolean fields are still readable through the deprecation window; writes from clients that still send the old flags are server-side derived into `governanceMode`.

**Happy path with the flag on** (v1 routes):

```bash
# Agent A (token A) claims and implements
curl -X POST -H "Authorization: Bearer $TOKEN_A" "$BASE/tasks/{id}/claim"
# ... do the work ...
curl -X POST -H "Authorization: Bearer $TOKEN_A" -d '{"status":"review"}' \
  "$BASE/tasks/{id}/transition"

# Agent A tries to self-approve — rejected with 403
curl -X POST -H "Authorization: Bearer $TOKEN_A" -d '{"status":"done"}' \
  "$BASE/tasks/{id}/transition"
# => 403 "This project requires a distinct reviewer…"

# Agent B (token B) claims the review lock, then approves
curl -X POST -H "Authorization: Bearer $TOKEN_B" "$BASE/tasks/{id}/review/claim"
curl -X POST -H "Authorization: Bearer $TOKEN_B" -d '{"action":"approve"}' \
  "$BASE/tasks/{id}/review"
# => task.status == "done"
```

With the v2 routes the same rule applies at `POST /tasks/{id}/start` on a task in `review`: the work claimant gets `403 "Cannot review your own task"`, and agent B approves with `POST /tasks/{id}/start` followed by `POST /tasks/{id}/finish` with `{"outcome":"approve"}`.

**Escape hatch:** project admins (team `ADMIN`, or a per-project `PROJECT_ADMIN`) can still pass `force: true` with a `forceReason` on the transition endpoint. The bypass is admin-gated: `force: true` from anyone else is rejected with `403 "Only team admins can force a transition"` (the message names team admins; a `PROJECT_ADMIN` passes the same check), independent of whether the preconditions would have passed. The bypass is audit-logged as `task.transitioned.forced`.

**Rejected transitions are audit-logged** as `task.review_rejected_self_reviewer` with a `reason` field (`self_review`, `no_review_lock`, or `review_lock_held_by_claimant`), an `endpoint` field (`transition` or `patch`), and — for agent actors — an `agentTokenId` so that attempts to bypass the gate are traceable back to the token.

**The gate applies to every status-write path**, not just `/transition`. `PATCH /tasks/:id` with `{"status": "done"}` is also gated, so a human clicking "Mark Done" in the UI goes through the same check. The frontend's Mark Done button calls `/transition` by default. `POST /api/github/pull-requests/:prNumber/merge` (the backend of the `pull_requests_merge` MCP tool) is also gated — it rejects `open` or `in_progress` tasks outright, and applies the distinct-reviewer check on `review → done` merges. The idempotent re-entry path (task already in `done`) skips the gate because the rule was evaluated the first time the task reached `done`.

**Admin escape hatch for merges**: admins who need to bypass the gate for a merge use `POST /tasks/:id/transition` with `force: true` + `forceReason` first (moving the task to `done` under the admin-gated force path), then call the merge endpoint — which now accepts `done` as a valid entry state. The escape hatch lives in exactly one place.

**Humans and agents are treated identically.** A human claimant cannot approve their own task any more than an agent can — the governance invariant does not hinge on credential type. If you need a human-only carve-out for your workflow, use force-transition from an admin account.

**Toggling the flag while a review is in flight** does not affect the in-flight review lock: the lock stays as-is. The gate only fires on the next `review → done` attempt. If a lock gets stranded (e.g. flag flipped ON while the claimant held the lock from before), the claimant can call `POST /tasks/:id/review/release` to clear it, then another actor can call `POST /tasks/:id/review/claim`.

**Only project admins (team `ADMIN` or per-project `PROJECT_ADMIN`) can toggle `governanceMode`** (and the deprecated `requireDistinctReviewer` / `soloMode` flags), consistent with other governance settings on the project (confidence threshold, task template). Changes to governance fields are audit-logged as `project.updated` with a `changes` payload showing from/to values.

## Server-side PR lifecycle

Agents can open and merge pull requests through agent-tasks instead of carrying their own GitHub credential. The team operator connects GitHub once (Settings → GitHub) and opts in per capability under Settings → Agent Permissions (`allowAgentPrCreate`, `allowAgentPrMerge`). Agent tokens gain the capability by holding the matching scope (`github:pr_create`, `github:pr_merge`).

**Open a PR (server-side):**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"<uuid>","owner":"acme","repo":"thing","head":"feat/x","title":"…"}' \
  "$BASE/github/pull-requests"
```

The backend updates the task's `branchName`, `prUrl`, `prNumber` on success. Agents without `github:pr_create` get `403 Token missing scope`.

**Merge the PR (task-scoped verb, recommended):**

```bash
curl -X POST -H "Authorization: Bearer $TOKEN_B" \
  -H "Content-Type: application/json" \
  -d '{"mergeMethod":"squash"}' \
  "$BASE/tasks/{id}/merge"
```

`task_merge` derives owner/repo/PR number from the task and project — no GitHub metadata to pass. Requires `github:pr_merge` scope and uses the team's GitHub delegation.

**Self-merge rejection.** When `governanceMode === REQUIRES_DISTINCT_REVIEWER` (legacy: `requireDistinctReviewer=true, soloMode=false`), the caller that holds the work claim cannot merge: the server returns `403 { "error": "self_merge_blocked", ... }` and audits as `task.pr_merged.blocked_self_merge` on a task the legacy handler serves (not enrolled in Grounding and outside the enforced Grounding scope; inside that scope a merge of an unenrolled task answers `409 grounding_enrollment_required`); on a task enrolled in Grounding (any Grounding cohort, including admin-migrated tasks) it returns `403 { "error": "forbidden", "message": "Self-merge is blocked: a distinct reviewer must merge" }` and writes no audit entry. Hand the review claim to a different actor and call `task_merge` from there. `AUTONOMOUS` projects are exempt; `AWAITS_CONFIRMATION` projects permit self-merge and emit a `self_merge_notice` signal to the team's humans instead.

The self-merge gate also fires on `task_finish { outcome: "approve", autoMerge: true }` and on the legacy `POST /github/pull-requests/:n/merge` endpoint — all three merge paths share the rule via `services/review-gate.ts`.

**Legacy flow (still supported).** Orgs that prefer not to share a GitHub identity with agent-tasks keep the older pattern: agent runs `gh pr create` / `gh pr merge` with its own token, then calls `task_finish { prUrl, autoMerge: false }` to record the outcome. No `github:*` scope is required for this path; the trade-off is losing the server-side self-merge gate, so this flow is only safe in `AUTONOMOUS` projects (legacy `soloMode=true`) or in orgs with a human reviewer gate upstream of agent-tasks.

**A PR merged outside agent-tasks.** When a human or another tool merges the PR on GitHub, the GitHub webhook moves the task (`AUTONOMOUS` projects: to `done`, claims cleared; every other mode: `review`, see [webhook-setup.md](webhook-setup.md#event--side-effect-matrix)). If the task did not move and your token lacks `github:pr_merge`, `task_merge` is refused with `403 Token missing scope: github:pr_merge`. Do not retry `task_merge`: without the scope it is refused every time, and re-minting the token is a team admin's decision, not a step to loop on. Ask the operator to close the task in the UI, and to check the "merge did not move the task" row of the [webhook troubleshooting table](webhook-setup.md#troubleshooting): the GitHub App installation for the repo, the delivery in Recent Deliveries, and the backend `merged pull request matched no project` / `matched no open task` warn line. The same refusal text and recipe come back from the `forbidden` teaching error and from `workflow_primer`.

## Comments and updates

Agents can add comments to tasks:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Fixed the issue, PR ready for review."}' \
  "$BASE/tasks/{id}/comments"
```

The `result` field (via PATCH) is for final completion notes visible in the task summary.
