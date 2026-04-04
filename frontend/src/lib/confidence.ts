export interface TemplateData {
  goal?: string;
  acceptanceCriteria?: string;
  context?: string;
  constraints?: string;
}

export interface ConfidenceResult {
  score: number;
  missing: string[];
}

interface ConfidenceInput {
  title: string;
  description: string | null;
  templateData: TemplateData | null;
}

const RULES: { field: string; points: number; check: (input: ConfidenceInput) => boolean }[] = [
  {
    field: "title",
    points: 20,
    check: (input) => input.title.trim().length > 0,
  },
  {
    field: "description",
    points: 15,
    check: (input) => (input.description?.trim().length ?? 0) > 50,
  },
  {
    field: "goal",
    points: 20,
    check: (input) => (input.templateData?.goal?.trim().length ?? 0) > 0,
  },
  {
    field: "acceptanceCriteria",
    points: 25,
    check: (input) => (input.templateData?.acceptanceCriteria?.trim().length ?? 0) > 0,
  },
  {
    field: "context",
    points: 10,
    check: (input) => (input.templateData?.context?.trim().length ?? 0) > 0,
  },
  {
    field: "constraints",
    points: 10,
    check: (input) => (input.templateData?.constraints?.trim().length ?? 0) > 0,
  },
];

export function calculateConfidence(input: ConfidenceInput): ConfidenceResult {
  let score = 0;
  const missing: string[] = [];

  for (const rule of RULES) {
    if (rule.check(input)) {
      score += rule.points;
    } else {
      missing.push(rule.field);
    }
  }

  return { score, missing };
}
