---
type: invariant
title: "Confidence scorer: authoritative backend + hand-mirrored frontend"
description: "backend/src/lib/confidence.ts is the source of truth; the frontend copy is a manually kept-in-sync mirror, enforced live in CI by a cross-package parity test over a shared fixture corpus. The claim-time gate applies the score per project enforcementMode (OFF, WARN default, BLOCK)."
tags: [confidence, scorer, invariant, keep-in-sync, claim-gate, enforcement]
timestamp: 2026-10-25T19:07:44Z
sources:
  - backend/src/lib/confidence.ts
  - frontend/src/lib/confidence.ts
  - frontend/src/lib/confidence.test.ts
  - frontend/src/lib/confidence.parity.test.ts
  - backend/src/services/confidence-gate.ts
  - backend/src/services/claim-policy-evaluator.ts
  - backend/src/lib/enforcement-mode.ts
  - backend/src/services/scopes.ts
  - backend/src/middleware/error.ts
  - backend/src/routes/projects.ts
  - backend/src/routes/tasks.ts
  - backend/prisma/schema.prisma
---

`backend/src/lib/confidence.ts` (1657 lines) is authoritative: `calculateConfidence` scores a task's `templateData`/`description` for readiness (computed at create time informationally and applied at claim time by the gate described under **Claim-time enforcement** below; `task_pickup` only surfaces candidates and runs no confidence gate). The risk-modifier write path lives in the same file: `riskModifiersSchema` is the strict, bounded validator `PATCH /projects/:id` applies to `riskModifiers` (the four `RISK_MODIFIER_NAMES` only, each an integer 0-100, the values summing to at most `MAX_RISK_MODIFIER_POINTS_SUM` = 100, unknown keys rejected with 400, `null` clears), while `resolveTriggeredRiskModifiers` stays the unchanged, degrade-safe reader of the stored `Json?` value. `frontend/src/lib/confidence.ts` (1290 lines) is a **hand-maintained port**, explicitly commented `FAITHFUL MIRROR of the backend extractSpecSections ...; keep in sync`; there is no shared package or codegen step between the two files.

