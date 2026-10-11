# Sequence flows

Index of the runtime flows worth drawing. Each diagram is schematic, not exhaustive; the canonical contract lives in `backend/src/routes/` and the Swagger UI at `/docs`.

| Flow | Diagram |
|------|---------|
| GitHub OAuth login, then team repo sync | [`diagrams/sequence-github-oauth-sync.mmd`](diagrams/sequence-github-oauth-sync.mmd) |
| Agent picks up + claims a task (v2 verbs) | [`diagrams/sequence-agent-create-claim.mmd`](diagrams/sequence-agent-create-claim.mmd) |
| Submit for review, approve, merge (REST vs webhook) | [`diagrams/sequence-review-deploy.mmd`](diagrams/sequence-review-deploy.mmd) |

## Cross-cutting invariants

- Status changes through `POST /api/tasks/:id/transition` and `PATCH /api/tasks/:id` write an audit event (`task.transitioned`, or a dedicated action such as `task.backlog_promoted`). Task creation is audited only when it sends `task_available` signals (`task.created` with `event: task_available_signal`), so a task created in `backlog`, or in a team with no claim-eligible agent, leaves no creation audit row. Team repo sync writes no audit row.
- Every privileged action validates the actor's scope server-side. Token scope is the source of truth, not the client claim.
- GitHub webhook deliveries are deduplicated by delivery id: a redelivered event is skipped, so it does not double-write. Team repo sync is a synchronous request, not a background worker.

Team sync (`POST /api/teams/:id/sync`) creates or updates one project per repository visible to the syncing user and deletes the team's GitHub-bound projects, with their tasks, whose repository is not in that user's list. Run it from an account that can see every repository the team tracks.
