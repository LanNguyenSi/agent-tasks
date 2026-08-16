// Shared confidence-scorer test corpus (task 79621590).
//
// backend/src/lib/confidence.ts is the authoritative confidence scorer;
// frontend/src/lib/confidence.ts is a hand-maintained mirror kept in sync
// only by convention. This module is the ONE place fixture inputs used to
// exercise both copies are declared, so a backend-only or frontend-only
// edit to a duplicated literal cannot silently desync the two suites — the
// exact drift this file exists to prevent. It has no dependency on either
// package (or on zod): plain data plus a small structural type, so
// importing it never pulls backend/frontend runtime code anywhere.
//
// Consumed by:
//  - frontend/src/lib/confidence.parity.test.ts (the real cross-package
//    guard: runs BOTH scorers over this corpus and diffs the results)
//  - backend/tests/unit/confidence.test.ts and
//    frontend/src/lib/confidence.test.ts (the two existing hand-asserted
//    suites reuse RICH_TEMPLATE_DATA_NO_DESC / SECTIONED_DESC from here
//    instead of each keeping its own byte-identical copy)

export type ConfidenceFixtureTaskType =
  | "bugfix"
  | "feature"
  | "refactoring"
  | "security"
  | "migration"
  | "docs";

export interface ConfidenceFixtureTemplateData {
  goal?: string;
  acceptanceCriteria?: string;
  context?: string;
  constraints?: string;
  scope?: string;
  outOfScope?: string;
  dependencies?: string;
  risk?: string;
  agentPrompt?: string;
  taskType?: ConfidenceFixtureTaskType;
}

export interface ConfidenceFixtureTemplateFields {
  goal?: boolean;
  acceptanceCriteria?: boolean;
  context?: boolean;
  constraints?: boolean;
  scope?: boolean;
  outOfScope?: boolean;
  dependencies?: boolean;
  risk?: boolean;
  agentPrompt?: boolean;
}

export interface ConfidenceFixtureInput {
  title: string;
  description: string | null;
  templateData: ConfidenceFixtureTemplateData | null;
  templateFields?: ConfidenceFixtureTemplateFields | null;
}

export interface ConfidenceFixture {
  name: string;
  input: ConfidenceFixtureInput;
}

// Modeled on the real task c71de504's create: substantial goal + context with
// concrete measurements and file:line anchors, plus scope/acceptanceCriteria/
// agentPrompt, but NO literal `description` — the shape that used to score
// 40/100 and block on missing_or_thin_description until an agent duplicated
// goal+context verbatim into description via task_respec.
export const RICH_TEMPLATE_DATA_NO_DESC: ConfidenceFixtureTemplateData = {
  goal: "Apply the same description-quality heuristic to templateData.goal + templateData.context so rich structured tasks are not forced to duplicate that text into description.",
  context: "Measured on real tasks: c71de504 scored 40/100 and went to 83 after copying goal+context into description; d58b3409 went 40->75 the same way. The structure check only reads backend/src/lib/confidence.ts:526 (missing_or_thin_description) and the cap at backend/src/lib/confidence.ts:643.",
  scope: "backend/src/lib/confidence.ts and frontend/src/lib/confidence.ts, the missing_or_thin_description path only",
  acceptanceCriteria: "- A repro shaped like c71de504's create no longer triggers missing_or_thin_description\n- A negative control with all-empty templateData still triggers it",
  agentPrompt: "1. Read both confidence.ts copies. 2. Feed description + templateData.goal + templateData.context through the existing quality check. 3. Update both test files.",
};

// Fully specced v2 create: all seven scored sections as `##` headings with
// real bodies, templateData null (friction-log 57-99 / markdown spec
// sections).
export const SECTIONED_DESC = [
  "## Goal",
  "",
  "The `signup` handler in src/routes/auth.ts returns 400 on an empty body.",
  "",
  "## Context",
  "",
  "Posting an empty body 500s today; see incident 4711.",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] POST /api/signup with `{}` returns 400",
  "- [ ] A unit test covers the empty-body branch and CI is green",
  "",
  "## Scope",
  "",
  "- src/routes/auth.ts signup handler only",
  "",
  "## Out of scope",
  "",
  "- Session middleware stays untouched",
  "",
  "## Dependencies",
  "",
  "none",
  "",
  "## Risk",
  "",
  "low: single handler, no migration",
  "",
  "## Agent Prompt",
  "",
  "1. Add a zod body schema.",
  "2. Return 400 on parse failure.",
  "3. Add a unit test.",
].join("\n");

