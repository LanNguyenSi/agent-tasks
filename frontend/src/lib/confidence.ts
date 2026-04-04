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
    check: (input) => (input.description?.trim().length ?? 0) > 50,
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
    if (rule.check(input)) {
      earned += rule.points;
    } else {
      missing.push(rule.field);
    }
  }

  const score = maxPossible > 0 ? Math.round((earned / maxPossible) * 100) : 100;

  return { score, missing };
}
