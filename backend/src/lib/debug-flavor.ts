// Debug-flavored task detection for grounding-hint integration.
//
// When the next task an agent picks up looks like a bug, incident, or
// investigation, we want the agent to start in scope-resolution (via the
// grounding stack) rather than diving straight into code. This module
// detects that flavor from the task's title, description, and labels.
//
// Phase 1: detect + persist `task.metadata.debugFlavor`. The auto-start
// of a grounding session and the finish-gate on evidence-ledger entries
// land in follow-up phases.

const DEBUG_KEYWORDS = [
  "bug",
  "incident",
  "regression",
  "outage",
  "root cause",
  "debug",
  "investigate",
  "not working",
  "broken",
  "failing",
  "hotfix",
];

const DEBUG_LABELS = ["bug", "incident", "hotfix", "regression"];

const WORD_BOUNDARY_KEYWORDS = new Set(["bug", "debug", "broken", "failing"]);

export interface DebugFlavorInput {
  title: string;
  description: string | null | undefined;
  labels: readonly string[] | null | undefined;
}

export function detectDebugFlavor(input: DebugFlavorInput): boolean {
  const text = `${input.title} ${input.description ?? ""}`.toLowerCase();

  for (const keyword of DEBUG_KEYWORDS) {
    if (WORD_BOUNDARY_KEYWORDS.has(keyword)) {
      const re = new RegExp(`\\b${keyword}\\b`);
      if (re.test(text)) return true;
    } else if (text.includes(keyword)) {
      return true;
    }
  }

  const labels = input.labels ?? [];
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));
  for (const label of DEBUG_LABELS) {
    if (labelSet.has(label)) return true;
  }

  return false;
}

export interface GroundingHint {
  debugFlavor: true;
  recommendedAction: string;
  mcpToolHint: string;
}

export function buildGroundingHint(task: { title: string; project: { slug: string } }): GroundingHint {
  return {
    debugFlavor: true,
    recommendedAction:
      "This task looks like a bug, incident, or investigation. Start a grounding session before reading code so you resolve scope first instead of jumping into the implementation.",
    mcpToolHint: `mcp__grounding__grounding_start with keyword="${task.project.slug}", problem="${task.title.replace(/"/g, '\\"')}"`,
  };
}

export interface TaskMetadata {
  debugFlavor?: boolean;
  groundingSessionId?: string;
}

export function readMetadata(value: unknown): TaskMetadata {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as TaskMetadata;
  }
  return {};
}
