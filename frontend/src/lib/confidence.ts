// ── scorer-v2 client mirror ─────────────────────────────────────────────────
// This is a FAITHFUL MIRROR of the authoritative backend scorer at
// backend/src/lib/confidence.ts (prose-first calibration, 2026-06-05). The
// dashboard board badge, the create-form live badge, and the TaskDetail badge
// all call calculateConfidence() for instant, no-network feedback, so the
// client must compute the SAME score the server/gate computes. The previous
// frontend scorer was the drifted v1 (template-gated denominator, 6 weighted
// rules, no caps/keystone) and reported numbers the backend no longer agrees
// with — it has been replaced wholesale by this mirror.
//
// Keep in sync with the backend. Parity is asserted by confidence.test.ts,
// whose expected values are ground-truth from the backend scorer. The only
// intentional differences vs the backend file: no zod (the frontend has no zod
// dependency — the schemas live as TS types here) and no console.info side
// effect (the ops "score_capped" log is server-only).

// ── Types ───────────────────────────────────────────────────────────────────

export const TASK_TYPES = [
  "bugfix",
  "feature",
  "refactoring",
  "security",
  "migration",
  "docs",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** Opt-in quality/safety preferences a producer (e.g. the spec-slicer) can
 *  declare per task. Stored/round-tripped only; not scored. */
export interface Prefers {
  testBeforeImplementation?: boolean;
  verticalSlices?: boolean;
  smallDiffs?: boolean;
  explicitStopConditions?: boolean;
  noSpeculativeRefactoring?: boolean;
}

export interface TemplateData {
  goal?: string;
  acceptanceCriteria?: string;
  context?: string;
  constraints?: string;
  // scorer-v2 executability fields (1:1 with the spec-slicer schema).
  scope?: string;
  outOfScope?: string;
  dependencies?: string;
  risk?: string;
  agentPrompt?: string;
  prefers?: Prefers;
  taskType?: TaskType;
}

export interface TemplateFields {
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

export type QualityDimension =
  | "completeness"
  | "concreteness"
  | "testability"
  | "scopeClarity"
  | "contextQuality"
  | "structure"
  | "ambiguityRisk";

export interface QualityFinding {
  code: string;
  severity: "info" | "warning" | "blocking";
  dimension: QualityDimension;
  message: string;
  suggestion?: string;
  keystone?: boolean;
}

export interface TaskQualitySubscores {
  completeness: number;
  concreteness: number;
  testability: number;
  scopeClarity: number;
  contextQuality: number;
  structure: number;
  ambiguityRisk: number;
}

export interface ConfidenceResult {
  score: number;
  missing: string[];
  subscores: TaskQualitySubscores;
  findings: QualityFinding[];
  blocking: boolean;
  inferredTaskType?: TaskType;
}

// ── Milestone 2: per-task-type confidence thresholds (task b8629b99) ───────
// FAITHFUL MIRROR of resolveEffectiveThreshold in backend/src/lib/confidence.ts
// (task f186b88b closes the frontend gap: this mirror did not exist before —
// the TaskDetail badge compared the client-side score against the flat
// `project.confidenceThreshold` prop only, so a project with a per-type
// override (e.g. security: 90) showed an above-threshold badge for a task
// the /start claim gate would reject). Keep in sync with the backend.

/** Global fallback when a project has never set `confidenceThreshold` either.
 *  Same rollout default as the backend's GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD. */
export const GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD = 60;

export type TaskTypeThresholds = Partial<Record<TaskType, number>>;

export type ThresholdSource = "global" | "project" | "taskType";

export interface EffectiveThreshold {
  effectiveThreshold: number;
  thresholdSource: ThresholdSource;
}

/**
 * Resolves the layered confidence-threshold hierarchy:
 *   Project.taskTypeThresholds[taskType] -> Project.confidenceThreshold ->
 *   GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD (60).
 *
 * `taskType` must be the EXPLICIT `templateData.taskType` (`inferredTaskType`
 * on `ConfidenceResult`, which simply echoes it) — never a heuristically
 * guessed type. `taskTypeThresholds` reaches this function the same way it
 * reaches the backend: an unvalidated value straight off the `Project` API
 * response (write-time validated server-side, never re-validated on read),
 * so the same own-property-safe guard and numeric re-validation the backend
 * applies are mirrored here. FAITHFUL MIRROR of the backend; keep in sync.
 */
export function resolveEffectiveThreshold(
  taskType: TaskType | undefined,
  taskTypeThresholds: unknown,
  projectThreshold: number | null | undefined,
): EffectiveThreshold {
  if (
    taskTypeThresholds !== null &&
    typeof taskTypeThresholds === "object" &&
    typeof taskType === "string" &&
    Object.prototype.hasOwnProperty.call(taskTypeThresholds, taskType)
  ) {
    const raw = (taskTypeThresholds as Record<string, unknown>)[taskType];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100) {
      return { effectiveThreshold: raw, thresholdSource: "taskType" };
    }
  }
  if (typeof projectThreshold === "number" && Number.isFinite(projectThreshold)) {
    return { effectiveThreshold: projectThreshold, thresholdSource: "project" };
  }
  return { effectiveThreshold: GLOBAL_DEFAULT_CONFIDENCE_THRESHOLD, thresholdSource: "global" };
}

interface ConfidenceInput {
  title: string;
  description: string | null;
  templateData: TemplateData | null;
  templateFields?: TemplateFields | null;
}

// ── Description Quality (no LLM, pure heuristics) ──────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "can", "could", "must", "and", "but", "or",
  "nor", "not", "so", "yet", "for", "at", "by", "to", "in", "on", "of",
  "with", "from", "as", "into", "it", "its", "this", "that", "these",
  "those", "i", "we", "you", "he", "she", "they", "me", "us", "him",
  "her", "them", "my", "our", "your", "his", "their",
  "der", "die", "das", "ein", "eine", "und", "oder", "aber", "nicht",
  "ist", "sind", "war", "wird", "hat", "haben", "sein", "werden",
  "mit", "von", "für", "auf", "aus", "bei", "nach", "über", "unter",
  "vor", "zu", "als", "auch", "noch", "nur", "dann", "wenn", "weil",
  "ich", "du", "er", "sie", "es", "wir", "ihr", "man", "sich",
]);

/**
 * Scores description quality 0.0–1.0 using pure text heuristics:
 * length (diminishing returns), information density, structure markers,
 * and concreteness (file paths, URLs, numbers). Byte-identical to the backend.
 */
