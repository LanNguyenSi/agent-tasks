---
type: invariant
title: "Confidence scorer: authoritative backend + hand-mirrored frontend"
description: "backend/src/lib/confidence.ts is the source of truth; the frontend copy is a manually kept-in-sync mirror, now enforced live in CI by a cross-package parity test over a shared fixture corpus."
tags: [confidence, scorer, invariant, keep-in-sync]
timestamp: 2026-09-02T04:50:50Z
sources:
  - backend/src/lib/confidence.ts
  - frontend/src/lib/confidence.ts
  - frontend/src/lib/confidence.test.ts
  - frontend/src/lib/confidence.parity.test.ts
---

`backend/src/lib/confidence.ts` (1578 lines, up from 869 as of M2/M3's per-task-type thresholds and risk modifiers, `#462`/`#463`/`#465`/`#471`) is authoritative: `calculateConfidence` scores a task's `templateData`/`description` for readiness (used at create-time informationally and enforced at `task_start` and the classic `/tasks/:id/claim` route via `evaluateConfidenceGate`, see `backend/src/services/confidence-gate.ts`; `task_pickup` only surfaces candidates and runs no confidence gate). `frontend/src/lib/confidence.ts` (1290 lines, up from 692 as of the same M2/M3 work plus the M4 Improvement panel `#470` and the `#494` keystone-blocking warning helper) is a **hand-maintained port**, explicitly commented `FAITHFUL MIRROR of the backend extractSpecSections ...; keep in sync`, there is no shared package or codegen step between the two files.

**Parity mechanism**: as of `#450`/task `79621590`, `frontend/src/lib/confidence.parity.test.ts` is a **real cross-package CI guard**: it imports the backend scorer directly as TypeScript source (via vitest's esbuild transform, no build step needed) and the frontend scorer, runs both over the shared fixture corpus in `frontend/src/lib/__fixtures__/confidence-fixtures.ts`, and asserts `toStrictEqual` per fixture, plus a negative-control test that a perturbed result is NOT strict-equal (guards the comparison itself against going vacuously green). This closes the previously-documented drift risk: a backend scorer re-tune with no matching frontend edit now fails CI here, in the frontend job (the parity test imports backend source directly, so a build/lint/CI ordering change was not needed). `frontend/src/lib/confidence.test.ts` separately still asserts hand-copied `expected` ground truth per fixture (its own comment: "if the backend scorer weights are ever re-tuned, regenerate these via the backend harness and update here") — that hand-copied set is redundant with, not a substitute for, the parity test's live comparison.

**`extractSpecSections`** (both files, identical implementation): parses ATX markdown headings (`^#{1,6}\s+...`, column 0 only, no setext/blockquoted/indented headings) out of a task's markdown `description` into the nine string-valued `SpecField`s: `goal`, `acceptanceCriteria`, `scope`, `outOfScope`, `dependencies`, `risk`, `agentPrompt`, `context`, `constraints` (excludes the non-string `TemplateData` members `prefers`/`taskType`). A heading only counts if it has non-empty body text before the next heading; the first occurrence of a duplicate heading wins; headings inside fenced code blocks (`` ``` `` or `~~~`, closing marker must match opening char and be ≥ length) are ignored, and an unclosed fence swallows the rest of the description (fails closed: false-missing, never false-present).

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

Verified byte-identical between `backend/src/lib/confidence.ts` (lines 198-219) and `frontend/src/lib/confidence.ts` (lines 246-267) as of this writing; also enforced live by the `confidence.parity.test.ts` guard above, which fails on any behavioral divergence regardless of line drift.

Related: `backend.md`, `frontend.md`.
