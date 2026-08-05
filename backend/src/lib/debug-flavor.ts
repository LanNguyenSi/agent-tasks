// Debug-flavored task detection for grounding-hint integration.
//
// When the next task an agent picks up looks like a bug, incident, or
// investigation, we want the agent to start in scope-resolution (via the
// grounding stack) rather than diving straight into code. This module
// detects that flavor from the task's title, description, and labels.
//
// Phase 1: detect + persist `task.metadata.debugFlavor` (this module).
// Phase 2: auto-start a grounding session via the wrapper's
// GroundingClient and persist its session id/state (implemented in
// backend/src/routes/tasks.ts; see `deriveDebugFlavor` and
// `reconstructSessionFromMetadata`). Phase 3: the finish-gate on
// evidence-ledger entries (implemented in backend/src/routes/tasks.ts,
// task_finish handler, "Phase 3 grounding finish-gate"; reads state via
// `getSessionPhase` below). All three phases are implemented.

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

// Suppression labels: tasks tagged with one of these are deliberate
// non-debug work (docs, refactors, polish, features, releases, test
// scaffolding). They override the keyword heuristic so a docs task whose
// description happens to mention a debug-keyword word (e.g. "this how-to
// covers broken-state recovery") is not auto-classified as debug-flavored.
// Explicit DEBUG_LABELS still win, so a task labelled [docs, bug] is still
// a bug.
const DEBUG_SUPPRESS_LABELS = [
  "docs",
  "how-to",
  "polish",
  "chore",
  "refactor",
  "style",
  "enhancement",
  "feature",
  "release",
  "test",
];

// Conventional-commit-style type prefixes that mark a task as typed,
// non-investigation work. A title like `chore(deps): regression in the
// lockfile` merely *mentions* a debug keyword while describing typed
// maintenance work; the `chore:` prefix is the author's deliberate type
// signal, the same kind of signal a suppression label is. `fix` is
// deliberately EXCLUDED — a `fix:` task is bug work and must stay
// scannable. `revert` is excluded too: reverts often happen mid-incident.
const SUPPRESS_TITLE_TYPES = [
  "feat",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "release",
];

// Matches a leading conventional-commit type token, an optional
// `(scope)`, an optional `!` breaking-change marker, then `:`. Anchored
// and case-insensitive: a title that merely contains a colon but no type
// token (e.g. "Phase 7 #2: Action Envelope") is NOT a typed prefix and
// is not suppressed. `feature:` is likewise not matched — only the
// conventional `feat` token is, and "feat" is not a prefix of "feature:"
// up to the required `:`.
const SUPPRESS_TITLE_PREFIX_RE = new RegExp(
  `^(?:${SUPPRESS_TITLE_TYPES.join("|")})(?:\\([^)]*\\))?!?:`,
  "i",
);

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
  const labels = input.labels ?? [];
  const labelSet = new Set(labels.map((l) => l.toLowerCase()));

  // Explicit debug labels always win: they are deliberate human classification.
  for (const label of DEBUG_LABELS) {
    if (labelSet.has(label)) return true;
  }

  // Suppression labels override the keyword heuristic, since these tasks
  // are not debug work even when their descriptions mention
  // debug-keyword'd words.
  for (const label of DEBUG_SUPPRESS_LABELS) {
    if (labelSet.has(label)) return false;
  }

  // Title-shape suppression: a conventional-commit non-debug type prefix
  // (`feat:`, `chore(deps):`, `docs!:`, `release:`, ...) is the author
  // declaring typed, non-investigation work — the same deliberate signal
  // a suppression label gives. `fix:` is not in the set, so bug-fix
  // tasks stay scannable. Explicit DEBUG_LABELS above still win.
  if (SUPPRESS_TITLE_PREFIX_RE.test(input.title.trimStart())) return false;

  const text = `${input.title} ${input.description ?? ""}`.toLowerCase();
  for (const keyword of DEBUG_KEYWORDS) {
    const re = WORD_BOUNDARY_REGEXES.get(keyword);
    if (re) {
      if (re.test(text)) return true;
    } else if (text.includes(keyword)) {
      return true;
    }
  }

  return false;
}

export interface GroundingHint {
  debugFlavor: true;
  recommendedAction: string;
  mcpToolHint: string;
  // Phase 2 additions, only set when the backend successfully started a
  // session via the GroundingClient. Phase 1 fallback hints leave them
  // undefined. Named `backendSessionRef` rather than `sessionId`: this id
  // was minted in-process by the wrapper, not by the real grounding-mcp
  // MCP server, so it is not usable as an argument to any grounding-mcp
  // tool (which all take a `sessionId` for a server-minted session). The
  // distinct field name keeps it from being mistaken for one at a glance,
  // even though the value is still useful for forensic/debugging purposes.
  backendSessionRef?: string;
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
    mcpToolHint: `mcp__grounding-mcp__grounding_start with keyword="${escapeForToolHint(task.project.slug)}", problem="${escapeForToolHint(task.title)}"`,
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

// Phase 2: the backend has already started a grounding session for this
// task via the GroundingClient and persisted its id/state (the Phase-3
// finish-gate in `getSessionPhase` below reads that persisted state). But
// that session was minted in-process by the wrapper — the real grounding-mcp
// MCP server the agent talks to has never seen that session id, so a hint
// telling the agent to `grounding_advance` it would fail with "session not
// found". Instead this reuses the same `grounding_start` recipe as Phase 1
// (same keyword/problem, same escaping), which the agent's own tools can
// actually follow. The session fields are still surfaced on the returned
// hint for callers that want them (e.g. the Phase-3 gate reads persisted
// metadata directly, not this return value).
export function buildGroundingHintWithSession(
  task: { title: string; project: { slug: string } },
  session: GroundingSessionFields,
): GroundingHint {
  const base = buildGroundingHint(task);
  return {
    ...base,
    recommendedAction:
      "This task looks like a bug, incident, or investigation. Start a grounding session before reading code so you resolve scope first instead of jumping into the implementation. The backend tracks session state for this task internally, but that session isn't addressable from your tools. Use the recipe below to start your own.",
    backendSessionRef: session.sessionId,
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

// Phase 3: read the grounding session's current phase from the persisted
// `groundingSessionState` blob. Pure function on top of the metadata we
// already store: deliberately NOT a method on GroundingClient because that
// would require reading grounding-mcp's session-store from the backend,
// which is unworkable in a multi-host deployment where the wrapper runs
// on the agent's machine. The session JSON we persisted at start time is good
// enough for this gate; the agent advances the phase in-process and a
// follow-up `task_advance_phase` (or similar) would push the new state back
// to the backend.
export function getSessionPhase(metadata: TaskMetadata): { currentPhase: string | null } {
  const state = metadata.groundingSessionState;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const phase = (state as Record<string, unknown>).current_phase;
    if (typeof phase === "string" && phase.length > 0) {
      return { currentPhase: phase };
    }
  }
  return { currentPhase: null };
}
