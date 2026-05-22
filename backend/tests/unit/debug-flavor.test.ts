import { describe, it, expect } from "vitest";
import {
  detectDebugFlavor,
  buildGroundingHint,
  getSessionPhase,
  readMetadata,
} from "../../src/lib/debug-flavor.js";

describe("detectDebugFlavor", () => {
  describe("title-based detection", () => {
    it.each([
      ["fix login bug", true],
      ["investigate flaky CI", true],
      ["hotfix: 500 errors", true],
      ["debug session timeout", true],
      ["RCA: payment regression in checkout", true],
      ["Search is broken on Safari", true],
      ["test suite failing on main", true],
      ["incident response runbook updates", true],
      ["root cause analysis for slow queries", true],
      ["webhook deliveries not working since deploy", true],
    ])("flags %j as debug-flavored", (title, expected) => {
      expect(
        detectDebugFlavor({ title, description: null, labels: [] }),
      ).toBe(expected);
    });

    it.each([
      ["add user-profile feature", false],
      ["refactor router", false],
      ["document the new endpoint", false],
      ["upgrade Prisma to 6.x", false],
      ["onboard a new agent token", false],
    ])("does not flag %j", (title, expected) => {
      expect(
        detectDebugFlavor({ title, description: null, labels: [] }),
      ).toBe(expected);
    });

    it("does not match 'bug' inside 'debugger' (word boundary)", () => {
      // "debugger" should not match "bug" as a substring; "debug" itself
      // is also word-boundaried so this stays false.
      expect(
        detectDebugFlavor({ title: "rename Debugger class", description: null, labels: [] }),
      ).toBe(false);
    });

    it("matches 'debug' as a whole word in title", () => {
      expect(
        detectDebugFlavor({ title: "debug session id mismatch", description: null, labels: [] }),
      ).toBe(true);
    });
  });

  describe("description-based detection", () => {
    it("matches a keyword in the description even when title is neutral", () => {
      expect(
        detectDebugFlavor({
          title: "Investigate API latency",
          description: "Reports of intermittent outage on the read path.",
          labels: [],
        }),
      ).toBe(true);
    });

    it("treats null description as empty", () => {
      expect(
        detectDebugFlavor({ title: "feature: new dashboard", description: null, labels: [] }),
      ).toBe(false);
    });

    it("matches multi-word keyword 'root cause'", () => {
      expect(
        detectDebugFlavor({
          title: "Cleanup old data",
          description: "We still need to find the root cause before retrying.",
          labels: [],
        }),
      ).toBe(true);
    });
  });

  describe("label-based detection", () => {
    it("matches a 'bug' label even when text is neutral", () => {
      expect(
        detectDebugFlavor({
          title: "Cleanup old data",
          description: null,
          labels: ["bug"],
        }),
      ).toBe(true);
    });

    it.each(["bug", "incident", "hotfix", "regression"])(
      "matches label %j",
      (label) => {
        expect(
          detectDebugFlavor({ title: "neutral title", description: null, labels: [label] }),
        ).toBe(true);
      },
    );

    it("matches labels case-insensitively", () => {
      expect(
        detectDebugFlavor({ title: "neutral title", description: null, labels: ["Bug", "BACKEND"] }),
      ).toBe(true);
    });

    it("ignores unrelated labels", () => {
      expect(
        detectDebugFlavor({
          title: "Cleanup old data",
          description: null,
          labels: ["docs", "good-first-issue"],
        }),
      ).toBe(false);
    });
  });

  describe("suppression-label behavior", () => {
    it.each([
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
    ])(
      "suppresses keyword match in description when label %j is present",
      (label) => {
        expect(
          detectDebugFlavor({
            title: "How-To Doc: Custom Policies",
            description: "Covers how policies behave under broken-state and failing validations.",
            labels: [label],
          }),
        ).toBe(false);
      },
    );

    it("suppresses keyword match in title when suppression label is present", () => {
      expect(
        detectDebugFlavor({
          title: "docs: explain hotfix flow",
          description: null,
          labels: ["docs"],
        }),
      ).toBe(false);
    });

    it("explicit debug label still wins when both kinds are present", () => {
      // Mixed labels like [docs, bug] mean a docs task that is itself a bug
      // (e.g. broken doc example). Explicit human classification wins.
      expect(
        detectDebugFlavor({
          title: "neutral title",
          description: null,
          labels: ["docs", "bug"],
        }),
      ).toBe(true);
    });

    it("explicit debug label wins even when title+description+suppression all collide", () => {
      // Three-way combo: keyword in title AND description AND a suppression
      // label AND an explicit debug label. Locks the rule "explicit-debug
      // beats suppression beats keyword" against a future reordering.
      expect(
        detectDebugFlavor({
          title: "fix login bug failing on Safari",
          description: "Something broken in the auth flow",
          labels: ["docs", "bug"],
        }),
      ).toBe(true);
    });

    it("explicit debug label beats the release/test suppression labels", () => {
      // Pin the newer release/test suppression labels against a future
      // reorder: combined with an explicit debug label, the debug
      // classification must still win.
      expect(
        detectDebugFlavor({ title: "neutral title", description: null, labels: ["release", "bug"] }),
      ).toBe(true);
      expect(
        detectDebugFlavor({ title: "neutral title", description: null, labels: ["test", "incident"] }),
      ).toBe(true);
    });

    it("suppression label is case-insensitive", () => {
      expect(
        detectDebugFlavor({
          title: "investigation of regression in router",
          description: null,
          labels: ["Docs"],
        }),
      ).toBe(false);
    });
  });

  describe("title-shape suppression", () => {
    it.each([
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
    ])(
      "suppresses a keyword-bearing title with the %j conventional-commit prefix",
      (type) => {
        // Title carries a debug keyword ("regression"); the type prefix
        // marks it as typed non-investigation work, so it is suppressed.
        expect(
          detectDebugFlavor({
            title: `${type}: handle the regression path`,
            description: null,
            labels: [],
          }),
        ).toBe(false);
      },
    );

    it("suppresses a prefix carrying a (scope) and a ! breaking marker", () => {
      expect(
        detectDebugFlavor({
          title: "chore(deps)!: bump the broken transitive dep",
          description: null,
          labels: [],
        }),
      ).toBe(false);
    });

    it("suppresses a bare ! breaking marker with no (scope)", () => {
      expect(
        detectDebugFlavor({
          title: "feat!: drop the broken legacy auth path",
          description: null,
          labels: [],
        }),
      ).toBe(false);
    });

    it("matches the type prefix case-insensitively", () => {
      expect(
        detectDebugFlavor({ title: "Feat: investigate-mode toggle", description: null, labels: [] }),
      ).toBe(false);
    });

    it("suppresses a description keyword when the title has a type prefix", () => {
      expect(
        detectDebugFlavor({
          title: "refactor: extract the policy evaluator",
          description: "Touches code paths near the failing-state recovery branch.",
          labels: [],
        }),
      ).toBe(false);
    });

    it("does NOT suppress a `fix:` prefix — bug-fix tasks stay scannable", () => {
      expect(
        detectDebugFlavor({ title: "fix: login bug on Safari", description: null, labels: [] }),
      ).toBe(true);
    });

    it("does NOT suppress `hotfix:` — not a conventional-commit type", () => {
      // `hotfix` is a debug keyword in its own right; the `:` does not
      // make it a suppressing type prefix.
      expect(
        detectDebugFlavor({ title: "hotfix: 500 errors", description: null, labels: [] }),
      ).toBe(true);
    });

    it("does NOT suppress a title with a colon but no type token", () => {
      // A plain colon (e.g. a sprint or phase label) is not a
      // conventional-commit type prefix.
      expect(
        detectDebugFlavor({
          title: "Sprint 3: fix the broken login flow",
          description: null,
          labels: [],
        }),
      ).toBe(true);
    });

    it("does NOT match `feature:` — only the `feat` token is a prefix", () => {
      // "feat" is not a prefix of "feature" up to the required `:`, so a
      // keyword in a `feature:`-titled task is still scanned.
      expect(
        detectDebugFlavor({
          title: "feature: dashboard with a regression-tracking panel",
          description: null,
          labels: [],
        }),
      ).toBe(true);
    });

    it("explicit debug label beats the title-shape suppressor", () => {
      expect(
        detectDebugFlavor({
          title: "chore: routine cleanup",
          description: null,
          labels: ["bug"],
        }),
      ).toBe(true);
    });
  });
});

