import { describe, it, expect } from "vitest";
import {
  projectTaskSummary,
  projectTaskListSummary,
  paginateSignals,
  TASKS_GET_INCLUDE_VALUES,
  PROJECT_TASKS_INCLUDE_VALUES,
  SIGNALS_DEFAULT_LIMIT,
  SIGNALS_BACKEND_FETCH_LIMIT,
  type GetTaskResponse,
  type ListProjectTasksResponse,
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
    // Claim names and prUrl are genuinely unbounded upstream (see
    // CLAIM_CHAR_BUDGET / PRURL_CHAR_BUDGET's doc comments in read.ts), so
    // this fixture pushes both well past their clamp to prove the clamp
    // actually fires, not just that short realistic values stay short.
    const longClaimName = "Someone With An Extremely Long Resolved Display Name For Testing Purposes";
    const longPrUrl = `https://github.com/${"owner-name-".repeat(10)}/pull/999999999`;
    const response = baseTask({
      // `title` is deliberately NOT pushed past 255: unlike labels /
      // blockedBy / claims / prUrl, it is genuinely bounded upstream by
      // BOTH the backend's own createTaskSchema and mcp-server's own
      // task_create inputShape (both cap title at 255 chars), so 255 IS
      // this field's real worst case, not an arbitrary stand-in -- see
      // PRURL_CHAR_BUDGET's doc comment in read.ts for why title stays
      // unclamped locally while prUrl and the claim strings do not.
      title: "x".repeat(255),
      status: "in_progress",
      priority: "CRITICAL",
      labels: Array.from({ length: 20 }, (_, i) => `label-name-number-${i}-quite-long-indeed-yes`),
      prUrl: longPrUrl,
      claimedByUser: { id: "u1", login: "someone", name: longClaimName },
      reviewClaimedByUser: { id: "u2", login: "reviewer", name: longClaimName },
      blockedBy: Array.from({ length: 50 }, (_, i) => ({
        id: `blocker-id-${i}`,
        title: `Blocker task title number ${i} that is fairly long indeed to test the clamp`,
        status: "open",
      })),
    });
    const result = projectTaskSummary(response) as {
      task: { claims?: { work?: string; review?: string }; prUrl?: string };
    };
    // The clamps under test actually fired: both come back shorter than fed
    // in, visibly truncated with the "..." marker, not silently unbounded.
    expect(result.task.claims?.work?.length).toBeLessThan(longClaimName.length);
    expect(result.task.claims?.work?.endsWith("...")).toBe(true);
    expect(result.task.prUrl?.length).toBeLessThan(longPrUrl.length);
    expect(result.task.prUrl?.endsWith("...")).toBe(true);

    const size = serializeResult(result).length;
    // Exact regression pin (fails loudly on any clamp drift) under a fixed
    // ceiling (the actual budget guarantee): the clamps above bound array
    // COUNT and per-entry chars, so this worst case is a known, fixed
    // number, not "however big the caller's input happens to be" -- title
    // excepted, which stays at its real, externally-enforced 255-char
    // maximum rather than a synthetic local ceiling (see above).
    expect(size).toBe(2830);
    expect(size).toBeLessThanOrEqual(3000);
  });

  it("TASKS_GET_INCLUDE_VALUES excludes instructions (task_start's own per-state prose, not a task field)", () => {
    expect(TASKS_GET_INCLUDE_VALUES).not.toContain("instructions");
    expect(TASKS_GET_INCLUDE_VALUES).toEqual(["description", "comments", "artifacts", "task"]);
  });
});

// ── project_tasks: projectTaskListSummary (task 3653962f) ───────────────
//
// project_tasks is a browse-scoped listing verb: a 40-row page where
// several rows carry multi-kB descriptions/templateData used to return
// every row's full backend shape. This projects each row down to a
// summary the same way projectTaskSummary already does for a single
// tasks_get call, reusing the same core field set (see read.ts's shared
// projectTaskCore), plus two list-only fields (externalRef, createdAt).

function listResponse(tasks: ListProjectTasksResponse["tasks"], nextCursor: string | null = null): ListProjectTasksResponse {
  return { tasks, nextCursor };
}

