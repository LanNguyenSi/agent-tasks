import { z } from "zod";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

// Bridge to Milestone 2 (per overlay §"Task-Type-Aware Scoring"). Presets
// can declare a semantic kind; tasks created from a preset copy it into
// `templateData.taskType`. Scoring is unchanged in this iteration; future
// PRs add per-type required-signals and per-type thresholds.
export const taskTypeSchema = z.enum([
  "bugfix",
  "feature",
  "refactoring",
  "security",
  "migration",
  "docs",
]);

export type TaskType = z.infer<typeof taskTypeSchema>;

export const templatePresetSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  goal: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  // scorer-v2 executability fields (1:1 with the spec-slicer schema)
  scope: z.string().optional(),
  outOfScope: z.string().optional(),
  dependencies: z.string().optional(),
  risk: z.string().optional(),
  agentPrompt: z.string().optional(),
  taskType: taskTypeSchema.optional(),
});

export type TemplatePreset = z.infer<typeof templatePresetSchema>;

export const taskTemplateSchema = z.object({
  fields: z.object({
    goal: z.boolean().default(false),
    acceptanceCriteria: z.boolean().default(false),
    context: z.boolean().default(false),
    constraints: z.boolean().default(false),
    // scorer-v2 executability fields. A project can mark them required; scoring
    // against them lands in a later slice (fields are only stored for now).
    scope: z.boolean().default(false),
    outOfScope: z.boolean().default(false),
    dependencies: z.boolean().default(false),
    risk: z.boolean().default(false),
    agentPrompt: z.boolean().default(false),
  }),
  presets: z.array(templatePresetSchema).max(20).default([]),
});

export type TaskTemplate = z.infer<typeof taskTemplateSchema>;

// Optional, opt-in quality/safety preferences a producer (e.g. the spec-slicer)
// can declare per task. Bonus-only signals; scoring against them lands in a
// later slice. Stored on templateData now so the producer schema is complete.
export const prefersSchema = z.object({
  testBeforeImplementation: z.boolean().optional(),
  verticalSlices: z.boolean().optional(),
  smallDiffs: z.boolean().optional(),
  explicitStopConditions: z.boolean().optional(),
  noSpeculativeRefactoring: z.boolean().optional(),
});

export type Prefers = z.infer<typeof prefersSchema>;

export const templateDataSchema = z.object({
  goal: z.string().optional(),
  // Canonical wire key for "evals" (the spec-slicer's Evals section). Keep this
  // single key; "evals" is only an alias at the producer edge, never stored.
  acceptanceCriteria: z.string().optional(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  // scorer-v2 executability fields (1:1 with the spec-slicer schema). Stored and
  // round-tripped now; weighting/scoring against them is a later slice.
  scope: z.string().optional(),
  outOfScope: z.string().optional(),
  dependencies: z.string().optional(),
  risk: z.string().optional(),
  agentPrompt: z.string().optional(),
  prefers: prefersSchema.optional(),
  taskType: taskTypeSchema.optional(),
});

export type TemplateData = z.infer<typeof templateDataSchema>;

// ── Description Quality (no LLM, pure heuristics) ──────────────────────────

// Common stop words (EN + DE) — high ratio = low information
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
 * - Length (diminishing returns)
 * - Information density (unique non-stop words / total words)
 * - Structure markers (lists, headings, code refs)
 * - Concreteness (file paths, URLs, numbers, technical terms)
 */
export function descriptionQuality(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  // ── Length score (0–0.25) — diminishing returns, caps at ~300 chars
  const lenScore = Math.min(trimmed.length / 300, 1) * 0.25;

  // ── Information density (0–0.30)
  const words = trimmed.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const totalWords = words.length;
  if (totalWords === 0) return lenScore;

  const contentWords = words.filter((w) => !STOP_WORDS.has(w.replace(/[^a-zäöüß]/g, "")));
  const uniqueContent = new Set(contentWords).size;
  const densityRatio = totalWords > 0 ? uniqueContent / totalWords : 0;
  const densityScore = Math.min(densityRatio / 0.5, 1) * 0.30;

  // ── Structure (0–0.25) — lists, line breaks, sections
  let structScore = 0;
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length >= 2) structScore += 0.08;
  if (lines.length >= 4) structScore += 0.07;
  if (/^[\s]*[-*•]\s/m.test(trimmed)) structScore += 0.05;  // bullet lists
  if (/^[\s]*\d+[.)]\s/m.test(trimmed)) structScore += 0.05; // numbered lists

  // ── Concreteness (0–0.20) — file paths, URLs, code, numbers
  let concreteScore = 0;
  if (/[a-zA-Z_][a-zA-Z0-9_]*\.[a-z]{1,4}\b/.test(trimmed)) concreteScore += 0.05;  // file refs
  if (/\/[a-zA-Z_]/.test(trimmed)) concreteScore += 0.05;    // paths
  if (/`[^`]+`/.test(trimmed)) concreteScore += 0.04;         // inline code
  if (/https?:\/\//.test(trimmed)) concreteScore += 0.03;     // URLs
  if (/\d{2,}/.test(trimmed)) concreteScore += 0.03;          // numbers

  return Math.min(lenScore + densityScore + structScore + concreteScore, 1);
}

// ── Markdown spec-section extraction ────────────────────────────────────────
// task_create v2 has no structured goal/acceptanceCriteria fields — the whole
// spec is authored as markdown in `description`. Presence checks therefore must
// also read `## Goal` / `## Acceptance Criteria` / ... headings, otherwise every
// v2 task reports all spec fields missing (friction-log 57–99).

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