**Parity mechanism**: `frontend/src/lib/confidence.parity.test.ts` is a **real cross-package CI guard**: it imports the backend scorer directly as TypeScript source (via vitest's esbuild transform, no build step needed) and the frontend scorer, runs both over the shared fixture corpus in `frontend/src/lib/__fixtures__/confidence-fixtures.ts`, and asserts `toStrictEqual` per fixture, plus a negative-control test that a perturbed result is NOT strict-equal (guards the comparison itself against going vacuously green). A backend scorer re-tune with no matching frontend edit therefore fails CI here, in the frontend job (the parity test imports backend source directly, so no build or CI ordering change is needed). `frontend/src/lib/confidence.test.ts` separately still asserts hand-copied `expected` ground truth per fixture (its own comment: "If the backend scorer is re-tuned, regenerate these via the backend harness and update here"); that hand-copied set is redundant with, not a substitute for, the parity test's live comparison.

**`extractSpecSections`** (both files, identical implementation): parses ATX markdown headings (`^#{1,6}\s+...`, column 0 only, no setext/blockquoted/indented headings) out of a task's markdown `description` into the nine string-valued `SpecField`s (the same nine fields accept either a string or a list of at most 200 strings on the write paths: `templateDataStringField` normalises a list to one `- item` line per entry with blank entries dropped, before the 50,000-character cap, so storage, scoring and the frontend mirror only ever see a string; a value that is neither gets the message "Expected a string or a list of strings"): `goal`, `acceptanceCriteria`, `scope`, `outOfScope`, `dependencies`, `risk`, `agentPrompt`, `context`, `constraints` (excludes the non-string `TemplateData` members `prefers`/`taskType`). A heading only counts if it has non-empty body text before the next heading; the first occurrence of a duplicate heading wins; headings inside fenced code blocks (`` ``` `` or `~~~`, closing marker must match opening char and be ≥ length) are ignored, and an unclosed fence swallows the rest of the description (fails closed: false-missing, never false-present).

`normalizeHeading` lower-cases, collapses whitespace, strips one trailing colon and one trailing `(...)` decorator (so `"Scope (harness, mechanical)"` still maps to `scope`, but `"Out of scope (x)"` maps to `outOfScope`, never `scope`) before an exact-match lookup against `SECTION_ALIASES`:

| Heading alias | Field |
|---|---|
| goal | `goal` |
| acceptance criteria, done when, evals, verify, verification, success criteria | `acceptanceCriteria` |
| scope | `scope` |
| out of scope, out-of-scope, non-goals, non goals, non-goal | `outOfScope` |
| dependencies, prerequisites | `dependencies` |
| risk, risks | `risk` |
| agent prompt | `agentPrompt` |
| context | `context` |
| constraints | `constraints` |

Verified byte-identical between `backend/src/lib/confidence.ts:243-264#"constraints"` and `frontend/src/lib/confidence.ts:297-318#"constraints"` as of this writing; also enforced live by the `confidence.parity.test.ts` guard above, which fails on any behavioral divergence regardless of line drift.

## Claim-time enforcement

`evaluateConfidenceGate` (`backend/src/services/confidence-gate.ts`) is the HTTP adapter; the verdict comes from the pure `ClaimPolicyEvaluator` (`backend/src/services/claim-policy-evaluator.ts`). `backend/src/routes/tasks.ts` calls the gate in two places only: the work-claim branch of `POST /tasks/:id/start` (a task in the workflow's initial state) and the deprecated `POST /tasks/:id/claim`, both after the dependency check. It gates agent actors only; a human caller passes without a score. The gate runs only on that claim edge, so a task already in progress is never re-evaluated when a project changes its mode.

**Enforcement mode**: `Project.enforcementMode` is a nullable `EnforcementMode` column (`OFF`, `WARN`, `BLOCK`). `resolveEnforcementMode` (`backend/src/lib/enforcement-mode.ts`) returns the column when it holds a known value and otherwise `DEFAULT_ENFORCEMENT_MODE`, which is `WARN`, so a project that never set the column runs in WARN.

- `OFF`: the gate returns before computing the score; nothing is audited and nothing blocks.
- `WARN`: the score is computed. A claim that would block is allowed and records a `task.claim_would_block_shadow` audit event; `force` is ignored.
- `BLOCK`: a claim that would block is refused with `422 low_confidence` (`lowConfidence` in `backend/src/middleware/error.ts`; the report sits under `details`, with `threshold` and `effectiveThreshold` set to the final threshold, `thresholdSource`, `triggeredRiskModifiers` and up to five `nextActions` derived from the findings) and records `task.claim_blocked_low_readiness`.

A clean allow in WARN or BLOCK records `task.claim_confidence_recorded` with the score and the final threshold.

**When a claim would block**: the score is below the final threshold, or the report's `blocking` flag is set. The threshold starts from `resolveEffectiveThreshold` in `backend/src/lib/confidence.ts`: `Project.taskTypeThresholds` for the task's explicit `templateData.taskType`, else `Project.confidenceThreshold`, else `GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD` (60); the layer used is reported as `thresholdSource` (`taskType`, `project`, `global`). The points of every triggered risk modifier (`resolveTriggeredRiskModifiers`, opt-in per project through `Project.riskModifiers`) are added on top, and `combineEffectiveThreshold` clamps the sum to `MAX_EFFECTIVE_THRESHOLD` (100). The `blocking` flag is the evals keystone: no acceptance criteria and no verification signal in the description. It also caps the score at `EVALS_KEYSTONE_CAP` (55), and it blocks in BLOCK mode whatever the threshold, so lowering a threshold cannot disable it. The agentPrompt keystone is a warning finding only and never sets `blocking`.

**Force override** (BLOCK only): `?force=true` without the `confidence:override` token scope answers `403 forbidden`; with the scope, a `forceReason` shorter than `MIN_FORCE_REASON_LENGTH` (10 characters, after trimming) answers `400 bad_request`; with both, a claim that would block is allowed and records `task.claim_override_used` with the reason, the token id (`actorTokenId`) and the token's user (`operatorUserId`). A token carries `confidence:override` only when it is minted with that scope (`backend/src/services/scopes.ts`).

**Switching to BLOCK**: `PATCH /projects/:id` that sets `enforcementMode` to `BLOCK` on a project whose resolved mode is not already `BLOCK` must also send `acknowledgeShadowReport: true`; otherwise it answers `400 shadow_report_unacknowledged` and writes nothing (`backend/src/routes/projects.ts`). The shadow report the message points to is the backend script `npm run shadow:report`.

Related: `backend.md`, `frontend.md`, `claim-model.md`.
