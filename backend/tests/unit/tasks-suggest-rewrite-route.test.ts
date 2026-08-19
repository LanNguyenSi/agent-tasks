/**
 * Route-level tests for POST /tasks/:id/suggest-rewrite (M4, task
 * fc4f2dc7). ADR-0011: LLMs are advisory only, never gating.
 *
 * `services/llm-rewrite.js` is MOCKED here -- this file is about route
 * wiring (the opt-in gate, the 503-when-unconfigured branch, the 502 on an
 * LLM failure, response shape) and never makes a real Anthropic call. The
 * prompt-building/parsing logic itself is pinned directly in
 * llm-rewrite.test.ts.
 *
 * Per the project feedback memory: prefer `mockResolvedValue` /
 * `mockImplementation` over stacked `mockResolvedValueOnce` queues.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      findUnique: prismaMocks.taskFindUnique,
    },
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/team-access.js", () => ({
  hasProjectAccess: accessMocks.hasProjectAccess,
  // Unused by this route but re-exported so importing team-access.js from
  // tasks.js doesn't blow up on a missing named export.
  hasProjectRole: vi.fn(),
  isProjectAdmin: vi.fn(),
  requireProjectWrite: vi.fn(),
  resolveTeamId: vi.fn(),
  resolveTeamIdErrorBody: vi.fn(),
}));

const llmMocks = vi.hoisted(() => ({
  getLlmRewriteClient: vi.fn(),
  // A real (mock-module-local) Error subclass, not vi.fn() — routes/tasks.js
  // does `err instanceof RewriteSuggestionTruncatedError` in its catch
  // block, so this must be a real constructor the thrown error can actually
  // be an instance of. DEFAULT_MODEL mirrors the real module's export so
  // the route's success-path log line (review round-2 finding 9) doesn't
  // read `undefined`.
  RewriteSuggestionTruncatedError: class RewriteSuggestionTruncatedError extends Error {},
}));
vi.mock("../../src/services/llm-rewrite.js", () => ({
  getLlmRewriteClient: llmMocks.getLlmRewriteClient,
  RewriteSuggestionTruncatedError: llmMocks.RewriteSuggestionTruncatedError,
  DEFAULT_MODEL: "claude-haiku-4-5",
}));

import { taskRouter } from "../../src/routes/tasks.js";

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

const AGENT: Actor = {
  type: "agent",
  tokenId: "agent-1",
  teamId: "team-1",
  userId: "agent-owner",
  scopes: ["tasks:read"],
};

const HUMAN: Actor = { type: "human", userId: "user-1", teamId: "team-1" };

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "00000000-0000-0000-0000-000000000001";

// Deliberately thin/low-quality: no description, no templateData, no
// template fields required -- calculateConfidence will produce at least
// one finding here (a "low-score fixture" per the task's acceptance
// criteria), which is what the prompt-assertion mutation probe needs.
const baseTask = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: "x",
  description: null as string | null,
  templateData: null,
  project: {
    aiHelpersEnabled: true,
    taskTemplate: null,
  },
};

function post(actor: Actor, taskId = TASK_ID) {
  return makeApp(actor).request(`/tasks/${taskId}/suggest-rewrite`, { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  prismaMocks.taskFindUnique.mockResolvedValue(baseTask);
});

describe("POST /tasks/:id/suggest-rewrite", () => {
  it("returns 404 when the task does not exist", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(null);
    const res = await post(HUMAN);
    expect(res.status).toBe(404);
  });

  it("returns 403 when the actor has no project access", async () => {
    accessMocks.hasProjectAccess.mockResolvedValue(false);
    const res = await post(HUMAN);
    expect(res.status).toBe(403);
  });

  it("returns 403 for an agent missing the tasks:read scope", async () => {
    const res = await post({ ...AGENT, scopes: [] });
    expect(res.status).toBe(403);
    expect(prismaMocks.taskFindUnique).not.toHaveBeenCalled();
  });

  // ── Mutation probe 1 target: the aiHelpersEnabled gate ───────────────────
  it("returns 404 when the project has aiHelpersEnabled=false (opt-in gate off)", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue({
      ...baseTask,
      project: { ...baseTask.project, aiHelpersEnabled: false },
    });
    const res = await post(HUMAN);
    expect(res.status).toBe(404);
    expect(llmMocks.getLlmRewriteClient).not.toHaveBeenCalled();
  });

  it("returns 503 when aiHelpersEnabled=true but no LLM client is configured", async () => {
    llmMocks.getLlmRewriteClient.mockReturnValue(null);
    const res = await post(HUMAN);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("llm_not_configured");
  });

  // Review round-2 finding 6: the response text must NOT name the env var
  // (an internal config detail) -- only the OpenAPI doc and the server log
  // do that now.
  it("does not name ANTHROPIC_API_KEY in the 503 response body", async () => {
    llmMocks.getLlmRewriteClient.mockReturnValue(null);
    const res = await post(HUMAN);
    const body = (await res.json()) as { message: string };
    expect(body.message).not.toContain("ANTHROPIC_API_KEY");
    expect(body.message).toBe("The LLM rewrite helper is not configured on this server.");
  });

  it("returns 502 when the LLM client throws", async () => {
    llmMocks.getLlmRewriteClient.mockReturnValue({
      suggestRewrite: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const res = await post(HUMAN);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("llm_request_failed");
  });

  // Review round-2 finding 3: a truncated (stop_reason=max_tokens) response
  // gets its own error code and a more actionable message than the generic
  // "failed to produce a suggestion".
  it("returns 502 with error 'llm_response_truncated' when the LLM client throws RewriteSuggestionTruncatedError", async () => {
    llmMocks.getLlmRewriteClient.mockReturnValue({
      suggestRewrite: vi
        .fn()
        .mockRejectedValue(new llmMocks.RewriteSuggestionTruncatedError("truncated")),
    });
    const res = await post(HUMAN);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("llm_response_truncated");
    expect(body.message).toMatch(/output limit/i);
  });

  it("returns 200 with the suggestion and changedSignals, and never writes the task", async () => {
    const suggestRewrite = vi.fn().mockResolvedValue({
      suggestion: "A much better description.",
      changedSignals: ["missing_description"],
    });
    llmMocks.getLlmRewriteClient.mockReturnValue({ suggestRewrite });

    const res = await post(HUMAN);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      suggestion: "A much better description.",
      changedSignals: ["missing_description"],
    });
  });

  it("calls suggestRewrite with the task's live confidence findings", async () => {
    const suggestRewrite = vi.fn().mockResolvedValue({ suggestion: "x", changedSignals: [] });
    llmMocks.getLlmRewriteClient.mockReturnValue({ suggestRewrite });

    await post(HUMAN);

    expect(suggestRewrite).toHaveBeenCalledTimes(1);
    const input = suggestRewrite.mock.calls[0][0];
    expect(input.title).toBe("x");
    expect(input.description).toBeNull();
    expect(Array.isArray(input.findings)).toBe(true);
    // The thin fixture (no description, no templateData) must produce at
    // least one finding -- this is the "low-score fixture" the acceptance
    // criteria calls for.
    expect(input.findings.length).toBeGreaterThan(0);
  });

  it("allows a human caller regardless of scopes (humans aren't scope-checked)", async () => {
    llmMocks.getLlmRewriteClient.mockReturnValue({
      suggestRewrite: vi.fn().mockResolvedValue({ suggestion: "x", changedSignals: [] }),
    });
    const res = await post(HUMAN);
    expect(res.status).toBe(200);
  });
});
