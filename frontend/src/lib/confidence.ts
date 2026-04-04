export interface TemplateData {
  goal?: string;
  acceptanceCriteria?: string;
  context?: string;
  constraints?: string;
}

export interface TemplateFields {
  goal?: boolean;
  acceptanceCriteria?: boolean;
  context?: boolean;
  constraints?: boolean;
}

export interface ConfidenceResult {
  score: number;
  missing: string[];
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

// ── Confidence Scoring ──────────────────────────────────────────────────────

interface ConfidenceInput {
  title: string;
  description: string | null;
  templateData: TemplateData | null;
  templateFields?: TemplateFields | null;
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

  const score = maxPossible > 0 ? Math.round((earned / maxPossible) * 100) : 100;

  return { score, missing };
}
