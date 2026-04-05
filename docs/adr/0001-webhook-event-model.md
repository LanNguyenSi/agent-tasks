# ADR 0001 — Webhook event model and source-of-truth boundaries

## Status
Accepted

## Context
Dogfooding exposed repeated ambiguity between:
- PR-ready vs review-ready
- review-complete vs merge-complete
- merged vs deployed vs verified
- GitHub reality vs task workflow reality

We need a clear boundary between external systems (starting with GitHub) and agent-tasks itself.

## Decision
agent-tasks will treat **GitHub as the source of truth for PR/review/merge reality**, while **agent-tasks remains the source of truth for task workflow state, audit trail, and visible lifecycle**.

Default policy remains conservative:
- `review` means **code review only**
- `merge`, `deploy`, and `verify` remain **operational follow-up events** in the default model
- webhook events may annotate, audit, and sometimes transition tasks, but only according to explicit automation policy

## Source-of-truth boundaries
### GitHub is authoritative for
- PR existence
- PR review decisions
- PR merge state
- PR close-without-merge state

### agent-tasks is authoritative for
- task status shown in the product
- task comments / timeline / audit history
- mapping of external events into workflow consequences
- policy about whether an external event may transition task state

## Event categories
### Workflow events
External events that may change task workflow state if policy allows it.
Examples:
- review approved
- changes requested

### Operational follow-up events
External events that reflect real-world progress but do not automatically introduce new default workflow states.
Examples:
- PR merged
- deployed
- production verified

### Notification-only events
Events that should be visible/audited but normally do not change task state.
Examples:
- PR opened
- PR synchronized

## Default workflow interpretation
Default model stays simple:
- `open`
- `in_progress`
- `review`
- `done`

In this model:
- `review` = code review only
- `done` means the task’s modeled workflow is complete
- merge/deploy/verify may still happen in reality, but remain external follow-up steps unless a custom workflow models them explicitly

## Webhook design principles
1. **No hidden state machine expansion**
   - webhooks must not implicitly invent workflow states that the product does not model
2. **Policy before automation**
   - event ingestion should not decide business behavior on its own
3. **Audit everything important**
   - all accepted webhook events should leave an auditable trace
4. **Idempotent processing**
   - duplicate deliveries must not corrupt task state or create duplicate effects
5. **Prefer robust binding over fuzzy inference**
   - structured fields first, text parsing only as fallback

## PR ↔ task binding policy
Preferred match order:
1. `prNumber`
2. `prUrl`
3. repo identity + branch (if available later)
4. title pattern only as legacy fallback

## MVP event scope
Phase 1 webhook coverage:
- `pull_request_review`
- `pull_request.closed`

Later candidates:
- `pull_request.opened`
- `pull_request.synchronize`

## Side-effect posture
Webhook side effects may include:
- add comment / timeline entry
- write audit event
- update task metadata
- transition task status only if explicitly allowed by automation policy

Webhook handlers should not directly encode product policy ad hoc; they should consume a defined policy matrix.

## Failure and reliability posture
- webhook handling must be replay-safe / idempotent
- repeated GitHub deliveries must not duplicate comments or oscillate task state
- failures must be observable in logs/audit
- ignored events should be explicitly ignored, not silently half-processed

## Consequences
1. Review automation policy should define exactly which webhook events may transition task status
2. GitHub webhook MVP should implement only the agreed event subset
3. PR binding hardening should make structured binding first-class
4. Timeline UI should surface webhook-originated lifecycle events
5. Deploy/verify strategy remains a later design question, not required for first webhook release