export function descriptionQuality(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const lenScore = Math.min(trimmed.length / 300, 1) * 0.25;

  const words = trimmed.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const totalWords = words.length;
  if (totalWords === 0) return lenScore;

  const contentWords = words.filter((w) => !STOP_WORDS.has(w.replace(/[^a-zäöüß]/g, "")));
  const uniqueContent = new Set(contentWords).size;
  const densityRatio = totalWords > 0 ? uniqueContent / totalWords : 0;
  const densityScore = Math.min(densityRatio / 0.5, 1) * 0.30;

  let structScore = 0;
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length >= 2) structScore += 0.08;
  if (lines.length >= 4) structScore += 0.07;
  if (/^[\s]*[-*•]\s/m.test(trimmed)) structScore += 0.05;
  if (/^[\s]*\d+[.)]\s/m.test(trimmed)) structScore += 0.05;

  let concreteScore = 0;
  if (/[a-zA-Z_][a-zA-Z0-9_]*\.[a-z]{1,4}\b/.test(trimmed)) concreteScore += 0.05;
  if (/\/[a-zA-Z_]/.test(trimmed)) concreteScore += 0.05;
  if (/`[^`]+`/.test(trimmed)) concreteScore += 0.04;
  if (/https?:\/\//.test(trimmed)) concreteScore += 0.03;
  if (/\d{2,}/.test(trimmed)) concreteScore += 0.03;

  return Math.min(lenScore + densityScore + structScore + concreteScore, 1);
}

// ── Markdown spec-section extraction ────────────────────────────────────────
// task_create v2 has no structured goal/acceptanceCriteria fields — the whole
// spec is authored as markdown in `description`. Presence checks therefore must
// also read `## Goal` / `## Acceptance Criteria` / ... headings, otherwise a
// markdown-authored spec reports every field missing. FAITHFUL MIRROR of the
// backend extractSpecSections (backend/src/lib/confidence.ts); keep in sync.

// The nine string-valued spec fields a markdown section can satisfy (excludes
// the non-string TemplateData members `prefers` and `taskType`).
type SpecField =
  | "goal"
  | "acceptanceCriteria"
  | "scope"
  | "outOfScope"
  | "dependencies"
  | "risk"
  | "agentPrompt"
  | "context"
  | "constraints";

// Normalized heading text → TemplateData field. `normalizeHeading` strips a
// trailing colon and a single trailing "(...)" decorator, then the lookup is
// exact on the remainder — so "Out of scope (x)" maps to outOfScope and can
// never satisfy `scope`, while "Scope (harness, mechanical)" still maps to
// `scope`.
const SECTION_ALIASES: Record<string, SpecField> = {
  "goal": "goal",
  "acceptance criteria": "acceptanceCriteria",
  "done when": "acceptanceCriteria",
  "evals": "acceptanceCriteria",
  "verify": "acceptanceCriteria",
  "verification": "acceptanceCriteria",
  "success criteria": "acceptanceCriteria",
  "scope": "scope",
  "out of scope": "outOfScope",
  "out-of-scope": "outOfScope",
  "non-goals": "outOfScope",
  "non goals": "outOfScope",
  "non-goal": "outOfScope",
  "dependencies": "dependencies",
  "prerequisites": "dependencies",
  "risk": "risk",
  "risks": "risk",
  "agent prompt": "agentPrompt",
  "context": "context",
  "constraints": "constraints",
};

const HEADING_LINE = /^#{1,6}\s+(.+?)\s*$/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;

// Reduce a raw heading to its canonical alias key. Strips a trailing colon
// ("Goal:") and a single trailing parenthetical decorator ("Scope (harness,
// mechanical)", "Acceptance criteria (mutation-testable)"). The alias lookup
// stays EXACT on the stripped remainder, so the decorator strip widens
// recognition without ever collapsing distinct sections ("Out of scope (x)" →
// "out of scope", never "scope"). Only the last trailing "(...)" is removed;
// inline suffixes ("Scope: xyz") and multiple trailing groups stay
// unrecognized by design.
function normalizeHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/:$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

/**
 * Derives spec fields from ATX markdown headings in a task description.
 * A section counts only when it has non-empty body text before the next
 * heading (an empty `## Goal` is not a goal). Headings inside code fences
 * are ignored so quoted examples cannot fake a section; a fence only closes
 * on a matching marker (``` never closes ~~~) of at least the opening
 * length, and an unclosed fence swallows the rest of the description
 * (fail-safe: false-missing, never false-present). ATX headings at column 0
 * only — setext (`Goal\n====`), blockquoted, and indented headings are
 * deliberately not recognized.
 */
export function extractSpecSections(description: string): Partial<Record<SpecField, string>> {
  const sections: Partial<Record<SpecField, string>> = {};
  let current: SpecField | null = null;
  let body: string[] = [];
  let openFence: string | null = null;

  const commit = () => {
    if (!current) return;
    const text = body.join("\n").trim();
    // First occurrence wins; a duplicate heading never overwrites a filled one.
    if (text.length > 0 && !sections[current]) sections[current] = text;
  };

  for (const line of description.split(/\r?\n/)) {
    const fence = line.trimStart().match(FENCE_OPEN)?.[1];
    if (fence) {
      if (!openFence) openFence = fence;
      else if (fence[0] === openFence[0] && fence.length >= openFence.length) openFence = null;
      if (current) body.push(line);
      continue;
    }
    const heading = openFence ? null : line.match(HEADING_LINE);
    if (heading) {
      commit();
      current = SECTION_ALIASES[normalizeHeading(heading[1])] ?? null;
      body = [];
    } else if (current) {
      body.push(line);
    }
  }
  commit();
  return sections;
}

// ── scorer-v2: fixed-denominator field weights ──────────────────────────────
// Every core field is ALWAYS scored, so the denominator is a fixed 100 (no
// template-gated dilution). PROSE-FIRST calibration (2026-06-05): the spec
// lives in the prose `description`, so it dominates; the structured fields are
// bonuses. Verifiability is enforced by the evals KEYSTONE cap below, not a
// weight. Sum MUST be exactly 100.
export const FIELD_WEIGHTS = {
  title: 10,
  description: 52,
  goal: 6,
  evals: 16, // acceptanceCriteria
  agentPrompt: 3,
  scope: 6,
  outOfScope: 3,
  dependencies: 2,
  risk: 2,
} as const;

// Caps the score ABSOLUTELY below the default threshold (60) when a task has no
// acceptance criteria AND no verification signal in its description.
export const EVALS_KEYSTONE_CAP = 55;

/** Half-credit for a description that carries a prose verification path but no
 *  structured acceptance criteria. */
const EVALS_PARTIAL_POINTS = Math.round(FIELD_WEIGHTS.evals / 2);

const VAGUE_TERMS = [
  "fix", "improve", "optimize", "clean up",
  "somehow", "quickly", "simple", "modernize",
];

const VAGUE_TERM_PATTERN = new RegExp(
  "\\b(" + VAGUE_TERMS.map((t) => t.replace(/\s+/g, "\\s+")).join("|") + ")\\b",
  "gi",
);

// Verification signal: anything that gives an agent or reviewer a way to know
// the task is done.
const VERIFICATION_SIGNAL_PATTERN = /\b(test|run|curl|check|verify|green|CI)\b/i;

