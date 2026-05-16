# ADR 0011: Split confidence scoring into Task Quality Analysis and Claim Policy Evaluation

## Status
Proposed

## Context

`backend/src/lib/confidence.ts` currently does two unrelated jobs in one
function:

1. It *measures* the description of a task and produces a numeric score
   plus a `missing[]` array.
2. It is the de-facto *gate decision*: every call site (`/tasks/:id/start`
   at backend/src/routes/tasks.ts:1063, the legacy `/claim` route at
   line 3383, and the read-only `tasks_instructions` MCP verb at line
   2711) inlines `score < project.confidenceThreshold` and refuses the
   claim when the comparison is true.

The two concerns drift together but answer different questions:

- *Quality analysis* answers "how good is this task description for
  agent execution, and what is missing?"
- *Claim policy* answers "may this actor claim this task right now,
  given the project's rules?"

Today the policy answer is a single inline `<` comparison against a
single project-wide integer. There is no way to:

- Show an agent or user *why* a task was rejected beyond a flat
  `missing[]` list.
- Express different thresholds for different task types or risk levels.
- Audit blocked claims, overrides, or threshold changes.
- Add subscores (completeness, testability, etc.) without changing every
  call site that reads the headline number.

There is also no test file for `confidence.ts`, so any refactor that
touches the function risks silent regressions across three production
routes.

The
`agent-tasks-confidence-scoring-target-overlay.md`
design doc proposes splitting these two jobs into named components.
This ADR is the contract that the four Milestone 1 follow-up tasks
(subscores, score caps, structured 422, test coverage) build against.

## Decision

We split confidence scoring into two collaborating components:

1. **`TaskQualityAnalyzer`** measures a task and returns a structured
   `TaskQualityReport`. It does not know about claim policy, actors, or
   thresholds.
2. **`ClaimPolicyEvaluator`** takes a `TaskQualityReport` plus the
   project's policy and the calling actor, and returns a `ClaimDecision`.
   It does not know how the score was computed.

The route layer becomes a thin adapter that calls the analyzer, hands
the report to the evaluator, and turns the resulting decision into an
HTTP response and an audit event.

### Domain types

These are the target shapes. The Milestone 1 follow-up tasks may add
fields, but the type names and responsibility split are fixed by this
ADR.

```ts
type QualityDimension =
  | "completeness"
  | "concreteness"
  | "testability"
  | "scopeClarity"
  | "contextQuality"
  | "structure"
  | "ambiguityRisk";

type QualityFinding = {
  code: string;
  severity: "info" | "warning" | "blocking";
  dimension: QualityDimension;
  message: string;
  suggestion?: string;
};

type ClaimReadinessScore = number; // 0..100, the headline score

type TaskQualityReport = {
  score: ClaimReadinessScore;
  subscores: Record<QualityDimension, number>;
  missing: QualityFinding[];
  warnings: QualityFinding[];
  strengths: QualityFinding[];
};

interface TaskQualityAnalyzer {
  analyze(task: {
    title: string;
    description: string | null;
    templateData: TemplateData | null;
    templateFields?: TemplateFields | null;
  }): TaskQualityReport;
}

type ClaimDecision =
  | { status: "allowed" }
  | {
      status: "blocked_low_readiness";
      reason: string;
      findings: QualityFinding[];
      nextActions: string[];
    }
  | {
      status: "blocked_policy";
      reason: string;
      findings: QualityFinding[];
      nextActions: string[];
    };

interface ClaimPolicyEvaluator {
  evaluate(input: {
    task: { id: string; metadata: Record<string, unknown> };
    report: TaskQualityReport;
    projectPolicy: { confidenceThreshold: number };
    actor: { kind: "user" | "agent"; id: string };
  }): ClaimDecision;
}
```

### Audit events

The evaluator and the route layer between them emit these new audit
events. Names are fixed by this ADR; payload shapes are owned by the
follow-up implementation task:

- `claim_blocked_low_readiness` (evaluator returned blocked, score
  below threshold)
- `claim_override_used` (an override allowed a claim the evaluator
  would have blocked)
- `confidence_threshold_changed` (project policy updated)
- `task_quality_recomputed` (analyzer ran and the score changed)

### Backwards compatibility

This ADR is **additive**. The existing 422 response shape

```json
{ "score": 42, "missing": ["acceptanceCriteria"], "threshold": 60 }
```

stays valid for one release cycle. The structured response from the
Milestone 1 follow-up task (`180e5655`) adds `findings[]` and
`nextActions[]` alongside the existing fields rather than replacing
them. The headline `score` remains a single 0..100 integer so existing
UI and CLI code keeps working.

### Responsibilities matrix

| Component | Responsibility |
|---|---|
| `TaskQualityAnalyzer` | Measure description quality, produce score, subscores, findings. No policy knowledge. |
| `TaskQualityReport` | Structured measurement result, free of decisions. |
| `ClaimPolicyEvaluator` | Apply project threshold and actor rules. No knowledge of how the score was computed. |
| `ClaimDecision` | Final allow / block result with reason and next actions. |
| `TaskTemplateRegistry` | Source of required fields per task type (already exists). |
| `QualityFindingRegistry` | Standardised finding codes and messages (new). |
| `AuditLogger` | Records `claim_blocked_low_readiness`, `claim_override_used`, `confidence_threshold_changed`, `task_quality_recomputed`. |

## Non-Goals

Verbatim from `agent-tasks-confidence-scoring-target-overlay.md`,
section "Non-Goals" (lines 858 to 868):

To keep the feature trustworthy, these should explicitly be non-goals
for the hard gate:

- LLM decides claimability
- Score based primarily on character count
- Score hidden from users
- Agent can bypass without audit
- One global threshold for all task types forever
- "Good prompt" replaces enforceable workflow rules
- The system tries to judge whether the implementation is correct before work starts

## Consequences

- Every Milestone 1 follow-up task lands behind this contract. The
  analyzer / evaluator split is what makes "add subscores" (`527310ef`),
  "add score caps" (`ed3331b8`), "structured 422 + audit events"
  (`180e5655`), and "close the zero-coverage gap" (`3f8b87e2`)
  reviewable in isolation.
- Three route call sites
  (`/tasks/:id/start`, legacy `/claim`, `tasks_instructions`) will
  switch from inline `<` comparison to calling the evaluator. The
  switch is mechanical once the evaluator exists.
- New audit events show up in any operator-facing log surface. Until
  the events have consumers, they are write-only.
- Task-type-aware thresholds (Milestone 2) and risk-modifier scoring
  (Milestone 3) become a change to `ClaimPolicyEvaluator` without
  touching the analyzer or the route adapters.
- The existing 422 shape staying valid for one release cycle means
  callers that parse `score`, `missing[]`, `threshold` keep working;
  the next major release can drop the legacy fields if telemetry shows
  no remaining consumers.
- This ADR does not, by itself, change behaviour. Until the follow-up
  tasks ship, `confidence.ts` keeps doing both jobs and the routes
  keep inlining the comparison.

## Alternatives considered

- **Keep one function, add subscores as an optional return field.**
  Rejected: leaves the gate-decision logic inlined in three routes, so
  the next change to policy rules still has to be made in three places
  and stays untestable in isolation.
- **Put the evaluator inside the analyzer (`analyze()` returns a
  decision).** Rejected: collapses the split this ADR exists to make,
  and re-creates the current problem under a different name.
- **Replace the heuristic score with an LLM call.** Rejected explicitly
  under Non-Goals. The hard gate must be deterministic and auditable.
