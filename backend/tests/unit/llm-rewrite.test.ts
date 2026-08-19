/**
 * Service-level tests for the M4 LLM rewrite helper
 * (services/llm-rewrite.ts, task fc4f2dc7).
 *
 * `AnthropicLlmRewriteClient` is tested directly against a fake
 * `createMessage` function -- no real Anthropic SDK call, no network. This
 * is also where the M4 mutation probe lives: "findings removed from the
 * prompt" must fail the "prompt contains findings" assertion below.
 *
 * `getLlmRewriteClient()` (the env-gated factory) is tested separately by
 * toggling `process.env.ANTHROPIC_API_KEY` around the module-level cache,
 * resetting the cache via `__resetLlmRewriteClientCacheForTests` between
 * cases so one test's env doesn't leak into the next.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  AnthropicLlmRewriteClient,
  RewriteSuggestionParseError,
  getLlmRewriteClient,
  __resetLlmRewriteClientCacheForTests,
  type RewriteSuggestionInput,
} from "../../src/services/llm-rewrite.js";
import type { QualityFinding } from "../../src/lib/confidence.js";

const FINDINGS: QualityFinding[] = [
  {
    code: "missing_acceptance_criteria",
    severity: "blocking",
    dimension: "completeness",
    message: "No acceptance criteria are present.",
    suggestion: "Add concrete, testable acceptance criteria.",
  },
  {
    code: "vague_scope",
    severity: "warning",
    dimension: "scopeClarity",
    message: "Scope is not clearly bounded.",
  },
];

const INPUT: RewriteSuggestionInput = {
  title: "Fix the thing",
  description: "It's broken, please fix.",
  findings: FINDINGS,
};

function fakeTextResponse(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text, citations: [] }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Anthropic.Message;
}

describe("AnthropicLlmRewriteClient.suggestRewrite", () => {
  it("returns the parsed { suggestion, changedSignals } from a well-formed JSON response", async () => {
    const createMessage = vi.fn().mockResolvedValue(
      fakeTextResponse(
        JSON.stringify({
          suggestion: "Rewritten description with acceptance criteria.",
          changedSignals: ["missing_acceptance_criteria"],
        }),
      ),
    );
    const client = new AnthropicLlmRewriteClient(createMessage, "claude-haiku-4-5");

    const result = await client.suggestRewrite(INPUT);

    expect(result).toEqual({
      suggestion: "Rewritten description with acceptance criteria.",
      changedSignals: ["missing_acceptance_criteria"],
    });
  });

  it("parses a response wrapped in a ```json code fence", async () => {
    const createMessage = vi.fn().mockResolvedValue(
      fakeTextResponse(
        "```json\n" +
          JSON.stringify({ suggestion: "Fenced suggestion", changedSignals: [] }) +
          "\n```",
      ),
    );
    const client = new AnthropicLlmRewriteClient(createMessage, "claude-haiku-4-5");

    const result = await client.suggestRewrite(INPUT);

    expect(result.suggestion).toBe("Fenced suggestion");
  });

  it("passes model, a single user message, and no tools to createMessage", async () => {
    const createMessage = vi.fn().mockResolvedValue(
      fakeTextResponse(JSON.stringify({ suggestion: "x", changedSignals: [] })),
    );
    const client = new AnthropicLlmRewriteClient(createMessage, "claude-haiku-4-5");

    await client.suggestRewrite(INPUT);

    expect(createMessage).toHaveBeenCalledTimes(1);
    const params = createMessage.mock.calls[0][0];
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");
    // Guardrail (ADR-0011 / task scope): this call must never declare tools
    // -- a tool-less request structurally cannot invoke task_finish,
    // task_start, or any other mutating verb.
    expect(params.tools).toBeUndefined();
  });

  // ── Mutation probe 2 target: the prompt must contain every finding ──────
  it("includes every finding's code and message in the prompt sent to the model", async () => {
    const createMessage = vi.fn().mockResolvedValue(
      fakeTextResponse(JSON.stringify({ suggestion: "x", changedSignals: [] })),
    );
    const client = new AnthropicLlmRewriteClient(createMessage, "claude-haiku-4-5");

    await client.suggestRewrite(INPUT);

    const params = createMessage.mock.calls[0][0];
    const promptText = params.messages[0].content as string;
    for (const finding of FINDINGS) {
      expect(promptText).toContain(finding.code);
      expect(promptText).toContain(finding.message);
    }
  });

  it("throws RewriteSuggestionParseError on non-JSON model output", async () => {
    const createMessage = vi.fn().mockResolvedValue(fakeTextResponse("not json at all"));
    const client = new AnthropicLlmRewriteClient(createMessage, "claude-haiku-4-5");

    await expect(client.suggestRewrite(INPUT)).rejects.toBeInstanceOf(RewriteSuggestionParseError);
  });

  it("throws RewriteSuggestionParseError when JSON is missing required fields", async () => {
    const createMessage = vi.fn().mockResolvedValue(
      fakeTextResponse(JSON.stringify({ suggestion: "only a suggestion" })),
    );
    const client = new AnthropicLlmRewriteClient(createMessage, "claude-haiku-4-5");

    await expect(client.suggestRewrite(INPUT)).rejects.toBeInstanceOf(RewriteSuggestionParseError);
  });
});

describe("getLlmRewriteClient", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalModel = process.env.AGENT_TASKS_REWRITE_MODEL;

  beforeEach(() => {
    __resetLlmRewriteClientCacheForTests();
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.AGENT_TASKS_REWRITE_MODEL;
    else process.env.AGENT_TASKS_REWRITE_MODEL = originalModel;
    __resetLlmRewriteClientCacheForTests();
  });

  it("returns null when ANTHROPIC_API_KEY is not set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(getLlmRewriteClient()).toBeNull();
  });

  it("returns a client when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const client = getLlmRewriteClient();
    expect(client).not.toBeNull();
  });
});
