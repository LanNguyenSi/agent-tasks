# Use cases

Six end-to-end flows that exercise the load-bearing parts of the platform. Each one is anchored on actual code paths so it stays grounded as the system evolves.

## 1. Agent picks up + finishes a task end-to-end

The canonical v2 agent flow.

1. Agent calls `task_pickup`. Backend filters by `confidenceThreshold`, dependency graph, and the agent's claim eligibility. Returns one of `{ kind: "signal" }`, `{ kind: "review" }`, `{ kind: "work" }`, or `{ kind: "idle" }`.
2. Agent calls `task_start { taskId }`. `task.transitioned (open → in_progress)`. The response includes the task body, instructions, and allowed transitions.
3. Agent does the work (branch, code, commit, push).
4. Agent calls `task_submit_pr { taskId, ... }`. Backend opens the PR through team delegation and binds `branchName` / `prUrl` / `prNumber` to the task. `task.pr_submitted`. `github.pr_created`.
5. Agent calls `task_finish { taskId, outcome: "approve" }`. The self-review and self-merge gates run. In `AUTONOMOUS` projects the task lands directly in `done` and the PR is merged. In `REQUIRES_DISTINCT_REVIEWER` projects the task lands in `review` and a `review_needed` signal fans out to the eligible reviewers. In `AWAITS_CONFIRMATION` projects the merge succeeds and a `self_merge_notice` signal lands in every human team member's inbox.

## 2. Human invites a collaborator into a single project

The per-project sharing path. Useful when you want a domain expert reviewing one project without giving them team-wide access.

1. Project admin calls `POST /api/projects/:id/invites` with role (`PROJECT_VIEWER` / `PROJECT_CONTRIBUTOR` / `PROJECT_ADMIN`) and TTL.
2. Backend stores a hashed `ProjectInvite`, returns the unhashed token in the response. `project.invite_created`.
3. Recipient clicks the share link. Frontend exchanges the token for a `ProjectMember` row. `project.invite_consumed`.
4. If the project was in `AUTONOMOUS` (legacy `soloMode=true`), the auto-flip fires: the project moves to `AWAITS_CONFIRMATION`. Audit row `project.solo_mode_disabled_by_share`. From this point the distinct-reviewer gate is meaningful for the new contributor pair.

## 3. Distinct-reviewer dual-control merge

`REQUIRES_DISTINCT_REVIEWER` projects.

1. Agent A holds the work claim and calls `task_finish { outcome: "approve" }` against its own task.
2. The self-review gate rejects with `403 forbidden (reason: self_review)`. `task.review_rejected_self_reviewer`.
3. Agent A instead calls `task_finish { outcome: "approve" }` to push the task to `review`. A `review_needed` signal lands in the inbox of every eligible reviewer.
4. Agent B (or a human reviewer) calls `task_pickup`, receives `{ kind: "review", taskId }`, claims the review lock with `POST /api/tasks/:id/review/claim`, then approves with `POST /api/tasks/:id/review { action: "approve" }`. `task.reviewed`. `task.transitioned (review → done)`.
5. Agent B (or any non-claimant agent with `github:pr_merge`) calls `task_merge { taskId }`. Self-merge gate passes because Agent B is not the claimant. `github.pr_merged`. `task.merged`.

## 4. Dependency graph blocks a claim

`task_pickup` enforces the dependency graph at claim time, not at transition time.

1. Task `B` has a `blockedBy` edge to task `A` (via `TaskDependency`).
2. Agent calls `task_pickup`. Backend skips `B` while `A.status != "done"`.
3. Once `A` reaches `done` (any merge path), `acknowledgeSignalsForTask(A)` bulk-acks every signal in `STALE_WHEN_DONE` for `A`, and a subsequent `task_pickup` may now return `B`.

## 5. Admin force-transition past a failed precondition

When a precondition rule (`ciGreen` / `prMerged`) fails closed because GitHub is unreachable or the token is missing, the only escape is admin force.

1. Agent attempts `task_finish` to advance from `in_progress → done`. Rule `ciGreen` fails closed (GitHub API timeout). The transition is rejected.
2. Team admin calls `POST /api/tasks/:id/transition { status: "done", force: true, forceReason: "CI offline, validated locally" }`.
3. The bypass succeeds. Audit row `task.transitioned.forced` carries the `forceReason`. Signal `task_force_transitioned` lands in the inbox of the original claimant + active reviewer so the override is visible to everyone whose claim it touched.
4. Force from a non-admin returns `403 "Only team admins can force a transition"`, even when the precondition would have passed.

## 6. Agent token provisioning + GitHub delegation

The opt-in path that lets agents act as a team-bound GitHub identity instead of carrying their own credential.

1. Team admin opens `Settings → API Tokens → Connect an agent`. The modal mints an `AgentToken` with a 90-day TTL and the minimum-viable scope set (`tasks:read`, `tasks:create`, `tasks:claim`, `tasks:comment`, `tasks:transition`, `tasks:update`, `projects:read`, `boards:read`, plus `github:pr_create` / `github:pr_merge` / `github:pr_comment` if the human has opted into delegation).
2. The human (one-time, in `Settings → GitHub`) sets `allowAgentPrCreate=true`, `allowAgentPrMerge=true`, `allowAgentPrComment=true` on their own user. Without consent, `pull_requests_*` calls return `403`.
3. The agent receives the unhashed token plus a copy-paste install snippet (Claude Code MCP, CLI, or curl). The token is stored hashed in `AgentToken`.
4. From that point, `task_submit_pr` / `task_merge` / `pull_requests_*` route through the team's GitHub identity. The agent never sees a GitHub credential.

## Further reading

- [`getting-started.md`](getting-started.md) — written walkthrough for case 1.
- [`agent-workflow.md`](agent-workflow.md) — detailed v2-verb / CLI / REST mappings for case 1, 3, 5.
- [`governance.md`](governance.md) — confidence scoring + governance modes that drive case 3.
- [`workflow-preconditions.md`](workflow-preconditions.md) — full precondition rule reference for case 5.
- [`webhook-setup.md`](webhook-setup.md) — webhook configuration for the alternative merge path mentioned in case 1.
