import { describe, it, expect } from "vitest";
import { detectDebugFlavor, buildGroundingHint, readMetadata } from "../../src/lib/debug-flavor.js";

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
