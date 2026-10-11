# Deployment and verification integration strategy

How deploy/verify fits into agent-tasks now that review/merge webhooks exist.

## Context

Dogfooding showed that real work continues after merge:
- deploy to staging/production
- verify the change works in production
- sometimes: rollback

The default workflow (`open → in_progress → review → done`) treats `done` as "review approved or PR merged." Deploy and verify happen in reality but are invisible in the task lifecycle.

The webhook MVP (PR #50) and automation policy now give us merge events, timeline entries, and audit trails. The question is whether to extend the default workflow with deploy/verify states.

## Decision: keep deploy/verify outside the default workflow

The default workflow stays: `open → in_progress → review → done`.

Deploy and verify are modeled as **operational follow-ups**, not task workflow states. This matches ADR 0014's design: `done` means the task's modeled lifecycle is complete, not that the change is live.

### Why

1. **Not every task deploys.** Documentation, config changes, refactors — many tasks have no deployment step. Adding deploy/verify to the default workflow forces every task through states that don't apply.

2. **Deployment is an ops concern, not a task concern.** Deploy cadence, staging vs production, canary rollouts — these vary by team, project, and infrastructure. Encoding them in a generic task workflow creates false universality.

3. **The webhook MVP already provides visibility.** PR merged events appear in the Activity timeline. Teams can see when code shipped without needing a workflow state for it.

4. **The workflow state set is fixed.** The built-in default and every workflow created or updated through the workflow API have exactly the states `open`, `in_progress`, `review` and `done` (`FIXED_STATE_NAMES` in `backend/src/routes/workflows.ts`). A custom workflow can change transitions, `requires` gates, `requiredRole`, state labels and `agentInstructions`, but it cannot add a `merged`, `deployed` or `verified` state.

## Default behavior

| Event | What happens | Task state change |
|---|---|---|
| PR merged | Timeline entry + audit log. `task_merge` / `pull_requests_merge`: `done`. Merge on GitHub (webhook): `AUTONOMOUS` to `done`; other modes move an `open` or `in_progress` task to `review` and leave a task in `review` unchanged | Yes |
| Deployed to staging | Not tracked by default | No |
| Deployed to production | Not tracked by default | No |
| Production verified | Not tracked by default | No |

## Tracking deploy and verify today

`POST /api/projects/:projectId/workflows` and `PUT /api/workflows/:id` reject any state name outside `open`, `in_progress`, `review` and `done` ("Add/rename/remove of states is not supported"), and a definition that leaves one of them out. `POST /api/projects/:projectId/workflow/customize` (which forks the four-state default) and `POST /api/projects/:projectId/workflow/apply-template/:slug` (every registered template uses the same four states) take no definition, so they cannot produce any other state set. A workflow such as `open → in_progress → review → merged → deployed → verified → done` cannot be created.

Teams that need a record of deploy and verify steps track them outside the task status:

- **Timeline and comments**: a comment on the task when a deploy or a verification happens.
- **Labels**: for example a `deployed` or `verified` label on the task.
- **Follow-up tasks**: a separate task for the deploy or the verification, which can carry its own review.

A custom workflow can still tighten the path to `done` within the fixed states, for example by requiring `prMerged` on every edge into `done` (the `branch-pr-merge-gated` template does this, see [workflow-preconditions.md](workflow-preconditions.md#workflow-templates)).

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

A workflow template cannot add them either: templates vary transitions and gates within the fixed state set (`backend/src/services/workflow-templates.ts`).

## Summary

- Default workflow: unchanged. `done` = review approved, or the PR merged via `task_merge` / `pull_requests_merge` (or a GitHub merge in `AUTONOMOUS`). The default workflow also keeps an `in_progress → done` edge that requires a branch and a PR.
- Deploy/verify: visible via timeline, not modeled as states.
- Teams with deploy gates: track deploy and verify with comments, labels or follow-up tasks; the workflow state set is fixed.
- Future deploy webhooks: additive, opt-in, no default workflow changes.