// Heuristics that drive subscores. Each dimension returns 0..100.
function computeSubscores(
  input: ConfidenceInput,
  sections: Partial<Record<SpecField, string>>,
): TaskQualitySubscores {
  const desc = (input.description ?? "").trim();
  const td = input.templateData;
  const hasField = (v?: string | null) => (v?.trim().length ?? 0) > 0;

  const titlePresent = input.title.trim().length > 0;
  const goalPresent = hasField(td?.goal) || hasField(sections.goal);
  const acPresent = hasField(td?.acceptanceCriteria) || hasField(sections.acceptanceCriteria);
  const ctxPresent = hasField(td?.context) || hasField(sections.context);
  const consPresent = hasField(td?.constraints) || hasField(sections.constraints);
  const descPresent = desc.length > 0;

  // ── completeness: ratio of present required fields
  const requiredFlags = [
    titlePresent,
    descPresent,
    input.templateFields?.goal ? goalPresent : null,
    input.templateFields?.acceptanceCriteria ? acPresent : null,
    input.templateFields?.context ? ctxPresent : null,
    input.templateFields?.constraints ? consPresent : null,
  ].filter((v) => v !== null) as boolean[];
  const completeness = requiredFlags.length === 0
    ? 100
    : Math.round((requiredFlags.filter(Boolean).length / requiredFlags.length) * 100);

  // ── concreteness: count concrete anchors in description
  let anchors = 0;
  if (/[a-zA-Z_][a-zA-Z0-9_]*\.[a-z]{1,4}\b/.test(desc)) anchors++;
  if (/\/[a-zA-Z_]/.test(desc)) anchors++;
  if (/`[^`]+`/.test(desc)) anchors++;
  if (/https?:\/\//.test(desc)) anchors++;
  if (/\d{2,}/.test(desc)) anchors++;
  const concreteness = Math.min(anchors * 25, 100);

  // ── testability
  let testability = 0;
  if (acPresent) testability = 100;
  else if (/\b(test|verify|expect|assert|should|given|when|then)\b/i.test(desc)) testability = 60;

  // ── scopeClarity
  let scopeClarity = 0;
  if (consPresent) scopeClarity = 100;
  else if (/\b(in scope|out of scope|do not|only|keep|non-goal|don't change)\b/i.test(desc)) scopeClarity = 60;

  // ── contextQuality
  let contextQuality = 0;
  if (ctxPresent) contextQuality = 100;
  else if (descPresent) contextQuality = Math.min(Math.round((desc.length / 300) * 70), 70);

  // ── structure
  let structure = 0;
  if (descPresent) {
    const lines = desc.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length >= 2) structure += 30;
    if (lines.length >= 4) structure += 25;
    if (/^[\s]*[-*•]\s/m.test(desc)) structure += 20;
    if (/^[\s]*\d+[.)]\s/m.test(desc)) structure += 15;
    if (/^#+\s/m.test(desc)) structure += 10;
    structure = Math.min(structure, 100);
  }

  // ── ambiguityRisk: start 100, -10 per vague hit, floor 0. Higher = less risky.
  const hits = descPresent ? (desc.match(VAGUE_TERM_PATTERN) ?? []).length : 0;
  const ambiguityRisk = Math.max(100 - hits * 10, 0);

  return {
    completeness,
    concreteness,
    testability,
    scopeClarity,
    contextQuality,
    structure,
    ambiguityRisk,
  };
}

type MissFinding = {
  code: string;
  dimension: QualityDimension;
  message: string;
  suggestion: string;
  severity: QualityFinding["severity"];
  keystone?: boolean;
};

const MISS_FINDINGS: Record<string, MissFinding> = {
  title:              { code: "missing_title",                dimension: "completeness",  severity: "blocking", message: "Title is empty.",                                  suggestion: "Add a short imperative title naming the change." },
  description:        { code: "missing_or_thin_description",  dimension: "structure",     severity: "blocking", message: "Description is missing or below quality threshold.", suggestion: "Add a short Context and Goal section with concrete anchors." },
  goal:               { code: "missing_goal",                 dimension: "completeness",  severity: "warning",  message: "Goal is missing.",                                 suggestion: "Add a one-line Goal stating the intended outcome." },
  acceptanceCriteria: { code: "missing_acceptance_criteria",  dimension: "testability",   severity: "blocking", keystone: true, message: "No acceptance criteria and no verification path in the description.", suggestion: "Add 2-5 bullets describing observable completion conditions (the task's evals)." },
  scope:              { code: "missing_scope",                dimension: "scopeClarity",  severity: "warning",  message: "Scope (what may change) is missing.",              suggestion: "List the files, modules, or surfaces the change may touch." },
  outOfScope:         { code: "missing_out_of_scope",         dimension: "scopeClarity",  severity: "info",     message: "Out-of-scope boundary is missing.",                suggestion: "Name what must NOT change so a weak agent does not wander." },
  dependencies:       { code: "missing_dependencies",         dimension: "completeness",  severity: "info",     message: "Dependencies are unstated.",                       suggestion: "State prerequisite work, or 'none' if there is no prerequisite." },
  risk:               { code: "missing_risk",                 dimension: "ambiguityRisk", severity: "info",     message: "Risk / blast radius is unstated.",                 suggestion: "Note the risk level or blast radius (low / medium / high, and why)." },
  agentPrompt:        { code: "missing_agent_prompt",         dimension: "completeness",  severity: "warning",  keystone: true, message: "No literal agent instruction block (agentPrompt).", suggestion: "Add a step-by-step instruction block a weak agent can execute verbatim." },
};

function buildFindings(
  missing: string[],
  subscores: TaskQualitySubscores,
  descPresent: boolean,
  evalsKeystoneViolated: boolean,
): QualityFinding[] {
  const findings: QualityFinding[] = [];
  for (const field of missing) {
    const tpl = MISS_FINDINGS[field];
    if (!tpl) continue;
    if (field === "acceptanceCriteria" && !evalsKeystoneViolated) {
      findings.push({
        code: tpl.code,
        severity: "warning",
        dimension: tpl.dimension,
        message: "No structured acceptance criteria; the description's verification signal is the only evals path.",
        suggestion: tpl.suggestion,
      });
      continue;
    }
    findings.push({
      code: tpl.code,
      severity: tpl.severity,
      dimension: tpl.dimension,
      message: tpl.message,
      suggestion: tpl.suggestion,
      ...(tpl.keystone ? { keystone: true } : {}),
    });
  }
  // Subscore-driven warnings evaluate the literal `description` text only,
  // and only run when a literal description is present. When description is
  // absent — even if templateData.goal/context substitutes for it via the
  // MAX-semantics equivalence check above and defuses missing_or_thin_description
  // — these two warnings are intentionally skipped rather than evaluated
  // against the substitute text. FAITHFUL MIRROR of the backend; keep in sync.
  if (descPresent) {
    if (subscores.ambiguityRisk < 70) {
      findings.push({
        code: "vague_language",
        severity: "warning",
        dimension: "ambiguityRisk",
        message: "Description contains vague terms an agent cannot act on directly.",
        suggestion: `Replace generic verbs (e.g. ${VAGUE_TERMS.slice(0, 4).join(", ")}) with the concrete change you want.`,
      });
    }
    if (subscores.concreteness === 0) {
      findings.push({
        code: "no_concrete_anchors",
        severity: "warning",
        dimension: "concreteness",
        message: "Description has no file paths, code references, URLs, or numbers.",
        suggestion: "Anchor the change to a specific file, function, route, or commit.",
      });
    }
  }
  return findings;
}

interface CapRule {
  cap: number;
  applies: boolean;
  code: string;
  dimension: QualityDimension;
  message: string;
}

function applyScoreCaps(
  rawScore: number,
  input: ConfidenceInput,
  subscores: TaskQualitySubscores,
  sections: Partial<Record<SpecField, string>>,
): { cappedScore: number; capFindings: QualityFinding[] } {
  const desc = (input.description ?? "").trim();
  const td = input.templateData;

  const has = (v?: string | null) => (v?.trim().length ?? 0) > 0;
  const titlePresent = input.title.trim().length > 0;
  const descPresent = desc.length > 0;
  const acPresent = has(td?.acceptanceCriteria) || has(sections.acceptanceCriteria);

  // Same description-equivalence substitution as calculateConfidence's
  // missing[] check above — keeps this cap and that finding in agreement, so
  // a rich goal+context pair defuses both together. MAX semantics: the
  // higher of the literal description's own quality and the goal+context
  // equivalent's quality wins, so a present-but-thin description can never
  // score WORSE than an absent one just because a rich goal+context pair
  // exists (deleting text must never raise the score). FAITHFUL MIRROR of
  // the backend; keep in sync.
  const descEquivalentQuality = Math.max(
    descriptionQuality(desc),
    descriptionQuality(
      [td?.goal, td?.context]
        .filter((v) => (v?.trim().length ?? 0) > 0)
        .join("\n\n")
        // Bounded: the quality heuristic saturates far below this, and an
        // unbounded 50k templateData field made the analysis blow the
        // 5s route-test budget in CI (measured on PR #431).
        .slice(0, 10_000),
    ),
  );

  const verificationSignal = acPresent || (descPresent && VERIFICATION_SIGNAL_PATTERN.test(desc));
  const evalsKeystoneViolated = !acPresent && !verificationSignal;
  const ambiguityHits = descPresent ? (desc.match(VAGUE_TERM_PATTERN) ?? []).length : 0;
  const hasConcrete = subscores.concreteness > 0;

  const rules: CapRule[] = [
    {
      cap: 30, applies: !titlePresent,
      code: "missing_title", dimension: "completeness",
      message: "Score capped at 30: title is empty.",
    },
    {
      cap: 40, applies: !descPresent && descEquivalentQuality < 0.4,
      code: "missing_or_thin_description", dimension: "structure",
      message: "Score capped at 40: description is empty and templateData goal/context are missing or too thin to substitute.",
    },
    {
      cap: EVALS_KEYSTONE_CAP, applies: evalsKeystoneViolated,
      code: "missing_acceptance_criteria", dimension: "testability",
      message: `Score capped at ${EVALS_KEYSTONE_CAP}: no acceptance criteria and no verification path (test/run/curl/check/verify/green/CI) in the description — there is no way to know the task is done.`,
    },
    {
      cap: 75, applies: ambiguityHits >= 3 && !hasConcrete,
      code: "ambiguous_scope", dimension: "ambiguityRisk",
      message: `Score capped at 75: ${ambiguityHits} vague terms with no concrete anchors (file path, URL, inline code, or number).`,
    },
    {
      cap: 70, applies: subscores.testability < 60,
      code: "low_testability", dimension: "testability",
      message: "Score capped at 70: low testability — no acceptance criteria and no test/verify/expect/assert/should/given/when/then language, so there is no way to know the task is done.",
    },
    {
      cap: 75, applies: subscores.scopeClarity < 60,
      code: "low_scope_clarity", dimension: "scopeClarity",
      message: "Score capped at 75: low scope clarity — no constraints and no in-scope/out-of-scope markers, so a weak agent can wander.",
    },
    {
      cap: 80, applies: subscores.concreteness === 0,
      code: "low_concreteness", dimension: "concreteness",
      message: "Score capped at 80: no concrete anchors — no file path, code reference, URL, or number to ground the work.",
    },
  ];

  const triggered = rules.filter((r) => r.applies);
  if (triggered.length === 0) return { cappedScore: rawScore, capFindings: [] };

  const strictest = Math.min(...triggered.map((r) => r.cap));
  const cappedScore = Math.min(rawScore, strictest);

  const capFindings: QualityFinding[] = triggered.map((r) => ({
    code: r.code,
    severity: "warning",
    dimension: r.dimension,
    message: r.message,
    suggestion: `Add the missing element to lift this cap (current ceiling ${r.cap}/100).`,
  }));

  return { cappedScore, capFindings };
}

// ── Milestone 2: per-type required signals (overlay §"Task-Type-Aware
// Scoring", table verbatim in task 6b88ec87). A task with an EXPLICIT
// `templateData.taskType` (never the echoed `inferredTaskType`) must
// evidence every signal the matrix lists for that type somewhere in its
// spec. A missing signal is ALWAYS a `blocking` finding. Where the signal is
// the same concept as an existing universal field, the check reuses that
// field's own presence flag AND CODE, so a missing field ESCALATES its
// existing (often lower-severity) finding to `blocking` in place instead of
// adding a second, byte-identical-suggestion entry for the same gap (see the
// merge in calculateConfidence). Signals with no existing TemplateData field
// (e.g. "reproduction steps") are detected by a dedicated keyword regex over
// the raw description: pure heuristic, no LLM, per Scope. FAITHFUL MIRROR of
// the backend; keep in sync.
//
// Codes below fall into exactly two buckets — every entry's `code` is one or
// the other, never something in between:
//
//  ALIASED to an existing universal `MISS_FINDINGS` code (the finding this
//  code produces is indistinguishable from the universal one; the matrix
//  entry only ever escalates severity, it is never the first thing to push a
//  finding for that code — see the merge loop in calculateConfidence):
//    missing_goal                (feature; was missing_user_goal)
//    missing_scope                (feature, docs, refactoring; refactoring's
//                                  was missing_scope_boundary)
//    missing_out_of_scope         (refactoring; was missing_non_goals)
//    missing_risk                 (refactoring; was missing_risk_areas)
//    missing_acceptance_criteria  (feature, docs — each type's own AC-named
//                                  entry, present: ctx.acPresent)
//
// D-014 (orchestrator decision, task 6b88ec87 review round 2 finding 2): the
// matrix used to ALSO carry a fifth "verification path in the description"
// entry on bugfix/feature/security/migration, `present: (ctx) =>
// ctx.verificationSignal`. That predicate is `!evalsKeystoneViolated`, the
// EXACT condition the universal evals-keystone finding (missing_acceptance_
// criteria, blocking) already fires on — the two conditions can never
// diverge, so whenever this entry's signal was missing, the universal
// keystone finding was ALREADY present in `findings[]` and ALREADY blocking.
// The entry was therefore provably inert: it could only ever "escalate" a
// finding that was already at the ceiling severity, never change any
// observable output (score/missing/blocking/findings all identical with or
// without it, on every input — confirmed by the full suite staying green
// after deletion). It has been deleted from all four type tables rather than
// kept as a harmless no-op: the type-aware matrix's "verification path"
// requirement for bugfix/feature/security/migration is fully enforced by the
// universal evals keystone alone (missing_acceptance_criteria at blocking),
// so no per-type entry exists for it.
//
//  NEW: no universal MISS_FINDINGS counterpart exists, unified to ONE code
//  per concept across every type table that carries it (rather than each
//  type inventing its own spelling):
//    missing_constraints    (feature, security — constraints is a required
//                            signal for these types but is not scored/
//                            tracked universally, see the MISS_FINDINGS
//                            comment above)
//    missing_rollback        (security, migration; security's was
//                            missing_rollback_if_relevant)
//    everything else in the matrix below is type-specific prose (e.g.
//    missing_reproduction_steps, missing_threat_or_risk,
//    missing_deployment_impact, ...) and has exactly one type table each.
//
// REQUIRED_SIGNAL_ONLY_CODES (below the matrix) is exactly the NEW bucket —
// deriveNextActions (backend claim-policy-evaluator.ts; frontend has no
// nextActions consumer today) uses it to rank a pure universal finding ahead
// of a type-specific one within the same severity; an ALIASED code is
// deliberately excluded from that set because it always escalates a
// pre-existing universal finding and should sort as one.
//
// Per-type score weights/caps are a separate follow-up (M2-thresholds): these
// findings never change `score` and never set `keystone`, so on their own
// they do not move `ConfidenceResult.blocking` either.
interface RequiredSignalContext {
  descTrim: string;
  goalPresent: boolean;
  scopePresent: boolean;
  outOfScopePresent: boolean;
  acPresent: boolean;
  riskPresent: boolean;
  constraintsPresent: boolean;
  verificationSignal: boolean;
}

interface RequiredSignal {
  code: string;
  dimension: QualityDimension;
  message: string;
  suggestion: string;
  present: (ctx: RequiredSignalContext) => boolean;
}

const kw = (pattern: RegExp): RequiredSignal["present"] => (ctx) => pattern.test(ctx.descTrim);

const REQUIRED_SIGNALS_BY_TYPE: Record<TaskType, RequiredSignal[]> = {
  bugfix: [
    {
      code: "missing_actual_behavior", dimension: "completeness",
      message: "Actual (buggy) behavior is not described.",
      suggestion: "State what actually happens today, in observable terms.",
      present: kw(/\bactual(ly)?\s+behaviou?r\b|\bactually\s+happens?\b|\bcurrently\s+(does|happens|behaves)\b|\bobserved\s+behaviou?r\b|\bwhat\s+(currently\s+)?happens\b/i),
    },
    {
      code: "missing_expected_behavior", dimension: "completeness",
      message: "Expected (correct) behavior is not described.",
      suggestion: "State what should happen instead.",
      present: kw(/\bexpected\s+behaviou?r\b|\bshould\s+(instead\s+)?happen\b|\bexpected\s+result\b|\bdesired\s+behaviou?r\b/i),
    },
    {
      code: "missing_reproduction_steps", dimension: "testability",
      message: "Reproduction steps are missing.",
      suggestion: "Add numbered steps to reproduce the bug.",
      present: kw(/\breproduc(e|es|ing|tion)\b|\brepro\s+steps?\b|\bsteps?\s+to\s+reproduce\b|\bhow\s+to\s+reproduce\b/i),
    },
    {
      code: "missing_error_message_or_symptom", dimension: "concreteness",
      message: "No error message or symptom is quoted.",
      suggestion: "Paste the exact error message, stack trace, or observed symptom.",
      present: kw(/\berror\s+messages?\b|\bstack\s+trace\b|\bexceptions?\b|\bsymptoms?\b|\bthrows?\b|\berror:\s|\bfailure\s+message\b/i),
    },
    {
      code: "missing_affected_environment", dimension: "contextQuality",
      message: "Affected environment (OS, browser, version, platform) is unstated.",
      suggestion: "Name the environment the bug occurs in (OS, browser, runtime version, platform).",
      present: kw(/\benvironments?\b|\bbrowsers?\b|\boperating\s+system\b|\bplatforms?\b|\bnode\s+v?\d/i),
    },
  ],
  feature: [
    {
      code: "missing_goal", dimension: "completeness",
      message: "User goal is missing.",
      suggestion: "Add a one-line Goal stating the intended outcome.",
      present: (ctx) => ctx.goalPresent,
    },
    {
      code: "missing_scope", dimension: "scopeClarity",
      message: "Scope (what may change) is missing.",
      suggestion: "List the files, modules, or surfaces the change may touch.",
      present: (ctx) => ctx.scopePresent,
    },
    {
      code: "missing_acceptance_criteria", dimension: "testability",
      message: "No acceptance criteria and no verification path in the description.",
      suggestion: "Add 2-5 bullets describing observable completion conditions (the task's evals).",
      present: (ctx) => ctx.acPresent,
    },
    {
      code: "missing_constraints", dimension: "scopeClarity",
      message: "Constraints are unstated.",
      suggestion: "Add a Constraints section naming what must not change.",
      present: (ctx) => ctx.constraintsPresent,
    },
    {
      code: "missing_ux_api_expectations", dimension: "completeness",
      message: "UX/API expectations are unstated.",
      suggestion: "Describe the expected UI behavior or API/interface shape.",
      present: kw(/\bapis?\b|\bux\b|\buser\s+experience\b|\bendpoints?\b|\bresponses?\b|\binterfaces?\b/i),
    },
  ],
  refactoring: [
    {
      code: "missing_purpose", dimension: "completeness",
      message: "Purpose (why this refactor) is not stated.",
      suggestion: "Add a one-line Purpose stating why this refactor is worth doing.",
      present: kw(/\bpurpose\b|\bmotivation\b|\bwhy\s+this\b/i),
    },
    {
      // Aliased to the universal `missing_scope` code (see the header
      // comment above REQUIRED_SIGNALS_BY_TYPE).
      code: "missing_scope", dimension: "scopeClarity",
      message: "Scope boundary (what may change) is missing.",
      suggestion: "List the files, modules, or surfaces the refactor may touch.",
      present: (ctx) => ctx.scopePresent,
    },
    {
      // Aliased to the universal `missing_out_of_scope` code.
      code: "missing_out_of_scope", dimension: "scopeClarity",
      message: "Non-goals are unstated.",
      suggestion: "Name what must NOT change so a weak agent does not wander.",
      present: (ctx) => ctx.outOfScopePresent,
    },
    {
      code: "missing_behavior_preservation", dimension: "ambiguityRisk",
      message: "Behavior-preservation guarantee is not stated.",
      suggestion: "State that observable behavior is unchanged (or exactly how it changes).",
      present: kw(/\bbehaviou?r[- ]preserv|\bno\s+behaviou?r\s+change|\bfunctionally\s+equivalent\b|\bsame\s+behaviou?r\b/i),
    },
    {
      code: "missing_regression_strategy", dimension: "testability",
      message: "Regression strategy is unstated.",
      suggestion: "State how regressions will be caught (existing tests, new tests, manual pass).",
      present: kw(/\bregressions?\b|\bexisting\s+tests?\b|\btest\s+suite\b|\btest\s+coverage\b/i),
    },
    {
      // Aliased to the universal `missing_risk` code.
      code: "missing_risk", dimension: "ambiguityRisk",
      message: "Risk areas are unstated.",
      suggestion: "Note the risk level or blast radius (low / medium / high, and why).",
      present: (ctx) => ctx.riskPresent,
    },
  ],
  security: [
    {
      // Bare `secur(e|ity)` matched trivially ("This is a secure change.")
      // without naming any actual goal/property; require the word to be
      // followed by a goal-ish object noun instead (still matched by the
      // dedicated `security goal` phrase below, now generalized).
      code: "missing_security_goal", dimension: "completeness",
      message: "Security goal is not stated.",
      suggestion: "State the security property this change establishes or restores.",
      present: kw(/\bsecur(e|ity)\s+(goal|property|guarantee|boundary|control|posture)\b|\bharden(ing)?\b|\bmitigat(e|es|ion)\b/i),
    },
    {
      code: "missing_affected_asset", dimension: "concreteness",
      message: "Affected asset is not named.",
      suggestion: "Name the asset at risk (endpoint, credential, token, data, resource).",
      present: kw(/\bassets?\b|\bendpoints?\b|\bcredentials?\b|\btokens?\b|\bsecrets?\b/i),
    },
    {
      code: "missing_threat_or_risk", dimension: "ambiguityRisk",
      message: "Threat or risk is not described.",
      suggestion: "Describe the threat, vulnerability, or attack this change addresses.",
      present: kw(/\bthreats?\b|\bvulnerab(le|ility|ilities)\b|\battacks?\b|\bexploits?\b/i),
    },
    {
      code: "missing_constraints", dimension: "scopeClarity",
      message: "Constraints are unstated.",
      suggestion: "Add a Constraints section naming what must not change.",
      present: (ctx) => ctx.constraintsPresent,
    },
    {
      code: "missing_review_requirement", dimension: "completeness",
      message: "Review requirement is unstated.",
      suggestion: "State who must review or sign off before this ships.",
      present: kw(/\breview\s+requir|\bsecurity\s+review\b|\bsign[- ]?off\b|\bapprovals?\b|\breviewed\s+by\b/i),
    },
    {
      // Unified with migration's `missing_rollback` (same concept, one code
      // per concept across type tables).
      code: "missing_rollback", dimension: "completeness",
      message: "Rollback plan is unstated.",
      suggestion: "State the rollback plan, or 'not applicable' if there is none.",
      present: kw(/\brollback\b|\broll\s+back\b|\breverts?\b|\bnot\s+applicable\b|\bno\s+rollback\s+needed\b/i),
    },
  ],
  migration: [
    {
      // R2 finding 6 (residual vacuity): bare `\bcurrently\b` matched any
      // sentence containing the word regardless of what it said — "Nothing
      // is currently broken." trivially satisfied "current state is
      // described" without describing any state at all. Require "currently"
      // to be immediately followed by a stateful verb, so only a genuine
      // state description ("currently lives on MySQL", "currently uses a
      // manual process") counts.
      code: "missing_current_state", dimension: "contextQuality",
      message: "Current state is not described.",
      suggestion: "Describe the current state before the migration.",
      present: kw(/\bcurrent\s+state\b|\bcurrently\s+(lives|runs|uses|stores|is|are|sits|resides)\b|\bexisting\s+(state|schema|setup|behavior)\b/i),
    },
    {
      code: "missing_target_state", dimension: "contextQuality",
      message: "Target state is not described.",
      suggestion: "Describe the target state after the migration.",
      present: kw(/\btarget\s+state\b|\bdesired\s+state\b|\bend\s+state\b|\bafter\s+(the\s+)?migration\b|\bfuture\s+state\b/i),
    },
    {
      // `\bcompat...\b` never matched "incompatible" (no word boundary
      // between "in" and "compat"); `(in)?` makes the negated form match too.
      code: "missing_compatibility", dimension: "ambiguityRisk",
      message: "Compatibility (backward/forward) is unstated.",
      suggestion: "State the compatibility guarantee during and after the migration.",
      present: kw(/\b(in)?compat(ible|ibility)?\b|\bbackward(s)?[- ]compat/i),
    },
    {
      // Unified with security's `missing_rollback` (renamed from
      // `missing_rollback_if_relevant`; same concept, one code per concept).
      code: "missing_rollback", dimension: "completeness",
      message: "Rollback plan is unstated.",
      suggestion: "State the rollback plan, or 'not applicable' if there is none.",
      present: kw(/\brollback\b|\broll\s+back\b|\breverts?\b|\bnot\s+applicable\b|\bno\s+rollback\s+needed\b/i),
    },
    {
      code: "missing_deployment_impact", dimension: "ambiguityRisk",
      message: "Deployment impact is unstated.",
      suggestion: "State the deployment impact (downtime, order of rollout, cutover steps).",
      present: kw(/\bdeploy(ment)?\b|\bdowntime\b|\bcutover\b/i),
    },
    {
      code: "missing_operational_risk", dimension: "ambiguityRisk",
      message: "Operational risk is unstated.",
      suggestion: "Note the operational risk or blast radius (low / medium / high, and why).",
      present: kw(/\boperational\s+risk\b|\bops\s+risk\b|\bon-?call\b|\brunbook\b|\bblast\s+radius\b/i),
    },
  ],
  docs: [
    {
      // R2 finding 6 (residual vacuity): bare `\breaders?\b` matched any
      // sentence mentioning the word "readers" at all — "The new schema is
      // incompatible with the old readers." trivially satisfied "target
      // audience is named" without naming any audience. Require "readers"
      // to be qualified by a clause that actually characterizes them (who
      // they are / what they need), which is how genuine audience
      // descriptions read in prose ("readers should...", "readers who are
      // new to..."); a bare noun mention no longer counts.
      code: "missing_target_audience", dimension: "contextQuality",
      message: "Target audience is not named.",
      suggestion: "Name who this doc is for.",
      present: kw(/\btarget\s+audience\b|\baudiences?\b|\breaders?\s+(who|that|will|should|need|are|come|get|can)\b/i),
    },
    {
      code: "missing_source_of_truth", dimension: "contextQuality",
      message: "Source of truth is not named.",
      suggestion: "Name the canonical/authoritative source this doc reflects.",
      present: kw(/\bsource\s+of\s+truth\b|\bcanonical\b|\bauthoritative\b/i),
    },
    {
      code: "missing_scope", dimension: "scopeClarity",
      message: "Scope (what the doc covers) is missing.",
      suggestion: "List what the doc covers and what it does not.",
      present: (ctx) => ctx.scopePresent,
    },
    {
      code: "missing_format", dimension: "structure",
      message: "Format is unstated.",
      suggestion: "State the target format (markdown, ADR, README section, etc.).",
      present: kw(/\bformats?\b|\bmarkdown\b|\btemplates?\b|\bstructure\s+of\b/i),
    },
    {
      code: "missing_acceptance_criteria", dimension: "testability",
      message: "No acceptance criteria and no verification path in the description.",
      suggestion: "Add 2-5 bullets describing observable completion conditions (the task's evals).",
      present: (ctx) => ctx.acPresent,
    },
    {
      // R2 finding 6 (residual vacuity): bare `\bowner:\b` matched a
      // non-answer line like "Owner: nobody in particular." — the label was
      // present but named no one. Keep the bare-label shortcut (real docs
      // often just write "Owner: <name>") but reject it when the word right
      // after the colon is a known negation/non-answer; any other word
      // still counts as naming someone.
      code: "missing_review_owner", dimension: "completeness",
      message: "Review owner is unstated.",
      suggestion: "Name who reviews and approves this doc.",
      present: kw(/\breview\s+owner\b|\breviewed\s+by\b|\bapprovers?\b|\bowner:\s*(?!nobody\b|none\b|n\/a\b|tbd\b|unknown\b|nothing\b)\S/i),
    },
  ],
};

// The subset of REQUIRED_SIGNALS_BY_TYPE codes that are genuinely NEW — i.e.
// do NOT alias an existing universal MISS_FINDINGS code (see the "ALIASED"
// vs "NEW" buckets in the header comment above). FAITHFUL MIRROR of the
// backend export of the same name; used by deriveNextActions below (task
// 67526c1c, M4: Improvement panel), the first frontend consumer.
const UNIVERSAL_FINDING_CODES: ReadonlySet<string> = new Set(
  Object.values(MISS_FINDINGS).map((f) => f.code),
);
export const REQUIRED_SIGNAL_ONLY_CODES: ReadonlySet<string> = new Set(
  Object.values(REQUIRED_SIGNALS_BY_TYPE)
    .flat()
    .map((signal) => signal.code)
    .filter((code) => !UNIVERSAL_FINDING_CODES.has(code)),
);

/**
 * Turn QualityFindings into a short, prioritised list of human-readable next
 * actions. Blocking findings come first, then warnings. Deduplicated by
 * suggestion text; capped at 5 so the response stays scannable.
 *
 * Within a severity tier, a UNIVERSAL finding (title/description/goal/AC/
 * scope/outOfScope/dependencies/risk/agentPrompt — including a per-taskType
 * required-signal finding that ALIASES one of those, see
 * REQUIRED_SIGNALS_BY_TYPE's header comment) sorts ahead of a genuinely
 * type-specific prose finding (`REQUIRED_SIGNAL_ONLY_CODES`, M2). Without
 * this, a typed task with many missing required signals can crowd the
 * universal scope/agentPrompt/AC guidance entirely out of the 5-item cap
 * below, even though fixing the universal gaps is the more foundational
 * advice.
 *
 * FAITHFUL MIRROR of deriveNextActions in
 * backend/src/services/claim-policy-evaluator.ts; keep in sync. The backend
 * already returns a precomputed `nextActions[]` on some responses (task
 * create, claim policy), but GET /tasks/:id/instructions returns only
 * `findings[]` — this lets the ImprovementPanel derive the same list
 * client-side from that response without a backend change.
 */
export function deriveNextActions(findings: QualityFinding[]): string[] {
  const SEVERITY_RANK: Record<QualityFinding["severity"], number> = {
    blocking: 0,
    warning: 1,
    info: 2,
  };
  const typeSpecificRank = (f: QualityFinding) => (REQUIRED_SIGNAL_ONLY_CODES.has(f.code) ? 1 : 0);
  const sorted = [...findings].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return typeSpecificRank(a) - typeSpecificRank(b);
  });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of sorted) {
    if (!f.suggestion) continue;
    if (seen.has(f.suggestion)) continue;
    seen.add(f.suggestion);
    out.push(f.suggestion);
    if (out.length >= 5) break;
  }
  return out;
}

