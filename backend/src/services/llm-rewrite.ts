// LLM rewrite helper (M4, task fc4f2dc7). Advisory only, per ADR-0011: this
// module NEVER mutates a task, NEVER calls any agent-tasks verb (task_finish,
// task_start, or any other mutating action), and is not wired into any tool
// loop -- it is a single, tool-less text-completion call that returns a
// proposed description for the caller (route handler) to display. Applying
// a suggestion is a separate, explicit PATCH /tasks/:id the caller makes
// after a human reviews the diff.
//
// Structured the same way as services/grounding-client.ts: a small
// interface (LlmRewriteClient) + a real implementation + a cached factory
// gated on configuration, so route tests can mock the whole module and
// service tests can inject a fake `createMessage` function without touching
// the real Anthropic SDK or network.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../lib/logger.js";
import type { QualityFinding } from "../lib/confidence.js";

// Read directly from process.env rather than the typed `config` module
// (config/index.ts): that module validates its FULL schema (DATABASE_URL,
// SESSION_SECRET, ...) at import time and process.exit(1)s if anything is
// missing, which would make importing this file (transitively, via
// routes/tasks.ts) a hard crash for every test that doesn't set up the
// entire app config. ANTHROPIC_API_KEY / AGENT_TASKS_REWRITE_MODEL are
// optional, feature-scoped settings -- same posture as
// AGENT_TASKS_DISABLE_GROUNDING in services/grounding-client.ts and
// WEBHOOK_ALLOWED_PRIVATE_HOSTS in services/notification-webhook.ts, both
// of which read process.env directly for the same reason.
const DEFAULT_MODEL = "claude-haiku-4-5";

export interface RewriteSuggestionInput {
  title: string;
  description: string | null;
  findings: QualityFinding[];
}

export interface RewriteSuggestion {
  suggestion: string;
  changedSignals: string[];
}

export interface LlmRewriteClient {
  suggestRewrite(input: RewriteSuggestionInput): Promise<RewriteSuggestion>;
}

/** Thrown when the model's response cannot be parsed into the expected
 *  `{ suggestion: string, changedSignals: string[] }` shape. The route maps
 *  this to a 502 -- a malformed LLM response is a visible server-side
 *  failure, never silently swallowed into a misleading suggestion. */
export class RewriteSuggestionParseError extends Error {}

/**
 * Builds the prompt sent to the model. Deliberately includes every finding
 * (code/severity/dimension/message/suggestion) so the rewrite actually
 * targets the missing signals the confidence scorer flagged -- this is the
 * whole point of the endpoint (ADR-0011: address findings, never gate on
 * them). Keep the findings block un-elided; the M4 mutation probe pins this
 * (removing findings from the prompt must fail the probe's test).
 */
function buildPrompt(input: RewriteSuggestionInput): string {
  const findingsBlock =
    input.findings.length > 0
      ? input.findings
          .map(
            (f) =>
              `- [${f.severity}/${f.dimension}] ${f.code}: ${f.message}` +
              (f.suggestion ? ` (suggested fix: ${f.suggestion})` : ""),
          )
          .join("\n")
      : "(no open findings)";

  return [
    "You are an assistant that rewrites task descriptions for a software team's task tracker.",
    "Your ONLY job is to propose an improved description in your response text. You never call a tool, never take any other action, and nothing you output is applied automatically -- a human reviews your suggestion before anything changes.",
    "",
    "The task currently has these quality findings; a good rewrite addresses as many as reasonably possible:",
    findingsBlock,
    "",
    `Current title: ${input.title}`,
    "Current description:",
    input.description && input.description.trim().length > 0 ? input.description : "(empty)",
    "",
    "Rewrite the description so it resolves the findings above while staying faithful to the original intent. Keep it concise and concrete (goal, acceptance criteria, scope).",
    "",
    'Respond with ONLY a single JSON object, no markdown code fences, no commentary before or after it, of the exact shape: {"suggestion": string, "changedSignals": string[]}.',
    '"suggestion" is the full rewritten description text.',
    '"changedSignals" lists the finding `code` values (from the findings above) that your rewrite addresses.',
  ].join("\n");
}

/** Defensive: models occasionally wrap JSON in a ```json fence despite
 *  being told not to. Strip a single leading/trailing fence if present. */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

function parseSuggestion(raw: string): RewriteSuggestion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (err) {
    throw new RewriteSuggestionParseError(
      `LLM response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new RewriteSuggestionParseError("LLM response JSON was not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.suggestion !== "string") {
    throw new RewriteSuggestionParseError("LLM response JSON missing string field 'suggestion'");
  }
  if (!Array.isArray(obj.changedSignals) || !obj.changedSignals.every((s) => typeof s === "string")) {
    throw new RewriteSuggestionParseError("LLM response JSON missing string[] field 'changedSignals'");
  }

  return { suggestion: obj.suggestion, changedSignals: obj.changedSignals as string[] };
}

// Narrow injection seam: only the one Anthropic call shape this service
// needs, so tests can supply a fake without constructing (or mocking) the
// whole SDK client.
type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export class AnthropicLlmRewriteClient implements LlmRewriteClient {
  constructor(
    private readonly createMessage: CreateMessageFn,
    private readonly model: string,
  ) {}

  async suggestRewrite(input: RewriteSuggestionInput): Promise<RewriteSuggestion> {
    const response = await this.createMessage({
      model: this.model,
      max_tokens: 1536,
      messages: [{ role: "user", content: buildPrompt(input) }],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    return parseSuggestion(textBlock?.text ?? "");
  }
}

// Module-cached instance. `undefined` = not yet resolved, `null` = resolved
// to "not configured" (a real, sticky answer -- distinct from "haven't
// checked yet" so a missing key doesn't get re-probed on every request).
let cached: LlmRewriteClient | null | undefined;

/**
 * Returns null when no ANTHROPIC_API_KEY is configured. The route maps
 * that to a 503 ("LLM rewrite helper is not configured on this server")
 * -- this deliberately checks the explicit env var rather than letting the
 * Anthropic SDK fall back to some other ambient credential source (an
 * `ant auth login` profile, WIF env vars, ...): this is a headless server
 * process, so "no key set" must fail loud, not resolve to whatever happens
 * to be on the host. Model is configurable via AGENT_TASKS_REWRITE_MODEL,
 * defaulting to claude-haiku-4-5 -- Anthropic's current cheap/fast tier,
 * cost-appropriate for a low-stakes advisory suggestion (ADR-0011: LLMs
 * are advisory only, never gating).
 */
export function getLlmRewriteClient(): LlmRewriteClient | null {
  if (cached !== undefined) return cached;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    cached = null;
    return cached;
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    cached = new AnthropicLlmRewriteClient(
      (params) => anthropic.messages.create(params),
      process.env.AGENT_TASKS_REWRITE_MODEL || DEFAULT_MODEL,
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Anthropic client construction failed; LLM rewrite helper disabled",
    );
    cached = null;
  }

  return cached;
}

// Test-only: reset the cache so a config/env change between test cases is
// picked up. Not exported through any package barrel.
export function __resetLlmRewriteClientCacheForTests(): void {
  cached = undefined;
}
