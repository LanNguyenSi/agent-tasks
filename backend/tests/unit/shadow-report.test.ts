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

  // M2 (task b8629b99, review round-2 finding 1): the report is the offline
  // basis for flipping a project to BLOCK, so its wouldBlock count must use
  // the SAME layered threshold the live gate applies, not the flat project
  // value alone; otherwise a project with a per-type override understates
  // blast radius in exactly the calibration signal meant to catch it.
  it("uses the project's taskTypeThresholds override, not the flat confidenceThreshold, when the task has a matching explicit taskType", async () => {
    prismaMocks.projectFindMany.mockResolvedValue([
      {
        id: "p3",
        slug: "typed",
        confidenceThreshold: 60,
        taskTemplate: null,
        enforcementMode: "WARN",
        taskTypeThresholds: { security: 90 },
      },
    ]);
    prismaMocks.taskFindMany.mockResolvedValue([
      // Rich enough to clear the flat 60 default but not the security
      // override of 90; isolates the per-type threshold from the keystone.
      {
        title: "Rate-limit the login endpoint",
        description: [
          "Add rate limiting to the login endpoint in src/routes/auth.ts to mitigate credential-stuffing attempts.",
          "- Limit to 10 attempts per IP per 60 seconds.",
          "- Verify with a curl loop against /api/login that the 11th request in a minute returns 429.",
        ].join("\n"),
        templateData: {
          goal: "Reduce credential-stuffing risk on the login endpoint",
          acceptanceCriteria: "- The 11th login attempt within 60s from one IP returns 429\n- A unit test asserts the 429 response",
          scope: "src/routes/auth.ts login handler and its rate-limit middleware only",
          outOfScope: "session middleware and password hashing are unchanged",
          dependencies: "none",
          risk: "low: additive middleware only, no schema change",
          constraints: "No new dependency; keep the existing session cookie format",
          agentPrompt: "1. Add a rate-limit middleware keyed on IP. 2. Wire it into the login route. 3. Add a test.",
          taskType: "security",
        },
      },
    ]);

    const report = await computeShadowReport();
    const p = report[0]!;
    // `threshold` stays the flat project layer (documented on ProjectReport);
    // `wouldBlock` reflects the taskType-resolved 90, so the task blocks even
    // though its score clears the flat 60 shown in `threshold`.
    expect(p.threshold).toBe(60);
    expect(p.wouldBlock).toBe(1);
    expect(p.keystoneBlock).toBe(0);
  });
});