// Missing required signal -> a `blocking` finding, code `missing_<signal-name>`.
// `taskType` is the EXPLICIT `templateData.taskType` only (never
// `inferredTaskType`). Unset taskType -> no findings (existing universal
// rules apply unchanged; see the `[]` return and the merge below).
//
// `taskType` is typed as `TaskType | undefined`, but on the backend that
// type is NOT a runtime guarantee (templateData reaches the scorer via an
// unvalidated cast on several read paths — see the backend copy of this
// comment). The frontend always constructs `templateData` from its own
// typed API responses, but this guard is mirrored anyway so the two copies
// stay behaviorally identical for any input, not just the inputs the
// frontend happens to produce today.
//
// A plain `typeof taskType === "string"` guard followed by `?? []` is NOT
// sufficient on its own (task 6b88ec87 review round 2, finding 1):
// REQUIRED_SIGNALS_BY_TYPE is a plain object literal, so an INHERITED key —
// "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", ... —
// is also a string, passes `typeof`, and resolves through bracket access to
// a truthy, non-array value (a function inherited from Object.prototype).
// `?? []` only guards nullish, not "wrong type", so `.filter` on that value
// threw for any of those five taskType strings. `Object.prototype.
// hasOwnProperty.call` confirms `taskType` is actually one of the six
// declared keys before indexing — but hasOwnProperty.call alone is ALSO not
// enough: its property-key argument is coerced via ToPropertyKey/ToString,
// so a non-string like the array `["bugfix"]` stringifies to `"bugfix"` and
// would incorrectly resolve to a real own key. `typeof taskType === "string"`
// runs FIRST specifically to block that coercion path, so only a genuine
// string ever reaches hasOwnProperty. With both guards: every other string
// (in-enum or not), every prototype-chain name, and every non-string value
// at all degrade to the same `[]` an unset taskType produces — no throw, no
// behavior change for the untyped case. FAITHFUL MIRROR of the backend;
// keep in sync.
function buildRequiredSignalFindings(
  taskType: TaskType | undefined,
  ctx: RequiredSignalContext,
): QualityFinding[] {
  const signals =
    typeof taskType === "string" && Object.prototype.hasOwnProperty.call(REQUIRED_SIGNALS_BY_TYPE, taskType)
      ? REQUIRED_SIGNALS_BY_TYPE[taskType as TaskType]
      : [];
  return signals
    .filter((signal) => !signal.present(ctx))
    .map((signal) => ({
      code: signal.code,
      severity: "blocking" as const,
      dimension: signal.dimension,
      message: signal.message,
      suggestion: signal.suggestion,
    }));
}

