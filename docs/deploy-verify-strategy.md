# Deployment and verification integration strategy

How deploy/verify fits into agent-tasks now that review/merge webhooks exist.

## Context

Dogfooding showed that real work continues after merge:
- deploy to staging/production
- verify the change works in production
- sometimes: rollback

The default workflow (`open → in_progress → review → done`) treats `done` as "code review complete, PR merged." Deploy and verify happen in reality but are invisible in the task lifecycle.

The webhook MVP (PR #50) and automation policy now give us merge events, timeline entries, and audit trails. The question is whether to extend the default workflow with deploy/verify states.

## Decision: keep deploy/verify outside the default workflow

The default workflow stays: `open → in_progress → review → done`.

Deploy and verify are modeled as **operational follow-ups**, not task workflow states. This matches ADR 0001's design: `done` means the task's modeled lifecycle is complete, not that the change is live.

### Why

1. **Not every task deploys.** Documentation, config changes, refactors — many tasks have no deployment step. Adding deploy/verify to the default workflow forces every task through states that don't apply.

2. **Deployment is an ops concern, not a task concern.** Deploy cadence, staging vs production, canary rollouts — these vary by team, project, and infrastructure. Encoding them in a generic task workflow creates false universality.

3. **The webhook MVP already provides visibility.** PR merged events appear in the Activity timeline. Teams can see when code shipped without needing a workflow state for it.

4. **Custom workflows exist for teams that need it.** Teams with formal deploy gates can define custom workflow states (`merged → staging → production → verified`) without forcing that complexity on everyone else.

## Default behavior

| Event | What happens | Task state change |
|---|---|---|
| PR merged | Timeline entry + audit log, task → `done` | Yes (`done`) |
| Deployed to staging | Not tracked by default | No |
| Deployed to production | Not tracked by default | No |
| Production verified | Not tracked by default | No |

## When to use custom workflow states

Teams should create custom workflows when:

- **Formal deploy gates exist** — e.g., approval required before production deploy
- **Compliance requires audit trail** — deploy and verify must be recorded as state transitions, not just comments
- **Multiple environments** — staging → production → verified is a real lifecycle the team manages through agent-tasks

### Example custom workflow for deploy-heavy teams

```
open → in_progress → review → merged → deployed → verified → done
```

With transitions:
- `merged`: auto-triggered by PR merge webhook
- `deployed`: triggered by deploy webhook or manual transition
- `verified`: triggered by human or monitoring integration
- `done`: triggered after verification passes

This workflow would be defined via the existing workflow engine (`POST /api/workflows`) and assigned to the project.

## Future considerations

### Deploy webhooks (not now)

When deploy tooling (GitHub Deployments API, CI/CD webhooks) becomes relevant, we can:
- Add `deployment` event handling to the webhook router
- Define automation policy entries for deploy events
- Let custom workflows react to deploy events

This requires no changes to the default workflow — it's purely additive for teams that opt in.

### First-class states (not recommended)

Adding `merged`, `deployed`, `verified` as default states would:
- Break the simplicity that makes the default workflow work for most tasks
- Create a false expectation that all tasks go through deployment
- Duplicate what the Activity timeline already shows

If demand emerges, the right path is **workflow templates** (pre-built custom workflows teams can adopt), not expanding the default.

## Summary

- Default workflow: unchanged. `done` = PR merged.
- Deploy/verify: visible via timeline, not modeled as states.
- Teams with deploy gates: use custom workflows.
- Future deploy webhooks: additive, opt-in, no default workflow changes.
