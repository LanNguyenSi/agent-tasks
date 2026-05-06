# Sequence flows

Index of the runtime flows worth drawing. Each diagram is schematic, not exhaustive; the canonical contract lives in `backend/src/routes/` and the Swagger UI at `/docs`.

| Flow | Diagram |
|------|---------|
| GitHub OAuth + initial project sync | [`../diagrams/sequence-github-oauth-sync.mmd`](../diagrams/sequence-github-oauth-sync.mmd) |
| Agent picks up + claims a task (v2 verbs) | [`../diagrams/sequence-agent-create-claim.mmd`](../diagrams/sequence-agent-create-claim.mmd) |
| Submit for review + merge (REST vs webhook) | [`../diagrams/sequence-review-deploy.mmd`](../diagrams/sequence-review-deploy.mmd) |

## Cross-cutting invariants

- Every state-change flow emits an audit event. Callers cannot opt out.
- Every privileged action validates the actor's scope server-side. Token scope is the source of truth, not the client claim.
- Webhook handlers and sync workers are idempotent on retry. Replays of the same event do not double-write.
