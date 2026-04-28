# ADR 0002: Grounding finish-gate (Phase 3)

## Status
Accepted

## Context
Phases 1 and 2 of the grounding-hint integration detected debug-flavored
tasks and auto-started a grounding session for them. The expectation
was that Phase 3 would close the loop: gate `task_finish` on real
evidence-ledger entries so an agent cannot silently skip the grounding
flow and ship a fix without recording its reasoning.

The original spec proposed a default-true rollout once the gate was wired
up. Implementation surfaced a deployment caveat the spec had not
considered:

- The evidence ledger is a SQLite file at `~/.evidence-ledger/db.sqlite`.
- That file lives on the local filesystem of whichever process writes or
  reads it.
- In our common deployment shape (`agent-tasks` backend on a VPS, agents
  on user laptops), the backend cannot see writes the agent makes on its
  laptop. A backend-side gate that reads the ledger would always observe
  zero entries and 409 every finish.

Defaulting the gate to true would therefore lock all debug-flavored
work out of being finished in our default deployment shape.

## Decision

1. The `Project.requireGroundingForDebug` flag defaults to **false**.
2. The gate evaluates inside `/tasks/:id/finish` (work-claim path) only
   when `metadata.debugFlavor === true && project.requireGroundingForDebug
   === true`. When either is false, the gate is bypassed.
3. The gate fails closed with HTTP 409 and a structured body listing
   which preconditions the task missed:
   - `sessionStarted`: no `metadata.groundingSessionId`.
   - `ledgerEntries`: ledger reports zero entries for the session.
   - `claimEvaluationPhase`: session has not advanced to or past the
     `claim-evaluation` phase.
4. Ledger reads degrade soft. If the SQLite file is unreadable, the
   client returns `{ entryCount: 0 }` and logs a warn. The gate then
   fails the task with `missing: ["ledgerEntries"]` so the operator
   sees a structured signal instead of a 500.
5. When `requireGroundingForDebug` is false but the task is
   debug-flavored, the route emits a `task.grounding_gate.bypassed`
   audit event so operators can retroactively spot what the gate would
   have blocked.
6. The gate logic lives in `services/gates/grounding-gate.ts` as a pure
   function. The route only owns wiring and side-effects. The phase
   helper (`getSessionPhase`) lives in `lib/debug-flavor.ts` because it
   reads the metadata blob the backend already persists, not anything
   in the wrapper's session-store.

## Consequences

- Power users in single-host setups (everything on one laptop, or
  backend + agents on the same VPS) can opt in per project via
  `PATCH /api/projects/:id { "requireGroundingForDebug": true }` and
  get the full grounding workflow enforcement.
- Multi-host users will likely keep the default (false). The gate
  becomes meaningful for them only after a follow-up that pipes ledger
  state from the agent back to the backend (e.g. an MCP verb
  `grounding_record` that mirrors entries server-side, or a per-task
  ledger artifact). That follow-up is out of scope for Phase 3.
- The `task.grounding_gate.bypassed` audit event creates a record of
  every debug-flavored finish in projects with the gate disabled. This
  is intentional: it gives operators a way to validate "would we have
  caught this with the gate on?" before flipping the flag.
- The phase allowlist (`PHASES_AT_OR_PAST_CLAIM_EVAL`) is hard-coded
  against `@lannguyensi/grounding-wrapper@0.1.0`. A wrapper version
  bump that renames or reorders phases needs the constant updated.
  A unit test pins the current contents so the next bumper sees the
  failure.

## Alternatives considered

- **Default the gate to true and tell users to disable it per-project.**
  Rejected: in our reference deployment that produces a guaranteed
  failure mode for every new debug task, with no warning, until each
  project owner finds the flag.
- **Have the gate read grounding-mcp's session-store directly.** Same
  cross-host filesystem problem; just pushes the boundary to a different
  file.
- **Require the agent to upload ledger entries via a new MCP verb.**
  This is the right long-term answer but is bigger than Phase 3. Filed
  as a follow-up.
