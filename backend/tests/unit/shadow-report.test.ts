/**
 * Unit test for the scorer-v2 shadow report (T5).
 *
 * `computeShadowReport` is the read-only aggregation that quantifies, per
 * project, how many open tasks would block under the v2 scorer. Verified against
 * a mixed fixture (one passing task, one keystone-blocked task).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    projectFindMany: vi.fn(),
    taskFindMany: vi.fn(),
  },
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: { findMany: prismaMocks.projectFindMany },
    task: { findMany: prismaMocks.taskFindMany },
    $disconnect: vi.fn(),
  },
}));

import { computeShadowReport } from "../../src/scripts/shadow-report.js";

beforeEach(() => vi.clearAllMocks());

describe("computeShadowReport", () => {
  it("aggregates per-project would-block and keystone counts over open tasks", async () => {
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p1", slug: "alpha", confidenceThreshold: 60, taskTemplate: null, enforcementMode: null },
    ]);
    prismaMocks.taskFindMany.mockResolvedValue([
      // Passing: full executability fields, score well above 60.
      {
        title: "Add request-id middleware",
        description: "Add `requestId` in src/middleware/request-id.ts; verify via `curl`; expect 200",
        templateData: {
          goal: "trace requests",
          acceptanceCriteria: "- response carries x-request-id\n- a test asserts it",
          scope: "src/middleware",
          outOfScope: "no router change",
          dependencies: "none",
          risk: "low",
          agentPrompt: "1. add middleware 2. wire it",
        },
      },
      // Keystone-blocked: no acceptance criteria, no verification signal.
      {
        title: "Fix the thing",
        description: "Refactor the handler in src/routes/auth.ts somehow",
        templateData: null,
      },
    ]);

    const report = await computeShadowReport();
    expect(report).toHaveLength(1);
    const p = report[0]!;
    expect(p.project).toBe("alpha");
    expect(p.enforcementMode).toBe("WARN"); // null resolves to WARN
    expect(p.openTasks).toBe(2);
    expect(p.wouldBlock).toBe(1);
    expect(p.keystoneBlock).toBe(1);
    expect(p.wouldBlockPct).toBe(50);
    // The keystone task's missing_acceptance_criteria cap should appear in the histogram.
    expect(p.topCaps.find((c) => c.code === "missing_acceptance_criteria")).toBeDefined();
  });

  it("handles a project with no open tasks without dividing by zero", async () => {
    prismaMocks.projectFindMany.mockResolvedValue([
      { id: "p2", slug: "empty", confidenceThreshold: 60, taskTemplate: null, enforcementMode: "BLOCK" },
    ]);
    prismaMocks.taskFindMany.mockResolvedValue([]);

    const report = await computeShadowReport();
    expect(report[0]).toMatchObject({
      project: "empty",
      enforcementMode: "BLOCK",
      openTasks: 0,
      wouldBlock: 0,
      keystoneBlock: 0,
      wouldBlockPct: 0,
      scoreMin: null,
      scoreMean: null,
    });
  });
});