describe("buildGroundingHint", () => {
  it("renders a hint with project slug + task title", () => {
    const hint = buildGroundingHint({
      title: "fix login bug",
      project: { slug: "agent-tasks" },
    });
    expect(hint.debugFlavor).toBe(true);
    expect(hint.recommendedAction).toMatch(/grounding session/i);
    expect(hint.mcpToolHint).toContain('keyword="agent-tasks"');
    expect(hint.mcpToolHint).toContain('problem="fix login bug"');
  });

  it("escapes embedded double-quotes in the task title", () => {
    const hint = buildGroundingHint({
      title: 'why does "X" not work',
      project: { slug: "p" },
    });
    expect(hint.mcpToolHint).toContain('problem="why does \\"X\\" not work"');
  });

  it("escapes backslashes, newlines, carriage returns, and backticks", () => {
    const hint = buildGroundingHint({
      title: "weird\\path\nnewline\rcr`tick`",
      project: { slug: "p" },
    });
    expect(hint.mcpToolHint).toContain(
      'problem="weird\\\\path\\nnewline\\rcr\\`tick\\`"',
    );
    // Must not contain a real newline or carriage-return that would split
    // the tool-hint across lines.
    expect(hint.mcpToolHint).not.toMatch(/\n|\r/);
  });
});

