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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// Note: the production loader uses `createRequire`, which bypasses vi.mock.
// Phase 3 tests inject a stub loader through the second `RealGroundingClient`
// constructor argument instead.

import {
  RealGroundingClient,
  NullGroundingClient,
  getGroundingClient,
  __resetGroundingClientCacheForTests,
} from "../../src/services/grounding-client.js";

// Same bridge the production client uses (`createRequire`, which bypasses
// `vi.mock`). Used below to write through the *real* evidence-ledger module
// surface so a default-DB-path or API rename drifts loudly instead of the
// client silently soft-degrading to `{ entryCount: 0 }`.
const requireForDriftGuard = createRequire(import.meta.url);

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

describe("RealGroundingClient.getLedgerSummary", () => {
  // The ledger module is loaded via `createRequire`, which bypasses
  // `vi.mock`. The constructor accepts an optional loader so tests can
  // inject a stub directly. The injected stub stands in for
  // `@lannguyensi/evidence-ledger`'s `{ getDb, listEntries }` surface.
  it("returns the count of entries the ledger reports for the given session", async () => {
    const fakeDb = { tag: "fake-db" };
    const getDb = vi.fn().mockReturnValue(fakeDb);
    const listEntries = vi.fn().mockReturnValue([
      { id: 1, type: "fact", content: "x", source: null, confidence: "high", session: "sess-1", createdAt: "", updatedAt: "" },
      { id: 2, type: "hypothesis", content: "y", source: null, confidence: "medium", session: "sess-1", createdAt: "", updatedAt: "" },
      { id: 3, type: "rejected", content: "z", source: null, confidence: "low", session: "sess-1", createdAt: "", updatedAt: "" },
    ]);
    const client = new RealGroundingClient(vi.fn(), () => ({ getDb, listEntries }));

    const result = await client.getLedgerSummary("sess-1");
    expect(result).toEqual({ entryCount: 3 });
    expect(getDb).toHaveBeenCalled();
    expect(listEntries).toHaveBeenCalledWith(fakeDb, { session: "sess-1" });
  });

  it("returns zero entries (no throw) when the ledger read fails", async () => {
    const getDb = vi.fn().mockReturnValue({});
    const listEntries = vi.fn().mockImplementation(() => {
      throw new Error("sqlite is locked");
    });
    const client = new RealGroundingClient(vi.fn(), () => ({ getDb, listEntries }));

    const result = await client.getLedgerSummary("sess-broken");
    expect(result).toEqual({ entryCount: 0 });
  });

  it("returns zero entries when the ledger module fails to load", async () => {
    // Defensive: a deploy without `@lannguyensi/evidence-ledger` should
    // degrade to "no entries" instead of crashing the gate. The loader
    // returns null in that case.
    const client = new RealGroundingClient(vi.fn(), () => null);

    const result = await client.getLedgerSummary("sess-noop");
    expect(result).toEqual({ entryCount: 0 });
  });
});

describe("NullGroundingClient.getLedgerSummary", () => {
  it("returns zero entries without touching the filesystem", async () => {
    const client = new NullGroundingClient();
    const result = await client.getLedgerSummary("any-session");
    expect(result).toEqual({ entryCount: 0 });
  });
});

describe("RealGroundingClient.getLedgerSummary — real evidence-ledger module (drift guard)", () => {
  // Loads the installed `@lannguyensi/evidence-ledger` package the same way
  // production code does. A renamed/reshaped export here would throw at
  // require-time. Note the round-trip alone cannot catch default-path drift:
  // writer and reader share the module's `_db` singleton, so they move
  // together — the explicit `existsSync` assertion below is what pins the
  // on-disk default path. This block is a forward drift guard for future
  // ledger versions, not a version pin for the 0.5.1 upgrade itself.
  const ledgerModule = requireForDriftGuard("@lannguyensi/evidence-ledger") as {
    getDb: (dbPath?: string) => unknown;
    addEntry: (
      db: unknown,
      opts: { type: string; content: string; session?: string },
    ) => unknown;
    resetDb: () => void;
  };

  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    // Point $HOME at a throwaway directory so the module's *default*
    // (argless) path resolution — `~/.evidence-ledger/ledger.db` — runs for
    // real instead of touching the developer's actual ledger. Injecting a
    // custom dbPath instead would leave default-path drift undetected.
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "evidence-ledger-drift-"));
    process.env.HOME = tempHome;
    ledgerModule.resetDb();
  });

  afterEach(() => {
    ledgerModule.resetDb();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("counts an entry written via the real API at the module's default DB path", async () => {
    const db = ledgerModule.getDb();
    ledgerModule.addEntry(db, {
      type: "fact",
      content: "drift-guard probe entry",
      session: "drift-guard-session",
    });

    // Pin the on-disk default path independently of the shared singleton:
    // if a future ledger version renames `~/.evidence-ledger/ledger.db`,
    // this fails loudly even though writer and reader still agree.
    expect(existsSync(join(tempHome, ".evidence-ledger", "ledger.db"))).toBe(true);

    // `client` uses the default (production) loader, i.e. the same
    // `createRequire` path and therefore the same module instance — and
    // singleton DB handle — as `ledgerModule` above.
    const client = new RealGroundingClient(vi.fn());
    const result = await client.getLedgerSummary("drift-guard-session");
    expect(result).toEqual({ entryCount: 1 });
  });

  it("reports zero entries for a session with no writes (negative control)", async () => {
    const db = ledgerModule.getDb();
    ledgerModule.addEntry(db, {
      type: "fact",
      content: "belongs to a different session",
      session: "drift-guard-session-other",
    });

    const client = new RealGroundingClient(vi.fn());
    const result = await client.getLedgerSummary("drift-guard-session-unused");
    expect(result).toEqual({ entryCount: 0 });
  });
});
