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

// Keywords match against a lowercased "title + description" string. Short,
// generic words (bug / debug / broken / failing) are word-boundaried so
// `Debugger` doesn't match `bug`; the rest match as substrings so phrases
// like "root cause" and conjugated stems like "regressions" / "hotfixing"
// still hit. Inflected forms of the word-boundaried set ("debugging",
// "broke", "fails") deliberately do NOT match — keep titles in the noun
// form, or add labels.
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

// Labels are matched exactly (case-insensitive). Different semantics from
// keywords: a label of "bug" is a deliberate human classification, so
// substring matching wouldn't make sense here.
const DEBUG_LABELS = ["bug", "incident", "hotfix", "regression"];

const WORD_BOUNDARY_KEYWORDS = new Set(["bug", "debug", "broken", "failing"]);

// Pre-compile the word-boundary regexes once at module load.
const WORD_BOUNDARY_REGEXES: ReadonlyMap<string, RegExp> = new Map(
  [...WORD_BOUNDARY_KEYWORDS].map((kw) => [kw, new RegExp(`\\b${kw}\\b`)]),
);

export interface DebugFlavorInput {
  title: string;
  description: string | null | undefined;
  labels: readonly string[] | null | undefined;
}

export function detectDebugFlavor(input: DebugFlavorInput): boolean {
  const text = `${input.title} ${input.description ?? ""}`.toLowerCase();

  for (const keyword of DEBUG_KEYWORDS) {
    const re = WORD_BOUNDARY_REGEXES.get(keyword);
    if (re) {
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
  // Phase 2 additions, only set when the backend successfully started a
  // session via the GroundingClient. Phase 1 fallback hints leave them
  // undefined.
  sessionId?: string;
  currentPhase?: string;
  mandatorySequence?: string[];
  activeGuardrails?: string[];
}

// Escape characters that would break a single-line MCP-tool-hint string
// when an agent or human pastes it: backslashes first, then quotes, then
// the line-terminating whitespace, then backticks (some clients treat the
// hint as code-fenced).
function escapeForToolHint(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/`/g, "\\`");
}

export function buildGroundingHint(task: { title: string; project: { slug: string } }): GroundingHint {
  return {
    debugFlavor: true,
    recommendedAction:
      "This task looks like a bug, incident, or investigation. Start a grounding session before reading code so you resolve scope first instead of jumping into the implementation.",
    mcpToolHint: `mcp__grounding__grounding_start with keyword="${escapeForToolHint(task.project.slug)}", problem="${escapeForToolHint(task.title)}"`,
  };
}

// Shape we accept for the `session` parameter. Kept independent of
// `GroundingStartResult` in services/grounding-client to avoid a layering
// cycle between the lib (used by routes) and services.
export interface GroundingSessionFields {
  sessionId: string;
  currentPhase: string;
  mandatorySequence: string[];
  activeGuardrails: string[];
}

// Phase 2: produce a hint that surfaces the session that the backend just
// initialized via the GroundingClient. The agent uses these fields to
// advance the session via `mcp__grounding__grounding_advance`.
export function buildGroundingHintWithSession(
  _task: { title: string; project: { slug: string } },
  session: GroundingSessionFields,
): GroundingHint {
  return {
    debugFlavor: true,
    recommendedAction:
      "This task looks like a bug, incident, or investigation. The backend has already started a grounding session for you. Advance through the mandatory sequence before claiming a root cause.",
    mcpToolHint: `mcp__grounding__grounding_advance(sessionId="${escapeForToolHint(session.sessionId)}")`,
    sessionId: session.sessionId,
    currentPhase: session.currentPhase,
    mandatorySequence: session.mandatorySequence,
    activeGuardrails: session.activeGuardrails,
  };
}

export interface TaskMetadata {
  debugFlavor?: boolean;
  groundingSessionId?: string;
  groundingSessionState?: unknown;
}

export function readMetadata(value: unknown): TaskMetadata {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as TaskMetadata;
  }
  return {};
}
