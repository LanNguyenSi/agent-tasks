# Sequence flows

Index of the runtime flows worth drawing. Each diagram is schematic, not exhaustive; the canonical contract lives in `backend/src/routes/` and the Swagger UI at `/docs`.

| Flow | Diagram |
|------|---------|
| GitHub OAuth login, then team repo sync | [`diagrams/sequence-github-oauth-sync.mmd`](diagrams/sequence-github-oauth-sync.mmd) |
| Agent picks up + claims a task (v2 verbs) | [`diagrams/sequence-agent-create-claim.mmd`](diagrams/sequence-agent-create-claim.mmd) |
| Submit for review, approve, merge (REST vs webhook) | [`diagrams/sequence-review-deploy.mmd`](diagrams/sequence-review-deploy.mmd) |

## Cross-cutting invariants

- Status changes through `POST /api/tasks/:id/transition` and `PATCH /api/tasks/:id` write an audit event (`task.transitioned`, or a dedicated action such as `task.backlog_promoted`). The creation audit row depends on the route. Single create (`POST /api/projects/:projectId/tasks`) and batch import (`POST /api/projects/:projectId/tasks/import`) write `task.created` with `event: task_available_signal` for each task they create in the workflow's initial state when they send `task_available` signals, so a task created in `backlog`, or in a team with no claim-eligible agent, gets no such row. Batch import also writes `task.imported` for every task it creates, backlog included. Outside the grounding creation policy, the signal row is the only creation row single create writes. On a project selected by that policy ([grounding-receipt-contract.md](grounding-receipt-contract.md#runtime-creation-policy-and-retained-history)), single create always writes `task.created` as well. A GitHub `issues.opened` webhook writes `task.created` and, when it signals, the `task_available_signal` row as well. Team repo sync writes no audit row.
- Every privileged action validates the actor's scope server-side. Token scope is the source of truth, not the client claim.
- GitHub webhook deliveries are deduplicated by delivery id: a redelivered event is skipped, so it does not double-write. Team repo sync is a synchronous request, not a background worker.

Team sync (`POST /api/teams/:id/sync`) creates or updates one project per repository visible to the syncing user and deletes the team's GitHub-bound projects, with their tasks, whose repository is not in that user's list. Repository names are compared ignoring letter case, on the lookup of the already-bound project (the exact spelling first) and on the prune, because GitHub repository names are case-insensitive, with `_` and `%` matching only themselves; an updated binding is stored back in the case GitHub reports. A repository whose write an active repository operation refuses is skipped and counted in `fenced`. When the prune itself is refused the same way (a stale binding is under an active repository operation, so the one delete is rejected as a whole), nothing is removed, the response is still 200 with `pruneDeferred: true` and `pruned: 0`, and the next sync retries it. The Projects page shows both cases as a warning ("Sync partly completed") instead of "Already up to date". Run it from an account that can see every repository the team tracks.
