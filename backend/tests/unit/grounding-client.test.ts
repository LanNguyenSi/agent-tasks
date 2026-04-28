/**
 * Unit tests for the GroundingClient, the thin wrapper around
 * `@lannguyensi/grounding-wrapper` that the v2 task endpoints call to
 * auto-start a grounding session for debug-flavored tasks.
 *
 * Two surfaces under test:
 *   1. The `getGroundingClient()` factory: env-flag toggle (Real vs Null)
 *      and module-load resilience.
 *   2. `RealGroundingClient.start`: snake_case → camelCase mapping and the
 *      "wrapper throws → null" failure-soft behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the wrapper module before importing the client. We re-`vi.doMock`
// inside individual tests when we need a different `initSession`
// implementation for that test only.
vi.mock("@lannguyensi/grounding-wrapper", () => ({
  initSession: vi.fn().mockReturnValue({
    id: "sess-default",
    keyword: "agent-tasks",
    problem: "default-problem",
    resolved_scope: "agent-tasks",
    mandatory_sequence: ["domain-router"],
    active_guardrails: ["no-root-cause-before-readme"],
    phases: ["scope-resolution"],
    current_phase: "scope-resolution",
    steps: [],
    phase_status: {},
    started_at: "2026-04-28T00:00:00.000Z",
    scope_changed: false,
  }),
}));

import {
  RealGroundingClient,
  NullGroundingClient,
  getGroundingClient,
  __resetGroundingClientCacheForTests,
} from "../../src/services/grounding-client.js";

beforeEach(() => {
  __resetGroundingClientCacheForTests();
  delete process.env.AGENT_TASKS_DISABLE_GROUNDING;
});

describe("getGroundingClient factory", () => {
  it("returns a client whose start resolves to a non-null result by default", async () => {
    const client = getGroundingClient();
    const result = await client.start({ keyword: "agent-tasks", problem: "fix bug" });
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBeTruthy();
  });

  it("returns a NullGroundingClient when AGENT_TASKS_DISABLE_GROUNDING=1", async () => {
    process.env.AGENT_TASKS_DISABLE_GROUNDING = "1";
    const client = getGroundingClient();
    const result = await client.start({ keyword: "agent-tasks", problem: "fix bug" });
    expect(result).toBeNull();
  });

  it("caches the resolved client across calls", () => {
    const a = getGroundingClient();
    const b = getGroundingClient();
    expect(a).toBe(b);
  });
});

describe("NullGroundingClient", () => {
  it("always resolves to null without invoking the wrapper", async () => {
    const client = new NullGroundingClient();
    expect(await client.start({ keyword: "k", problem: "p" })).toBeNull();
  });
});

describe("RealGroundingClient.start", () => {
  it("maps snake_case wrapper fields to camelCase result fields", async () => {
    const fakeSession = {
      id: "sess-mapped",
      keyword: "agent-tasks",
      problem: "fix login bug",
      resolved_scope: "agent-tasks",
      mandatory_sequence: ["domain-router", "readme-resolver", "playbook-engine"],
      active_guardrails: ["no-root-cause-before-readme", "no-step-skipping"],
      phases: ["scope-resolution", "doc-reading"],
      current_phase: "scope-resolution",
      steps: [],
      phase_status: {},
      started_at: "2026-04-28T12:00:00.000Z",
      scope_changed: false,
    };
    const initSession = vi.fn().mockReturnValue(fakeSession);
    const client = new RealGroundingClient(initSession);

    const result = await client.start({
      keyword: "agent-tasks",
      problem: "fix login bug",
    });

    expect(initSession).toHaveBeenCalledWith({
      keyword: "agent-tasks",
      problem: "fix login bug",
    });
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe("sess-mapped");
    expect(result?.currentPhase).toBe("scope-resolution");
    expect(result?.mandatorySequence).toEqual([
      "domain-router",
      "readme-resolver",
      "playbook-engine",
    ]);
    expect(result?.activeGuardrails).toEqual([
      "no-root-cause-before-readme",
      "no-step-skipping",
    ]);
    // Full session JSON is preserved on `sessionState` so a future
    // grounding-mcp import tool can rehydrate the session.
    expect(result?.sessionState).toBe(fakeSession);
  });

  it("returns null without rethrowing when initSession throws synchronously", async () => {
    const initSession = vi.fn().mockImplementation(() => {
      throw new Error("wrapper exploded");
    });
    const client = new RealGroundingClient(initSession);

    const result = await client.start({ keyword: "k", problem: "p" });
    expect(result).toBeNull();
    expect(initSession).toHaveBeenCalled();
  });

  it("returns null when initSession returns a value that throws downstream during mapping", async () => {
    // Defensive: a corrupted wrapper return that isn't an object would
    // crash the property access. The catch should still surface null.
    const initSession = vi.fn().mockImplementation(() => {
      // Returning a primitive forces the .id read to throw a TypeError
      // when the property access path is exercised.
      return null as unknown as { id: string; current_phase: string; mandatory_sequence: string[]; active_guardrails: string[] };
    });
    const client = new RealGroundingClient(initSession);

    const result = await client.start({ keyword: "k", problem: "p" });
    expect(result).toBeNull();
  });
});
