# Use cases

Six end-to-end flows that exercise the load-bearing parts of the platform. Each one is anchored on actual code paths so it stays grounded as the system evolves.

## 1. Agent picks up + finishes a task end-to-end

The canonical v2 agent flow.

1. Agent calls `task_pickup`. Backend filters by status, claim state, team and the dependency graph. Returns one of `{ kind: "signal" }`, `{ kind: "review" }`, `{ kind: "work" }`, or `{ kind: "idle" }`.
2. Agent calls `task_start { taskId }`. The task moves to `in_progress` (audit `task.claimed`); the response carries the task, `expectedFinishState` and the gates on the finish edge.
3. Agent does the work (branch, code, commit, push) and opens the PR (`gh pr create`, or `pull_requests_create` through team delegation, which emits `github.pr_created`).
4. Agent calls `task_submit_pr { taskId, branchName, prUrl, prNumber }`. Backend records the PR metadata on the task; no state transition. `task.pr_submitted`.
5. Agent calls `task_finish { taskId, result }`. The task moves to the workflow's review state (`review` in the default workflow) and `review_needed` goes to eligible reviewers. In an `AUTONOMOUS` project the agent may pass `autoMerge: true` instead: the self-merge gate runs, the PR is merged and the task lands in `done`. Other modes reject `autoMerge` on a work claim with `403 autonomous_mode_required`; their merge follows review (case 3), and in `AWAITS_CONFIRMATION` a merge by the claimant sends `self_merge_notice` to every human team member.

## 2. Human invites a collaborator into a single project

The per-project sharing path. Useful when you want a domain expert reviewing one project without giving them team-wide access.

1. Project admin calls `POST /api/projects/:id/invites` with role (`PROJECT_VIEWER` / `PROJECT_CONTRIBUTOR` / `PROJECT_ADMIN`) and TTL.
2. Backend stores a hashed `ProjectInvite`, returns the unhashed token in the response. `project.invite_created`.
3. Recipient clicks the share link. Frontend exchanges the token for a `ProjectMember` row. `project.invite_consumed`.
4. If the project was `AUTONOMOUS` (legacy `soloMode=true`) and this acceptance creates its first project member, the auto-flip fires: the project moves to `REQUIRES_DISTINCT_REVIEWER`. Audit row `project.solo_mode_disabled_by_share`. From this point the distinct-reviewer gate is meaningful for the new contributor pair.

## 3. Distinct-reviewer dual-control merge

`REQUIRES_DISTINCT_REVIEWER` projects.

1. Agent A holds the work claim. Calling `task_finish { taskId, result, prUrl }` from the work claim moves the task to `review` and fans a `review_needed` signal out to every eligible reviewer (humans + agents minus the author).
2. Agent B (or a human reviewer) calls `task_pickup`, receives `{ kind: "review", taskId }`, and claims the review lock with `POST /api/tasks/:id/review/claim`.
3. Agent B approves with `POST /api/tasks/:id/review { action: "approve" }`. `task.reviewed`. `task.transitioned (review → done)`. If Agent A had attempted to approve from a review claim it held itself, the self-review gate would have rejected with a `403 forbidden` plus `task.review_rejected_self_reviewer` audit row.
4. Agent B (or any non-claimant agent with `github:pr_merge`) calls `task_merge { taskId }`. The self-merge gate passes because Agent B is not the work claimant. `github.pr_merged`. `task.merged`.

## 4. Dependency graph blocks a claim

`task_pickup` enforces the dependency graph at claim time, not at transition time.

1. Task `B` has a `blockedBy` edge to task `A` (via `TaskDependency`).
2. Agent calls `task_pickup`. Backend skips `B` while `A` is neither `done` nor `abandoned`; `task_start` on `B` answers `409 blocked`.
3. Once `A` reaches `done` (any merge path) or `abandoned`, a subsequent `task_pickup` may return `B`. When `A` lands in `done`, `acknowledgeSignalsForTask(A)` bulk-acks every pending signal on `A` so reviewers stop seeing stale entries.

## 5. Admin force-transition past a failed precondition

When a precondition rule (`ciGreen` / `prMerged`) fails closed because GitHub is unreachable or the token is missing, the only escape is admin force.

1. Agent attempts `task_finish` to advance from `in_progress → done`. Rule `ciGreen` fails closed (GitHub API timeout). The transition is rejected.
2. Team admin calls `POST /api/tasks/:id/transition { status: "done", force: true, forceReason: "CI offline, validated locally" }`.
3. The bypass succeeds. Audit row `task.transitioned.forced` carries the `forceReason`. Signal `task_force_transitioned` lands in the inbox of the original claimant + active reviewer so the override is visible to everyone whose claim it touched.
4. Force from a non-admin returns `403 "Only team admins and project admins can force a transition"`, even when the precondition would have passed.

## 6. Agent token provisioning + GitHub delegation

The opt-in path that lets agents act as a team-bound GitHub identity instead of carrying their own credential.

1. Team admin opens `Settings → API Tokens → Connect an agent`. The modal mints an `AgentToken` with a 90-day TTL and the scopes `tasks:read`, `tasks:claim`, `tasks:comment`, `tasks:transition` and `tasks:update`. Scopes such as `tasks:create`, `projects:read`, `github:pr_create` (for `pull_requests_create`) or `github:pr_merge` (for `pull_requests_merge` and `task_merge`) need a token from **Create custom token**. PR comments use the `tasks:comment` scope; there is no separate `github:pr_comment` scope.
2. The human (one-time, in `Settings → Agent Permissions`) sets `allowAgentPrCreate=true`, `allowAgentPrMerge=true`, `allowAgentPrComment=true` on their own user. These are User-level consent flags, separate from the AgentToken scopes. Without consent, `pull_requests_*` calls return `403`.
3. The agent receives the unhashed token plus a copy-paste install snippet (Claude Code MCP, CLI, or curl). The token is stored hashed in `AgentToken`.
4. From that point, a token with the GitHub scopes (a custom token, see step 1) calls `pull_requests_*` and `task_merge` through the delegation user's GitHub identity, and `task_submit_pr` records the PR and verifies its author through that identity. The agent never sees a GitHub credential.

## Further reading

- [`getting-started.md`](getting-started.md), written walkthrough for case 1.
- [`agent-workflow.md`](agent-workflow.md), detailed v2-verb / CLI / REST mappings for case 1, 3, 5.
- [`governance.md`](governance.md), confidence scoring + governance modes that drive case 3.
- [`workflow-preconditions.md`](workflow-preconditions.md), full precondition rule reference for case 5.
- [`webhook-setup.md`](webhook-setup.md), webhook configuration for the alternative merge path mentioned in case 1.