export function calculateConfidence(input: ConfidenceInput): ConfidenceResult {
  const td = input.templateData;
  const has = (v?: string | null) => (v?.trim().length ?? 0) > 0;
  const desc = input.description ?? "";
  const descTrim = desc.trim();
  const descPresent = descTrim.length > 0;
  const descQuality = descriptionQuality(desc);

  // A substantial templateData.goal + templateData.context pair is an
  // adequate description equivalent — an agent should not have to duplicate
  // that text into `description` just to clear the quality bar or earn the
  // description field weight below. Same descriptionQuality() heuristic, same
  // 0.4 threshold used below (no new threshold, no new weight).
  //
  // MAX semantics, not absence-only: we take the HIGHER of the literal
  // description's own quality and the goal+context equivalent's quality.
  // Absence-only substitution (equivalent applied only when description is
  // entirely empty) creates a gate inversion — deleting a thin-but-present
  // description to fall back on a rich goal+context pair would RAISE the
  // score, which must never happen. Math.max keeps the score monotonic: a
  // present description can only add to what the equivalent already earns,
  // never subtract from it.
  // FAITHFUL MIRROR of the backend; keep in sync.
  const descEquivalentQuality = Math.max(
    descQuality,
    descriptionQuality(
      [td?.goal, td?.context]
        .filter((v) => (v?.trim().length ?? 0) > 0)
        .join("\n\n")
        // Bounded: the quality heuristic saturates far below this, and an
        // unbounded 50k templateData field made the analysis blow the
        // 5s route-test budget in CI (measured on PR #431).
        .slice(0, 10_000),
    ),
  );

  // Spec sections authored as markdown headings in the description satisfy the
  // same fields as structured templateData; structured values keep precedence
  // (a section only fills a field the producer left empty).
  const sections = extractSpecSections(desc);
  const present = (field: SpecField) => has(td?.[field]) || has(sections[field]);

  const titlePresent = input.title.trim().length > 0;
  const goalPresent = present("goal");
  const acPresent = present("acceptanceCriteria");
  const scopePresent = present("scope");
  const outOfScopePresent = present("outOfScope");
  const dependenciesPresent = present("dependencies");
  const riskPresent = present("risk");
  const agentPromptPresent = present("agentPrompt");
  // `constraints` is not scored (superseded by the executability fields) but
  // is a required signal for several taskTypes (M2), so it needs its own
  // presence flag here.
  const constraintsPresent = present("constraints");

  const verificationSignal = descTrim.length > 0 && VERIFICATION_SIGNAL_PATTERN.test(descTrim);
  const evalsKeystoneViolated = !acPresent && !verificationSignal;

  // ── Fixed-denominator additive score (maxPossible is a constant 100) ──────
  const W = FIELD_WEIGHTS;
  let earned = 0;
  if (titlePresent) earned += W.title;
  earned += Math.round(W.description * descEquivalentQuality); // max of description vs. goal+context credit
  if (goalPresent) earned += W.goal;
  if (acPresent) earned += W.evals;
  else if (verificationSignal) earned += EVALS_PARTIAL_POINTS;
  if (scopePresent) earned += W.scope;
  if (outOfScopePresent) earned += W.outOfScope;
  if (dependenciesPresent) earned += W.dependencies;
  if (riskPresent) earned += W.risk;
  if (agentPromptPresent) earned += W.agentPrompt;

  const rawScore = Math.max(0, Math.min(100, earned));

  const missing: string[] = [];
  if (!titlePresent) missing.push("title");
  if (descEquivalentQuality < 0.4) missing.push("description");
  if (!goalPresent) missing.push("goal");
  if (!acPresent) missing.push("acceptanceCriteria");
  if (!scopePresent) missing.push("scope");
  if (!outOfScopePresent) missing.push("outOfScope");
  if (!dependenciesPresent) missing.push("dependencies");
  if (!riskPresent) missing.push("risk");
  if (!agentPromptPresent) missing.push("agentPrompt");

  const subscores = computeSubscores(input, sections);
  const findings = buildFindings(missing, subscores, descTrim.length > 0, evalsKeystoneViolated);

  const { cappedScore, capFindings } = applyScoreCaps(rawScore, input, subscores, sections);

  // Merge cap findings into the rule-driven list (keep higher-severity entry,
  // enrich its suggestion with the cap ceiling text).
  const byCode = new Map(findings.map((f) => [f.code, f] as const));
  for (const cf of capFindings) {
    const existing = byCode.get(cf.code);
    if (!existing) {
      findings.push(cf);
      byCode.set(cf.code, cf);
    } else if (cf.suggestion && !existing.suggestion?.includes(cf.suggestion)) {
      existing.suggestion = existing.suggestion
        ? `${existing.suggestion} ${cf.suggestion}`
        : cf.suggestion;
    }
  }

  // Milestone 2: per-type required signals. Reuses `byCode` from the cap
  // merge above: when a required-signal code already has an entry (e.g. a
  // universal `missing_scope`/`missing_acceptance_criteria` finding), that
  // entry is ESCALATED to `blocking` in place rather than duplicated, so a
  // gap the universal rules already report is never double-fired. FAITHFUL
  // MIRROR of the backend; keep in sync.
  const requiredSignalFindings = buildRequiredSignalFindings(td?.taskType, {
    descTrim,
    goalPresent,
    scopePresent,
    outOfScopePresent,
    acPresent,
    riskPresent,
    constraintsPresent,
    // The combined "is there any way to know this is done" signal (AC OR a
    // prose verification path), matching the evals keystone's own condition
    // (`!evalsKeystoneViolated`), not the raw prose-only `verificationSignal`
    // local above.
    verificationSignal: !evalsKeystoneViolated,
  });
  for (const rf of requiredSignalFindings) {
    const existing = byCode.get(rf.code);
    if (existing) {
      existing.severity = "blocking";
    } else {
      findings.push(rf);
      byCode.set(rf.code, rf);
    }
  }

  const blocking = findings.some((f) => f.keystone === true && f.severity === "blocking");

  return {
    score: cappedScore,
    missing,
    subscores,
    findings,
    blocking,
    inferredTaskType: input.templateData?.taskType,
  };
}
