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
function computeSubscores(input: ConfidenceInput): TaskQualitySubscores {
  const desc = (input.description ?? "").trim();
  const td = input.templateData;
  const hasField = (v?: string | null) => (v?.trim().length ?? 0) > 0;

  const titlePresent = input.title.trim().length > 0;
  const goalPresent = hasField(td?.goal);
  const acPresent = hasField(td?.acceptanceCriteria);
  const ctxPresent = hasField(td?.context);
  const consPresent = hasField(td?.constraints);
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
): { cappedScore: number; capFindings: QualityFinding[] } {
  const desc = (input.description ?? "").trim();
  const td = input.templateData;

  const has = (v?: string | null) => (v?.trim().length ?? 0) > 0;
  const titlePresent = input.title.trim().length > 0;
  const descPresent = desc.length > 0;
  const acPresent = has(td?.acceptanceCriteria);

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
      cap: 40, applies: !descPresent,
      code: "missing_or_thin_description", dimension: "structure",
      message: "Score capped at 40: description is empty.",
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

export function calculateConfidence(input: ConfidenceInput): ConfidenceResult {
  const td = input.templateData;
  const has = (v?: string | null) => (v?.trim().length ?? 0) > 0;
  const desc = input.description ?? "";
  const descTrim = desc.trim();
  const descQuality = descriptionQuality(desc);

  const titlePresent = input.title.trim().length > 0;
  const goalPresent = has(td?.goal);
  const acPresent = has(td?.acceptanceCriteria);
  const scopePresent = has(td?.scope);
  const outOfScopePresent = has(td?.outOfScope);
  const dependenciesPresent = has(td?.dependencies);
  const riskPresent = has(td?.risk);
  const agentPromptPresent = has(td?.agentPrompt);

  const verificationSignal = descTrim.length > 0 && VERIFICATION_SIGNAL_PATTERN.test(descTrim);
  const evalsKeystoneViolated = !acPresent && !verificationSignal;

  // ── Fixed-denominator additive score (maxPossible is a constant 100) ──────
  const W = FIELD_WEIGHTS;
  let earned = 0;
  if (titlePresent) earned += W.title;
  earned += Math.round(W.description * descQuality);
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
  if (descQuality < 0.4) missing.push("description");
  if (!goalPresent) missing.push("goal");
  if (!acPresent) missing.push("acceptanceCriteria");
  if (!scopePresent) missing.push("scope");
  if (!outOfScopePresent) missing.push("outOfScope");
  if (!dependenciesPresent) missing.push("dependencies");
  if (!riskPresent) missing.push("risk");
  if (!agentPromptPresent) missing.push("agentPrompt");

  const subscores = computeSubscores(input);
  const findings = buildFindings(missing, subscores, descTrim.length > 0, evalsKeystoneViolated);

  const { cappedScore, capFindings } = applyScoreCaps(rawScore, input, subscores);

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
