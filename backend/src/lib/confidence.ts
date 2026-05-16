import { z } from "zod";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

export const templatePresetSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  goal: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  context: z.string().optional(),
  constraints: z.string().optional(),
});

export type TemplatePreset = z.infer<typeof templatePresetSchema>;

export const taskTemplateSchema = z.object({
  fields: z.object({
    goal: z.boolean().default(false),
    acceptanceCriteria: z.boolean().default(false),
    context: z.boolean().default(false),
    constraints: z.boolean().default(false),
  }),
  presets: z.array(templatePresetSchema).max(20).default([]),
});

export type TaskTemplate = z.infer<typeof taskTemplateSchema>;

export const templateDataSchema = z.object({
  goal: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  context: z.string().optional(),
  constraints: z.string().optional(),
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

// ── Confidence Scoring ──────────────────────────────────────────────────────

export interface TemplateFields {
  goal?: boolean;
  acceptanceCriteria?: boolean;
  context?: boolean;
  constraints?: boolean;
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
}

interface Rule {
  field: string;
  points: number;
  templateField?: keyof TemplateFields;
  check: (input: ConfidenceInput) => boolean;
}

const RULES: Rule[] = [
  {
    field: "title",
    points: 20,
    check: (input) => input.title.trim().length > 0,
  },
  {
    field: "description",
    points: 15,
    check: (input) => descriptionQuality(input.description ?? "") >= 0.4,
  },
  {
    field: "goal",
    points: 20,
    templateField: "goal",
    check: (input) => (input.templateData?.goal?.trim().length ?? 0) > 0,
  },
  {
    field: "acceptanceCriteria",
    points: 25,
    templateField: "acceptanceCriteria",
    check: (input) => (input.templateData?.acceptanceCriteria?.trim().length ?? 0) > 0,
  },
  {
    field: "context",
    points: 10,
    templateField: "context",
    check: (input) => (input.templateData?.context?.trim().length ?? 0) > 0,
  },
  {
    field: "constraints",
    points: 10,
    templateField: "constraints",
    check: (input) => (input.templateData?.constraints?.trim().length ?? 0) > 0,
  },
];

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

// Mapping from rule field misses to QualityFinding shape. Codes come from
// overlay §"Example Finding Codes"; messages/suggestions are short and stable
// so the 422-response task (180e5655) can surface them as-is.
const MISS_FINDINGS: Record<string, { code: string; dimension: QualityDimension; message: string; suggestion: string }> = {
  title:              { code: "missing_title",                dimension: "completeness",   message: "Title is empty.",                                  suggestion: "Add a short imperative title naming the change." },
  description:        { code: "missing_or_thin_description",  dimension: "structure",      message: "Description is missing or below quality threshold.", suggestion: "Add a short Context and Goal section with concrete anchors." },
  goal:               { code: "missing_goal",                 dimension: "completeness",   message: "Goal is missing.",                                  suggestion: "Add a one-line Goal stating the intended outcome." },
  acceptanceCriteria: { code: "missing_acceptance_criteria",  dimension: "testability",    message: "Acceptance criteria are missing.",                  suggestion: "Add 2-5 bullets describing observable completion conditions." },
  context:            { code: "missing_context",              dimension: "contextQuality", message: "Context is missing.",                               suggestion: "Add the user impact, related incident, or business reason." },
  constraints:        { code: "missing_constraints",          dimension: "scopeClarity",   message: "Constraints / scope boundary are missing.",         suggestion: "Add 'in scope', 'out of scope', or 'do not change ...' lines." },
};

function buildFindings(missing: string[], subscores: TaskQualitySubscores, descPresent: boolean): QualityFinding[] {
  const findings: QualityFinding[] = [];
  for (const field of missing) {
    const tpl = MISS_FINDINGS[field];
    if (tpl) {
      findings.push({ code: tpl.code, severity: "blocking", dimension: tpl.dimension, message: tpl.message, suggestion: tpl.suggestion });
    }
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
): { cappedScore: number; capFindings: QualityFinding[] } {
  const desc = (input.description ?? "").trim();
  const td = input.templateData;
  const tf = input.templateFields;

  const has = (v?: string | null) => (v?.trim().length ?? 0) > 0;
  const titlePresent = input.title.trim().length > 0;
  const descPresent = desc.length > 0;
  const goalPresent = has(td?.goal);
  const acPresent = has(td?.acceptanceCriteria);
  const consPresent = has(td?.constraints);

  const verificationSignal = acPresent || (descPresent && VERIFICATION_SIGNAL_PATTERN.test(desc));
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
      cap: 70, applies: tf?.goal === true && !goalPresent,
      code: "missing_goal", dimension: "completeness",
      message: "Score capped at 70: goal is missing.",
    },
    {
      cap: 80, applies: tf?.acceptanceCriteria === true && !acPresent,
      code: "missing_acceptance_criteria", dimension: "testability",
      message: "Score capped at 80: acceptance criteria are missing.",
    },
    {
      cap: 85, applies: !acPresent && !consPresent && !verificationSignal,
      code: "missing_verification", dimension: "testability",
      message: "Score capped at 85: no verification path (no acceptance criteria, no constraints, no test/run/curl/check/verify/CI signal in description).",
    },
    {
      cap: 75, applies: ambiguityHits >= 3 && !hasConcrete,
      code: "ambiguous_scope", dimension: "ambiguityRisk",
      message: `Score capped at 75: ${ambiguityHits} vague terms with no concrete anchors (file path, URL, inline code, or number).`,
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
  const activeRules = RULES.filter((rule) => {
    if (!rule.templateField) return true;
    return input.templateFields?.[rule.templateField] === true;
  });

  let earned = 0;
  let maxPossible = 0;
  const missing: string[] = [];

  for (const rule of activeRules) {
    maxPossible += rule.points;
    if (rule.field === "description") {
      // Description earns proportional points based on quality
      const quality = descriptionQuality(input.description ?? "");
      const descPoints = Math.round(rule.points * quality);
      earned += descPoints;
      if (quality < 0.4) missing.push(rule.field);
    } else if (rule.check(input)) {
      earned += rule.points;
    } else {
      missing.push(rule.field);
    }
  }

  const rawScore = maxPossible > 0 ? Math.round((earned / maxPossible) * 100) : 100;
  const subscores = computeSubscores(input);
  const findings = buildFindings(missing, subscores, (input.description?.trim().length ?? 0) > 0);

  const { cappedScore, capFindings } = applyScoreCaps(rawScore, input, subscores);

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

  return { score: cappedScore, missing, subscores, findings };
}