/**
 * Parity corpus: at least the 8 fixture shapes ported from the frontend
 * suite's original FIXTURES array (9, after the rich-templatedata-no-desc
 * MEDIUM fix folded a 9th in) plus the fully sectioned SECTIONED_DESC case.
 * Inputs only — no "expected" values live here. The parity test computes
 * the expected result by actually running the backend scorer, not by a
 * hand-maintained snapshot, so this corpus cannot go stale the way a
 * hard-coded ground-truth table can.
 */
export const CONFIDENCE_PARITY_FIXTURES: ConfidenceFixture[] = [
  {
    name: "empty",
    input: { title: "", description: null, templateData: null, templateFields: null },
  },
  {
    name: "title-only-no-desc",
    input: {
      title: "Add exponential backoff to the GitHub webhook retry",
      description: null,
      templateData: null,
      templateFields: null,
    },
  },
  {
    name: "rich-prose-no-verification",
    input: {
      title: "Sync the frontend confidence scorer",
      description:
        "## Context\nThe dashboard board badge shows a stale number because the client scorer in `frontend/src/lib/confidence.ts` diverged from the backend prose-first scorer.\n\n## Goal\nMirror the 9 prose-first weights so the badge a human sees matches what the gate computes for the 75-task corpus.",
      templateData: null,
      templateFields: null,
    },
  },
  {
    name: "rich-prose-with-verification",
    input: {
      title: "Sync the frontend confidence scorer",
      description:
        "## Context\nThe dashboard board badge shows a stale number because the client scorer in `frontend/src/lib/confidence.ts` diverged from the backend prose-first scorer.\n\n## Goal\nMirror the 9 prose-first weights so the badge matches the gate.\n\n## Verify\nVerify by running `npm test` and confirm the parity suite is green.",
      templateData: null,
      templateFields: null,
    },
  },
  {
    name: "full-strong-with-ac",
    input: {
      title: "Sync the frontend confidence scorer to scorer-v2",
      description:
        "## Context\nThe client scorer in `frontend/src/lib/confidence.ts` diverged from the backend after the prose-first calibration.\n\n## Goal\nPort the fixed-denominator weights and the keystone cap so badges match the gate for all 75 tasks.",
      templateData: {
        goal: "Badges show the same score the gate computes.",
        acceptanceCriteria: "- A parity test asserts 8 fixtures match the backend\n- next build passes",
        scope: "frontend/src/lib/confidence.ts and its 3 call-sites",
        constraints: "Do not change the backend weights; mirror them only.",
        risk: "Medium: visible badge numbers change.",
        dependencies: "none",
      },
      templateFields: null,
    },
  },
  {
    name: "vague-no-anchors",
    input: {
      title: "Make it better",
      description: "We should fix and improve and optimize the thing somehow, quickly.",
      templateData: null,
      templateFields: null,
    },
  },
  {
    name: "template-fields-completeness",
    input: {
      title: "Wire the dependency graph into the scorer",
      description:
        "## Context\nThe scorer treats `dependencies` as satisfied by any prose. Tie it to the real dependsOn[] edges in `backend/src/routes/tasks.ts`.\n\n## Goal\nThe scorer reads the edge set so 'none' is distinct from an actual prerequisite.",
      templateData: null,
      templateFields: { goal: true, acceptanceCriteria: true, context: true, constraints: true },
    },
  },
  {
    name: "typed-feature-with-ac",
    input: {
      title: "Render create-time confidence on the dashboard",
      description:
        "## Goal\nSurface the server `confidence` object after a create in `frontend/src/app/dashboard/page.tsx`.\n\n## Verify\nRun the e2e and check the panel shows score, missing, and nextActions.",
      templateData: {
        acceptanceCriteria: "- createTask exposes { task, confidence }\n- the panel renders nextActions",
        taskType: "feature",
        agentPrompt: "1. Widen createTask. 2. Render the panel. 3. Run next build.",
      },
      templateFields: null,
    },
  },
  {
    name: "rich-templatedata-no-desc-c71de504",
    input: {
      title: "Fix confidence scorer templateData description-equivalence",
      description: "",
      templateData: RICH_TEMPLATE_DATA_NO_DESC,
      templateFields: null,
    },
  },
  {
    name: "sectioned-desc",
    input: {
      title: "Return 400 on empty signup body",
      description: SECTIONED_DESC,
      templateData: null,
      templateFields: null,
    },
  },
];