describe("projectTaskListSummary", () => {
  it("PROJECT_TASKS_INCLUDE_VALUES is description/templateData/task (no comments/artifacts -- no per-row use case)", () => {
    expect(PROJECT_TASKS_INCLUDE_VALUES).toEqual(["description", "templateData", "task"]);
  });

  it("defaults every row to id + title only when nothing else is present, nextCursor passed through", () => {
    const response = listResponse([{ id: "t1", title: "Fix the login redirect loop" }], "next-id");
    const result = projectTaskListSummary(response);
    expect(result).toEqual({ tasks: [{ id: "t1", title: "Fix the login redirect loop" }], nextCursor: "next-id" });
  });

  it("row summary carries status/priority/labels/externalRef/createdAt/claims/blockedBy/prUrl, never description/templateData/comments/artifacts by default", () => {
    const response = listResponse([
      {
        id: "t1",
        title: "Fix the login redirect loop",
        status: "in_progress",
        priority: "HIGH",
        labels: ["bug", "auth"],
        externalRef: "ext-42",
        createdAt: "2026-08-01T00:00:00.000Z",
        prUrl: "https://github.com/o/r/pull/42",
        claimedByUser: { id: "u1", login: "lan", name: "Lan" },
        blockedBy: [{ id: "b1", title: "Add auth middleware", status: "done" }],
        description: "a very long description that should not be echoed back by default",
        templateData: { taskType: "bugfix" },
      },
    ]);
    const result = projectTaskListSummary(response) as unknown as {
      tasks: Record<string, unknown>[];
    };
    const row = result.tasks[0]!;
    expect(row).toEqual({
      id: "t1",
      title: "Fix the login redirect loop",
      status: "in_progress",
      priority: "HIGH",
      labels: ["bug", "auth"],
      externalRef: "ext-42",
      createdAt: "2026-08-01T00:00:00.000Z",
      claims: { work: "Lan" },
      blockedBy: [{ id: "b1", title: "Add auth middleware", status: "done" }],
      prUrl: "https://github.com/o/r/pull/42",
    });
    // Acceptance criterion 3: the exact key set of a summary row carries no
    // description, no templateData, no metadata, no timestamps other than
    // createdAt.
    expect(Object.keys(row).sort()).toEqual(
      ["blockedBy", "claims", "createdAt", "externalRef", "id", "labels", "priority", "prUrl", "status", "title"].sort(),
    );
    expect(row.description).toBeUndefined();
    expect(row.templateData).toBeUndefined();
  });

  it('include:["description"] adds description back to every row, other rows unaffected', () => {
    const response = listResponse([
      { id: "t1", title: "A", description: "desc-1" },
      { id: "t2", title: "B" },
    ]);
    const result = projectTaskListSummary(response, ["description"]) as {
      tasks: { id: string; description?: string }[];
    };
    expect(result.tasks[0]?.description).toBe("desc-1");
    expect(result.tasks[1]?.description).toBeUndefined();
  });

  it('include:["templateData"] adds templateData back to every row', () => {
    const response = listResponse([{ id: "t1", title: "A", templateData: { taskType: "feature" } }]);
    const result = projectTaskListSummary(response, ["templateData"]) as unknown as {
      tasks: { templateData?: Record<string, unknown> }[];
    };
    expect(result.tasks[0]?.templateData).toEqual({ taskType: "feature" });
  });

  it('include:["task"] returns the raw response unchanged, full rows, nextCursor untouched', () => {
    const response = listResponse(
      [{ id: "t1", title: "A", description: "full body", templateData: { x: 1 } }],
      "cursor-9",
    );
    const result = projectTaskListSummary(response, ["task"]);
    expect(result).toBe(response);
  });

  it("a malformed body (no tasks array) is returned raw rather than crashing on a dereference", () => {
    const malformed = { nextCursor: null } as unknown as ListProjectTasksResponse;
    expect(projectTaskListSummary(malformed)).toBe(malformed);
  });

  // ── acceptance criterion 1: 40-row fixture with 3kB descriptions/templateData
  // stays well under 20kB serialized, while include:["task"] does not ──────

  function bigTask(i: number): ListProjectTasksResponse["tasks"][number] {
    return {
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      title: `Task number ${i}`,
      status: "open",
      priority: "MEDIUM",
      labels: ["mcp", "dx"],
      externalRef: `ext-${i}`,
      createdAt: "2026-08-01T00:00:00.000Z",
      description: "d".repeat(3000),
      templateData: { taskType: "feature", notes: "n".repeat(2000) },
    };
  }

  it("40-row fixture with 3kB descriptions/templateData: default projection stays under 20kB, include:[\"task\"] does not", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => bigTask(i));
    const response = listResponse(tasks, null);

    const defaultResult = projectTaskListSummary(response);
    const defaultSize = JSON.stringify(defaultResult).length;
    expect(defaultSize).toBeLessThan(20_000);

    const fullResult = projectTaskListSummary(response, ["task"]);
    const fullSize = JSON.stringify(fullResult).length;
    // The whole point of include:["task"] is that it is NOT summarized --
    // demonstrates the default projection is doing real work, not that
    // both branches coincidentally land under the cap.
    expect(fullSize).toBeGreaterThan(20_000);
  });

  it("nextCursor is preserved unchanged by the default projection (task id, or null)", () => {
    const response = listResponse([{ id: "t1", title: "A" }], "some-task-id");
    const result = projectTaskListSummary(response) as { nextCursor: string | null };
    expect(result.nextCursor).toBe("some-task-id");

    const nullResponse = listResponse([{ id: "t1", title: "A" }], null);
    const nullResult = projectTaskListSummary(nullResponse) as { nextCursor: string | null };
    expect(nullResult.nextCursor).toBeNull();
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

  // ── atBackendFetchCeiling (rc-v1-C006 round-2 review, HIGH) ──────────────
  //
  // `all` is the single backend fetch's own result (client.ts's
  // pollSignals(SIGNALS_BACKEND_FETCH_LIMIT), backend-capped at 200 -- see
  // client.ts's own comment on pollSignals). When `all.length` reaches that
  // ceiling, the true pending backlog may be larger than what this one fetch
  // could return, so every page derived from it (not only the final one)
  // must say so via atBackendFetchCeiling, independent of truncated (which
  // only describes local pagination WITHIN `all`).

  it(`sets atBackendFetchCeiling:true when the backlog is exactly at the backend fetch limit (${SIGNALS_BACKEND_FETCH_LIMIT}), even on the FINAL local page where truncated is absent`, () => {
    const all = Array.from({ length: SIGNALS_BACKEND_FETCH_LIMIT }, (_, i) => signal(`s${i}`));
    // Page through to the last local page (limit 50 -> 4 pages of 50 over
    // 200 signals) and check the final one specifically: before this fix,
    // exactly this page said truncated:false ("nothing more"), which read
    // as "backlog fully drained" even though the backend fetch itself may
    // have clipped a larger true backlog.
    let cursor: string | undefined;
    let last: ReturnType<typeof paginateSignals> | undefined;
    for (let i = 0; i < 4; i++) {
      last = paginateSignals(all, { cursor, limit: 50 });
      cursor = last.cursor;
    }
    expect(last?.signals.length).toBe(50);
    expect(last?.truncated).toBeUndefined(); // local pagination: genuinely nothing left in `all`
    expect(last?.atBackendFetchCeiling).toBe(true); // but the fetch itself may be an undercount
  });

  it("sets atBackendFetchCeiling:true on every page of an at-ceiling fetch, not only the final one (it describes the fetch, not the page)", () => {
    const all = Array.from({ length: SIGNALS_BACKEND_FETCH_LIMIT }, (_, i) => signal(`s${i}`));
    const first = paginateSignals(all, { limit: 10 });
    expect(first.truncated).toBe(true);
    expect(first.atBackendFetchCeiling).toBe(true);
  });

  it("does NOT set atBackendFetchCeiling when the backlog is under the limit (the common case stays unaffected)", () => {
    const all = Array.from({ length: SIGNALS_BACKEND_FETCH_LIMIT - 1 }, (_, i) => signal(`s${i}`));
    const result = paginateSignals(all, { limit: SIGNALS_BACKEND_FETCH_LIMIT });
    expect(result.atBackendFetchCeiling).toBeUndefined();
  });

  it("sets atBackendFetchCeiling when `all` exceeds the limit too (>=, not ==; defensive against a future backend max bump)", () => {
    const all = Array.from({ length: SIGNALS_BACKEND_FETCH_LIMIT + 50 }, (_, i) => signal(`s${i}`));
    const result = paginateSignals(all, { limit: SIGNALS_BACKEND_FETCH_LIMIT + 50 });
    expect(result.atBackendFetchCeiling).toBe(true);
  });
});