// Normalized heading text → TemplateData field. Aliases cover the section names
// the spec-slicer and the task_create docs actually use; matching is exact on
// the full heading (so "Out of scope" can never satisfy `scope`).
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

function normalizeHeading(text: string): string {
  return text.replace(/:$/, "").trim().toLowerCase().replace(/\s+/g, " ");
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

// ── Confidence Scoring ──────────────────────────────────────────────────────

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

interface ConfidenceInput {
  title: string;
  description: string | null;
  templateData: TemplateData | null;
  templateFields?: TemplateFields | null;
}

// ── Quality Report types (ADR-0011, additive) ──────────────────────────────

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
  // scorer-v2 (T3): marks a threshold-INDEPENDENT keystone signal — a property
  // a project must not be able to silently disable by lowering its threshold.
  // The evals keystone ships as a `blocking` finding; the agentPrompt keystone
  // ships as `warning` (until a programmatic producer populates agentPrompt).
  // Gate enforcement that honours these regardless of the project threshold is
  // wired in T5 (project enforcementMode) via `ConfidenceResult.blocking`.
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

interface ConfidenceResult {
  score: number;
  missing: string[];
  subscores: TaskQualitySubscores;
  findings: QualityFinding[];
  // scorer-v2 (T3): true when a hard, threshold-INDEPENDENT keystone is violated
  // (today: evals absent — no acceptance criteria AND no verification signal in
  // the description). The deterministic score is already capped below the default
  // threshold in this case; this flag is the explicit signal T5's gate wiring
  // consumes to block such a task even when a project lowers its threshold. The
  // agentPrompt keystone is intentionally NOT reflected here (it ships as a
  // warning until a programmatic producer exists).
  blocking: boolean;
  // Bridge to Milestone 2. Echoed from `templateData.taskType` when the task
  // was created from a typed preset. Scoring is unchanged in this iteration;
  // future PRs use this to apply per-type required-signals and per-type
  // thresholds.
  inferredTaskType?: TaskType;
}

// ── scorer-v2: fixed-denominator field weights ──────────────────────────────
// Every core field is ALWAYS scored, independent of the project's taskTemplate,
// so the denominator is a fixed 100 — no template-gated dilution (the v1 bug
// where dropping required fields shrank `maxPossible` and inflated the score).
// `context`/`constraints` are intentionally NOT weighted (the executability
// rubric supersedes them; they survive only as inputs to the descriptive
// subscores).
//
// PROSE-FIRST calibration (2026-06-05, data-driven against the live 75-task
// corpus). The original T3 weights made the STRUCTURED templateData fields
// (evals/agentPrompt/scope/...) dominant — but real tasks are authored as rich
// prose DESCRIPTIONS (corpus: 75/75 have a description, quality mean 0.91;
// structured fields ~empty: goal 2/75, AC 2/75, agentPrompt 0/75), so those
// weights blocked ~99%. The spec lives in the description, so `description`
// dominates here; the structured fields are bonuses that lift a slicer-produced
// task toward 100. Verifiability is still enforced — not by a weight but by the
// evals KEYSTONE below (a task with no AC and no verification signal caps to 55
// and blocks). Result on the corpus: ~69% pass, and every still-blocked task is
// the keystone (non-verifiable). Re-tune in this one constant; the sum is
// asserted to be exactly 100 by a unit test.
export const FIELD_WEIGHTS = {
  title: 10,
  description: 52,  // the spec lives in the prose description (dominant signal)
  goal: 6,
  evals: 16,        // acceptanceCriteria — structured "how do we know it's done"
  agentPrompt: 3,   // bonus until a programmatic producer populates it
  scope: 6,
  outOfScope: 3,
  dependencies: 2,
  risk: 2,
} as const;

// The evals keystone caps the score ABSOLUTELY below the default threshold (60)
// whenever a task has no acceptance criteria AND no verification signal in its
// description. Under the prose-first weights this is load-bearing: a perfectly
// written but unverifiable task reaches raw title(10)+description(52)=62, which
// would otherwise pass — the cap pulls it to 55 so "no way to know it's done"
// always blocks. Threshold-INDEPENDENT gate enforcement (block even when a
// project lowers its threshold) is wired in T5 via `ConfidenceResult.blocking`;
// here the keystone manifests as this hard cap plus a `blocking` finding.
export const EVALS_KEYSTONE_CAP = 55;

/** Half-credit for a description that carries a prose verification path but no
 *  structured acceptance criteria. Below the keystone bar (still no AC) but above
 *  zero, so "verify via `curl ...`" is not scored identically to silence. */
const EVALS_PARTIAL_POINTS = Math.round(FIELD_WEIGHTS.evals / 2);

// Vague terms used by ambiguityRisk (overlay §"Ambiguity Risk").
// Hits lower the subscore (start 100, -10 per hit, floor 0).
const VAGUE_TERMS = [
  "fix", "improve", "optimize", "clean up",
  "somehow", "quickly", "simple", "modernize",
];

const VAGUE_TERM_PATTERN = new RegExp(
  "\\b(" + VAGUE_TERMS.map((t) => t.replace(/\s+/g, "\\s+")).join("|") + ")\\b",
  "gi",
);

// Heuristics that drive subscores. None of these are perfect; calibration
// is owned by Milestone 5. Each dimension returns 0..100.
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
  if (/[a-zA-Z_][a-zA-Z0-9_]*\.[a-z]{1,4}\b/.test(desc)) anchors++; // file refs
  if (/\/[a-zA-Z_]/.test(desc)) anchors++;                          // paths
  if (/`[^`]+`/.test(desc)) anchors++;                              // inline code
  if (/https?:\/\//.test(desc)) anchors++;                          // URLs
  if (/\d{2,}/.test(desc)) anchors++;                               // numbers
  const concreteness = Math.min(anchors * 25, 100);

  // ── testability: AC present → 100, else partial credit for test-flavoured language
  let testability = 0;
  if (acPresent) testability = 100;
  else if (/\b(test|verify|expect|assert|should|given|when|then)\b/i.test(desc)) testability = 60;

  // ── scopeClarity: constraints present → 100, else partial for scope markers
  let scopeClarity = 0;
  if (consPresent) scopeClarity = 100;
  else if (/\b(in scope|out of scope|do not|only|keep|non-goal|don't change)\b/i.test(desc)) scopeClarity = 60;

  // ── contextQuality: context present → 100, else ramp on description length
  let contextQuality = 0;
  if (ctxPresent) contextQuality = 100;
  else if (descPresent) contextQuality = Math.min(Math.round((desc.length / 300) * 70), 70);

  // ── structure: description's line count + list markers
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

  // ── ambiguityRisk: start 100, -10 per vague hit, floor 0.
  //    Higher = less risky. The subscore is the *inverse* of risk: 100 = no
  //    vague terms, 0 = many. Naming follows the overlay (subscore "score",
  //    where more = better, even though the dimension is called *Risk*).
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

// Mapping from a missing field to its QualityFinding shape. Stable codes/messages
// so consumers (the 422 response, create-time surfacing, the UI) can render them
// as-is. Severity reflects how load-bearing the field is for weak-agent
// executability: `acceptanceCriteria` and `agentPrompt` are keystones (see
// buildFindings for the keystone state machine); the executability boundaries
// (scope/outOfScope/dependencies/risk) are advisory. `context`/`constraints` are
// no longer scored (superseded by the executability fields) so they never appear
// in `missing` and have no entry here.
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
  // acceptanceCriteria severity/keystone are decided in buildFindings from the
  // evals keystone state; this entry holds the hard-keystone wording.
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
    // The evals (acceptanceCriteria) keystone is hard-blocking ONLY when the
    // task has no verification path at all. When the description carries a prose
    // verification signal but no structured AC, downgrade to a non-keystone
    // warning: the task is gradable, just not crisply.
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
  // Subscore-driven warnings, only when the description exists (otherwise
  // missing_or_thin_description already covers it).
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

// Verification signal: anything that gives an agent or reviewer a way to
// know the task is done. AC presence already counts; the regex catches the
// common "verification path in prose" patterns.
const VERIFICATION_SIGNAL_PATTERN = /\b(test|run|curl|check|verify|green|CI)\b/i;

interface CapRule {
  cap: number;
  applies: boolean;
  code: string;
  dimension: QualityDimension;
  message: string;
}

// Deterministic score caps from overlay §"Important: Add Score Caps".
// Each cap is an upper bound on the final score; the strictest applicable
// cap wins, but every triggering cap is surfaced as a finding.
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

  const verificationSignal = acPresent || (descPresent && VERIFICATION_SIGNAL_PATTERN.test(desc));
  // The hard evals keystone: no acceptance criteria AND no prose verification
  // path. There is no way to know the task is done. Cap ABSOLUTE below the
  // default threshold so even a task with every OTHER field filled cannot pass
  // on field-count alone.
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
      cap: 40, applies: !descPresent,
      code: "missing_or_thin_description", dimension: "structure",
      message: "Score capped at 40: description is empty.",
    },
    // ── Evals keystone (scorer-v2, T3) ──────────────────────────────────────
    // Replaces the v1 template-gated goal(70)/acceptanceCriteria(80) caps and the
    // softer missing_verification(85) cap. This cap is template-INDEPENDENT and
    // sits below the default threshold (60), so an evals-absent task blocks at the
    // default. The blocking finding it merges into carries `keystone: true`
    // (emitted by buildFindings); T5's gate wiring reads `ConfidenceResult.blocking`
    // to enforce it even when a project lowers its threshold.
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
    // ── Subscore-driven caps (scorer-v2, T1) ────────────────────────────────
    // computeSubscores already derives testability / scopeClarity /
    // concreteness, but until now those numbers were descriptive only and never
    // moved the score. Promote them into the cap layer so an un-verifiable,
    // unscoped, or unanchored task is held below the top band — the signal a
    // weak agent needs. Ceilings sit at/above the default confidenceThreshold
    // (60), so a task that already passed at the default does NOT newly fail;
    // a project on a higher threshold sees the stricter bar by design.
    // Per-project warn/block enforcement is a later slice; here the effect is a
    // lower score plus a surfaced finding (observability).
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

export function calculateConfidence(input: ConfidenceInput): ConfidenceResult {
  const td = input.templateData;
  const has = (v?: string | null) => (v?.trim().length ?? 0) > 0;
  const desc = input.description ?? "";
  const descTrim = desc.trim();
  const descQuality = descriptionQuality(desc);

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
  // `dependencies` is satisfied by any non-empty text, including the literal
  // "none" — explicitly declaring no prerequisite is a positive signal, not a
  // miss. (Satisfying it via the dependsOn[] graph edge is a follow-up; the
  // scorer is a pure function and does not yet receive the edge set.)
  const dependenciesPresent = present("dependencies");
  const riskPresent = present("risk");
  const agentPromptPresent = present("agentPrompt");

  const verificationSignal = descTrim.length > 0 && VERIFICATION_SIGNAL_PATTERN.test(descTrim);
  const evalsKeystoneViolated = !acPresent && !verificationSignal;

  // ── Fixed-denominator additive score ──────────────────────────────────────
  // maxPossible is a constant 100 (FIELD_WEIGHTS sums to 100), so the score is
  // template-INDEPENDENT — the v1 denominator dilution is gone.
  const W = FIELD_WEIGHTS;
  let earned = 0;
  if (titlePresent) earned += W.title;
  earned += Math.round(W.description * descQuality); // proportional, like v1
  if (goalPresent) earned += W.goal;
  if (acPresent) earned += W.evals;
  else if (verificationSignal) earned += EVALS_PARTIAL_POINTS; // prose path, no AC
  if (scopePresent) earned += W.scope;
  if (outOfScopePresent) earned += W.outOfScope;
  if (dependenciesPresent) earned += W.dependencies;
  if (riskPresent) earned += W.risk;
  if (agentPromptPresent) earned += W.agentPrompt;

  const rawScore = Math.max(0, Math.min(100, earned));

  // missing[]: every absent core field, in surfacing-priority order.
  const missing: string[] = [];
  if (!titlePresent) missing.push("title");
  if (descQuality < 0.4) missing.push("description");
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

  // Merge cap findings into the rule-driven list. When a code already
  // exists (e.g. rule-driven `missing_acceptance_criteria` is `blocking`
  // and the cap also fires `missing_acceptance_criteria` as `warning`),
  // keep the higher-severity rule entry but enrich its suggestion with
  // the cap ceiling so the consumer still sees the score-cap info.
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

  // Ops visibility: emit a single info-level line when a cap actually
  // lowered the additive score. Structured-ish so ops can grep + parse.
  // Full audit-event wiring (claim_blocked_low_readiness etc.) is owned
  // by follow-up 180e5655.
  if (cappedScore < rawScore) {
    console.info(
      `confidence.score_capped raw=${rawScore} capped=${cappedScore} caps=[${capFindings.map((f) => f.code).join(",")}]`,
    );
  }

  // Threshold-INDEPENDENT keystone signal for T5's gate wiring: true when a
  // hard keystone is violated (today: the evals keystone). agentPrompt is a
  // warning-severity keystone and deliberately does NOT set this flag.
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
