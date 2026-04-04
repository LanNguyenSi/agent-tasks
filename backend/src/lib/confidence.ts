import { z } from "zod";

// ── Zod Schemas ─────────────────────────────────────────────────────────────

export const templatePresetSchema = z.object({
  name: z.string().min(1).max(100),
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

// ── Confidence Scoring ──────────────────────────────────────────────────────

interface ConfidenceInput {
  title: string;
  description: string | null;
  templateData: TemplateData | null;
}

interface ConfidenceResult {
  score: number;
  missing: string[];
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
