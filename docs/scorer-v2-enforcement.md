# scorer-v2 enforcement and rollout

The confidence gate (ADR-0011) blocks low-readiness agent claims. scorer-v2 made
the score measure weak-agent executability and added the evals keystone, which
lowers nearly every existing task's score. To roll that out without a surprise
mass-block, enforcement is now a per-project mode.

## enforcementMode

`Project.enforcementMode` has three values. It is nullable; `null` resolves to
`WARN` via `resolveEnforcementMode()`, so every existing project starts in
warn-mode without a backfill.

| Mode    | Behaviour at the open to in_progress claim edge (agents only)                          |
| ------- | ------------------------------------------------------------------------------------- |
| `OFF`   | Advisory. The score is still surfaced, but a claim is never blocked.                   |
| `WARN`  | Compute the score; if it would block, emit a `task.claim_would_block_shadow` audit and allow the claim. The rollout default. |
| `BLOCK` | Block (422) when the score is below the project threshold OR a keystone is violated.   |

"Would block" means `score < confidenceThreshold` OR the evals keystone is
violated (`ConfidenceResult.blocking`). The keystone clause is threshold
independent: lowering a project's threshold cannot silently disable it.

Humans are never gated. The gate fires only on the claim edge, so a task already
in progress is never re-evaluated when a project flips to `BLOCK` (grandfathered).

## The shadow report

Warn-mode is the only calibration signal (there is no seed corpus). Two sources:

1. Runtime: every real warn-mode would-block writes a `task.claim_would_block_shadow`
   audit event carrying `score`, `threshold`, `keystoneBlocked`, and `caps`.
2. Offline: `npm run shadow:report` computes the v2 score for every open task and
   prints, per project, the would-block count, the keystone count, the score
   range, and a histogram of which caps fired. It writes nothing.

```sh
npm run shadow:report                      # all projects
npm run shadow:report -- --project agent-tasks
npm run shadow:report -- --json
```

Use the cap histogram to tune `FIELD_WEIGHTS` and `EVALS_KEYSTONE_CAP` in
`backend/src/lib/confidence.ts` (they are documented as calibration targets).

## Flipping a project to BLOCK

`BLOCK` is gated on an explicit acknowledgement that the shadow report was
reviewed. The PATCH rejects a flip to `BLOCK` unless `acknowledgeShadowReport`
is `true`:

```sh
# 1. Review the blast radius.
npm run shadow:report -- --project <slug>

# 2. Flip, acknowledging the review (admin only; agents cannot PATCH projects).
PATCH /api/projects/:id
{ "enforcementMode": "BLOCK", "acknowledgeShadowReport": true }
```

Without the acknowledgement the PATCH returns `400 shadow_report_unacknowledged`.
The flip is recorded in the project's governance audit. `acknowledgeShadowReport`
is a request-only flag and is never stored.

## Sequencing

Deploy scorer-v2 with warn-mode everywhere first. Watch the shadow signal per
project, tune the calibration numbers, and flip individual projects to `BLOCK`
only after their report looks right. The default project threshold stays 60.
