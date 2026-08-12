import { describe, it, expect } from "vitest";
import {
  projectTaskSummary,
  paginateSignals,
  TASKS_GET_INCLUDE_VALUES,
  SIGNALS_DEFAULT_LIMIT,
  type GetTaskResponse,
  type RawSignal,
} from "../src/read.js";
import { serializeResult } from "../src/server.js";

// ── tasks_get: projectTaskSummary (rc-v1-C006) ──────────────────────────

const TASK_ID = "11111111-1111-1111-1111-111111111111";

function baseTask(overrides: Partial<GetTaskResponse["task"]> = {}): GetTaskResponse {
  return {
    task: {
      id: TASK_ID,
      title: "Fix the login redirect loop",
      ...overrides,
    },
  };
}

describe("projectTaskSummary", () => {
  it("defaults to id + title only when nothing else is present", () => {
    const result = projectTaskSummary(baseTask());
    expect(result).toEqual({ task: { id: TASK_ID, title: "Fix the login redirect loop" } });
  });

  it("summary carries status/priority/labels/claims/blockedBy/prUrl, never description/comments/artifacts", () => {
    const response = baseTask({
      status: "in_progress",
      priority: "HIGH",
      labels: ["bug", "auth"],
      prUrl: "https://github.com/o/r/pull/42",
      claimedByUser: { id: "u1", login: "lan", name: "Lan" },
      blockedBy: [{ id: "b1", title: "Add auth middleware", status: "done" }],
      description: "SECRET description text",
      comments: [{ id: "c1", content: "SECRET comment" }],
      artifacts: [{ id: "a1", name: "SECRET artifact" }],
    });
    const result = projectTaskSummary(response) as unknown as { task: Record<string, unknown> };
    expect(result.task).toEqual({
      id: TASK_ID,
      title: "Fix the login redirect loop",
      status: "in_progress",
      priority: "HIGH",
      labels: ["bug", "auth"],
      claims: { work: "Lan" },
      blockedBy: [{ id: "b1", title: "Add auth middleware", status: "done" }],
      prUrl: "https://github.com/o/r/pull/42",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("HAPPY PATH: measures exactly 431 chars through serializeResult (regression pin)", () => {
    const response = baseTask({
      status: "in_progress",
      priority: "HIGH",
      labels: ["bug", "auth"],
      prUrl: "https://github.com/o/r/pull/42",
      claimedByUser: { id: "u1", login: "lan", name: "Lan" },
      blockedBy: [{ id: "b1", title: "Add auth middleware", status: "done" }],
    });
    const result = projectTaskSummary(response);
    expect(serializeResult(result).length).toBe(431);
  });

  // ── claims short-form: work / review / both / neither, user vs agent ────

  it("claims.work prefers a resolved name, falls back to login, then to the bare id", () => {
    expect(
      (projectTaskSummary(baseTask({ claimedByUser: { id: "u1", name: "Lan" } })) as {
        task: { claims?: { work?: string } };
      }).task.claims?.work,
    ).toBe("Lan");
    expect(
      (projectTaskSummary(baseTask({ claimedByUser: { id: "u1", login: "lan" } })) as {
        task: { claims?: { work?: string } };
      }).task.claims?.work,
    ).toBe("lan");
    expect(
      (projectTaskSummary(baseTask({ claimedByUser: { id: "u1" } })) as {
        task: { claims?: { work?: string } };
      }).task.claims?.work,
    ).toBe("u1");
  });

  it("claims.work falls back to the agent claimant when no user claimant is present", () => {
    const result = projectTaskSummary(
      baseTask({ claimedByAgent: { id: "agent-1", name: "Hermes" } }),
    ) as { task: { claims?: { work?: string } } };
    expect(result.task.claims?.work).toBe("Hermes");
  });

  it("claims carries both work and review when both are present", () => {
    const result = projectTaskSummary(
      baseTask({
        claimedByUser: { id: "u1", name: "Author" },
        reviewClaimedByUser: { id: "u2", name: "Reviewer" },
      }),
    ) as { task: { claims?: { work?: string; review?: string } } };
    expect(result.task.claims).toEqual({ work: "Author", review: "Reviewer" });
  });

  it("claims is entirely absent when no claimant of any kind is present", () => {
    const result = projectTaskSummary(baseTask()) as unknown as { task: Record<string, unknown> };
    expect(result.task).not.toHaveProperty("claims");
  });

  // ── include variants ─────────────────────────────────────────────────

  it("include:[\"description\"] adds only description, not comments or artifacts", () => {
    const response = baseTask({
      description: "the spec",
      comments: [{ id: "c1" }],
      artifacts: [{ id: "a1" }],
    });
    const result = projectTaskSummary(response, ["description"]) as unknown as { task: Record<string, unknown> };
    expect(result.task.description).toBe("the spec");
    expect(result.task).not.toHaveProperty("comments");
    expect(result.task).not.toHaveProperty("artifacts");
  });

  it("include:[\"comments\"] adds only comments", () => {
    const response = baseTask({
      description: "the spec",
      comments: [{ id: "c1", content: "note" }],
    });
    const result = projectTaskSummary(response, ["comments"]) as unknown as { task: Record<string, unknown> };
    expect(result.task.comments).toEqual([{ id: "c1", content: "note" }]);
    expect(result.task).not.toHaveProperty("description");
  });

  it("include:[\"artifacts\"] adds only artifacts", () => {
    const response = baseTask({ artifacts: [{ id: "a1", name: "build.log" }] });
    const result = projectTaskSummary(response, ["artifacts"]) as unknown as { task: Record<string, unknown> };
    expect(result.task.artifacts).toEqual([{ id: "a1", name: "build.log" }]);
  });

  it("include:[\"description\", \"comments\", \"artifacts\"] adds all three at once", () => {
    const response = baseTask({
      description: "the spec",
      comments: [{ id: "c1" }],
      artifacts: [{ id: "a1" }],
    });
    const result = projectTaskSummary(response, ["description", "comments", "artifacts"]) as unknown as {
      task: Record<string, unknown>;
    };
    expect(result.task.description).toBe("the spec");
    expect(result.task.comments).toEqual([{ id: "c1" }]);
    expect(result.task.artifacts).toEqual([{ id: "a1" }]);
  });

  it("include:[\"task\"] bypasses the projection entirely, returning the raw response unchanged", () => {
    const response = baseTask({
      description: "the spec",
      comments: [{ id: "c1" }],
      status: "open",
    });
    const result = projectTaskSummary(response, ["task"]);
    expect(result).toBe(response);
  });

  it("a malformed response (no task.id) is returned raw instead of crashing", () => {
    const malformed = { task: {} } as unknown as GetTaskResponse;
    expect(projectTaskSummary(malformed)).toBe(malformed);
  });

  // ── clamps: labels + blockedBy, never silently unbounded ────────────────

  it("labels beyond the summary clamp are truncated with a totalLabels count, never silently dropped", () => {
    const labels = Array.from({ length: 15 }, (_, i) => `label-${i}`);
    const result = projectTaskSummary(baseTask({ labels })) as {
      task: { labels?: string[]; totalLabels?: number };
    };
    expect(result.task.labels?.length).toBe(10);
    expect(result.task.totalLabels).toBe(15);
  });

  it("labels at or under the clamp carry no totalLabels marker", () => {
    const labels = ["a", "b", "c"];
    const result = projectTaskSummary(baseTask({ labels })) as {
      task: { labels?: string[]; totalLabels?: number };
    };
    expect(result.task.labels).toEqual(labels);
    expect(result.task).not.toHaveProperty("totalLabels");
  });

  it("a label longer than the per-entry char budget is visibly truncated with '...'", () => {
    const longLabel = "x".repeat(80);
    const result = projectTaskSummary(baseTask({ labels: [longLabel] })) as {
      task: { labels?: string[] };
    };
    const clamped = result.task.labels?.[0] ?? "";
    expect(clamped.length).toBeLessThan(longLabel.length);
    expect(clamped.endsWith("...")).toBe(true);
  });

  it("blockedBy beyond the summary clamp is truncated with a totalBlockedBy count, never silently dropped", () => {
    const blockedBy = Array.from({ length: 12 }, (_, i) => ({
      id: `b${i}`,
      title: `Blocker ${i}`,
      status: "open",
    }));
    const result = projectTaskSummary(baseTask({ blockedBy })) as {
      task: { blockedBy?: unknown[]; totalBlockedBy?: number };
    };
    expect(result.task.blockedBy?.length).toBe(10);
    expect(result.task.totalBlockedBy).toBe(12);
  });

  it("a blockedBy title longer than the per-entry char budget is visibly truncated with '...'", () => {
    const longTitle = "y".repeat(90);
    const result = projectTaskSummary(
      baseTask({ blockedBy: [{ id: "b1", title: longTitle, status: "open" }] }),
    ) as { task: { blockedBy?: { title: string }[] } };
    const clampedTitle = result.task.blockedBy?.[0]?.title ?? "";
    expect(clampedTitle.length).toBeLessThan(longTitle.length);
    expect(clampedTitle.endsWith("...")).toBe(true);
  });

  // ── WORST CASE ceiling: every clamp active at once, adversarial input ───

  it("WORST CASE (adversarial input, every clamp active): stays within a fixed ceiling, never unbounded", () => {
    const response = baseTask({
      title: "x".repeat(255),
      status: "in_progress",
      priority: "CRITICAL",
      labels: Array.from({ length: 20 }, (_, i) => `label-name-number-${i}-quite-long-indeed-yes`),
      prUrl: "https://github.com/owner-name/repo-name/pull/99999",
      claimedByUser: { id: "u1", login: "someone", name: "Someone Long Name Here" },
      reviewClaimedByUser: { id: "u2", login: "reviewer", name: "Reviewer Long Name Here" },
      blockedBy: Array.from({ length: 50 }, (_, i) => ({
        id: `blocker-id-${i}`,
        title: `Blocker task title number ${i} that is fairly long indeed to test the clamp`,
        status: "open",
      })),
    });
    const result = projectTaskSummary(response);
    const size = serializeResult(result).length;
    // Exact regression pin (fails loudly on any clamp drift) under a fixed
    // ceiling (the actual budget guarantee): the clamps above bound array
    // COUNT and per-entry chars, so this worst case is a known, fixed
    // number, not "however big the caller's input happens to be".
    expect(size).toBe(2705);
    expect(size).toBeLessThanOrEqual(3000);
  });

  it("TASKS_GET_INCLUDE_VALUES excludes instructions (task_start's own per-state prose, not a task field)", () => {
    expect(TASKS_GET_INCLUDE_VALUES).not.toContain("instructions");
    expect(TASKS_GET_INCLUDE_VALUES).toEqual(["description", "comments", "artifacts", "task"]);
  });
});

// ── signals_poll: paginateSignals (rc-v1-C006) ──────────────────────────

function signal(id: string): RawSignal {
  return { id, type: "review_needed" };
}

describe("paginateSignals", () => {
  it("returns everything untouched, no truncated/cursor fields, when under the default limit", () => {
    const all = [signal("s1"), signal("s2"), signal("s3")];
    const result = paginateSignals(all);
    expect(result).toEqual({ signals: all });
  });

  it(`defaults to a page of ${SIGNALS_DEFAULT_LIMIT} and sets truncated:true + cursor when more remain`, () => {
    const all = Array.from({ length: SIGNALS_DEFAULT_LIMIT + 5 }, (_, i) => signal(`s${i}`));
    const result = paginateSignals(all);
    expect(result.signals.length).toBe(SIGNALS_DEFAULT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.cursor).toBe(`s${SIGNALS_DEFAULT_LIMIT - 1}`);
  });

  it("NO SIGNAL IS LOST: a follow-up call with the returned cursor yields exactly the remainder, no gap, no duplicate", () => {
    const all = Array.from({ length: 15 }, (_, i) => signal(`s${i}`));
    const first = paginateSignals(all, { limit: 10 });
    expect(first.signals.map((s) => s.id)).toEqual(all.slice(0, 10).map((s) => s.id));
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBe("s9");

    const second = paginateSignals(all, { cursor: first.cursor, limit: 10 });
    expect(second.signals.map((s) => s.id)).toEqual(all.slice(10).map((s) => s.id));
    expect(second.truncated).toBeUndefined();
    expect(second.cursor).toBeUndefined();

    // No loss, no duplication: the two pages concatenated equal the source
    // exactly.
    const combined = [...first.signals, ...second.signals].map((s) => s.id);
    expect(combined).toEqual(all.map((s) => s.id));
  });

  it("a cursor whose signal is no longer present (acked / aged out) falls back to the start rather than dropping everything", () => {
    const all = [signal("s1"), signal("s2")];
    const result = paginateSignals(all, { cursor: "does-not-exist" });
    expect(result.signals).toEqual(all);
  });

  it("respects an explicit smaller limit", () => {
    const all = [signal("s1"), signal("s2"), signal("s3")];
    const result = paginateSignals(all, { limit: 1 });
    expect(result.signals).toEqual([signal("s1")]);
    expect(result.truncated).toBe(true);
    expect(result.cursor).toBe("s1");
  });

  it("an empty backlog returns an empty page with no truncation", () => {
    expect(paginateSignals([])).toEqual({ signals: [] });
  });
});