describe("readMetadata", () => {
  it("returns an empty object for null", () => {
    expect(readMetadata(null)).toEqual({});
  });

  it("returns an empty object for undefined", () => {
    expect(readMetadata(undefined)).toEqual({});
  });

  it("returns an empty object for a non-object value", () => {
    expect(readMetadata("oops")).toEqual({});
    expect(readMetadata(42)).toEqual({});
    expect(readMetadata([1, 2])).toEqual({});
  });

  it("passes a real metadata object through", () => {
    expect(readMetadata({ debugFlavor: true })).toEqual({ debugFlavor: true });
    expect(readMetadata({ debugFlavor: false, groundingSessionId: "abc" })).toEqual({
      debugFlavor: false,
      groundingSessionId: "abc",
    });
  });
});

describe("getSessionPhase", () => {
  // The gate path on `task_finish` calls getSessionPhase on whatever
  // metadata is on the task row. If a previous version persisted a
  // malformed shape (or someone hand-edited metadata), the gate must NOT
  // throw or surface a half-built phase string. This block pins the
  // tolerant contract: every malformed input yields `{ currentPhase: null }`.
  it("returns null phase for empty metadata", () => {
    expect(getSessionPhase({})).toEqual({ currentPhase: null });
  });

  it("returns null phase when only debugFlavor is set", () => {
    expect(getSessionPhase({ debugFlavor: true })).toEqual({ currentPhase: null });
  });

  it("returns null phase when groundingSessionState is undefined", () => {
    expect(getSessionPhase({ groundingSessionState: undefined })).toEqual({ currentPhase: null });
  });

  it("returns null phase when groundingSessionState is null", () => {
    expect(getSessionPhase({ groundingSessionState: null })).toEqual({ currentPhase: null });
  });

  it("returns null phase when groundingSessionState is a string", () => {
    expect(getSessionPhase({ groundingSessionState: "string" })).toEqual({ currentPhase: null });
  });

  it("returns null phase when groundingSessionState is a number", () => {
    expect(getSessionPhase({ groundingSessionState: 42 })).toEqual({ currentPhase: null });
  });

  it("returns null phase when groundingSessionState is an array", () => {
    expect(getSessionPhase({ groundingSessionState: [] })).toEqual({ currentPhase: null });
  });

  it("returns null phase when groundingSessionState is an empty object", () => {
    expect(getSessionPhase({ groundingSessionState: {} })).toEqual({ currentPhase: null });
  });

  it("returns null phase when current_phase is a non-string", () => {
    expect(getSessionPhase({ groundingSessionState: { current_phase: 42 } })).toEqual({
      currentPhase: null,
    });
  });

  it("treats an empty current_phase string as missing", () => {
    expect(getSessionPhase({ groundingSessionState: { current_phase: "" } })).toEqual({
      currentPhase: null,
    });
  });

  it("returns the current_phase when it is a non-empty string", () => {
    expect(
      getSessionPhase({ groundingSessionState: { current_phase: "scope-resolution" } }),
    ).toEqual({ currentPhase: "scope-resolution" });
  });

  it("ignores unrelated extra fields on groundingSessionState", () => {
    expect(
      getSessionPhase({
        groundingSessionState: { current_phase: "claim-evaluation", other: "extra" },
      }),
    ).toEqual({ currentPhase: "claim-evaluation" });
  });
});
