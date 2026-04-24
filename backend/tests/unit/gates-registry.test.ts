/**
 * Gate-registry unit tests.
 *
 * Exercises the four v1 gates through their `describe()` methods and the
 * registry's aggregate projection. Check-functions are exercised in the
 * handler integration tests (github-routes-scope, pr-binding, etc.) —
 * this file is specifically about the introspection surface.
 */
import { describe, it, expect } from "vitest";
import {
  GateCode,
  computeEffectiveGates,
  registry,
  checkTaskStatusForMerge,
  checkPrRepoMatchesProject,
} from "../../src/services/gates/index.js";
import { GovernanceMode } from "../../src/lib/governance-mode.js";

const AUTONOMOUS = { governanceMode: GovernanceMode.AUTONOMOUS } as const;
const DISTINCT = {
  governanceMode: GovernanceMode.REQUIRES_DISTINCT_REVIEWER,
} as const;
const CONFIRMATION = {
  governanceMode: GovernanceMode.AWAITS_CONFIRMATION,
} as const;

describe("GateCode is stable wire format", () => {
  it("uses snake_case string values that should not be renamed casually", () => {
    expect(GateCode.DistinctReviewer).toBe("distinct_reviewer");
    expect(GateCode.SelfMerge).toBe("self_merge");
    expect(GateCode.TaskStatusForMerge).toBe("task_status_for_merge");
    expect(GateCode.PrRepoMatchesProject).toBe("pr_repo_matches_project");
  });
});

describe("registry contents", () => {
  it("exposes exactly the four v1 gates", () => {
    expect(registry).toHaveLength(4);
    expect(registry.map((g) => g.code).sort()).toEqual(
      [
        GateCode.DistinctReviewer,
        GateCode.SelfMerge,
        GateCode.TaskStatusForMerge,
        GateCode.PrRepoMatchesProject,
      ].sort(),
    );
  });

  it("every gate declares the verbs it applies to", () => {
    for (const gate of registry) {
      expect(gate.appliesTo.length).toBeGreaterThan(0);
    }
  });

  // Invariant: each GateCode appears at most once in the registry. Without
  // this, a duplicate would silently clobber the first entry inside
  // computeEffectiveGates (second-write-wins on the Record). Fails loudly
  // at import time if a future change breaks the invariant.
  it("gate codes are unique across the registry", () => {
    const codes = registry.map((g) => g.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("distinct-reviewer gate.describe()", () => {
  it("is active under REQUIRES_DISTINCT_REVIEWER", () => {
    const result = computeEffectiveGates({
      ...DISTINCT,
      githubRepo: null,
    })[GateCode.DistinctReviewer];
    expect(result.active).toBe(true);
    expect(result.because).toMatch(/REQUIRES_DISTINCT_REVIEWER/);
  });

  it("is inactive under AUTONOMOUS", () => {
    const result = computeEffectiveGates({
      ...AUTONOMOUS,
      githubRepo: null,
    })[GateCode.DistinctReviewer];
    expect(result.active).toBe(false);
    expect(result.because).toMatch(/AUTONOMOUS/);
  });

  it("is inactive under AWAITS_CONFIRMATION", () => {
    const result = computeEffectiveGates({
      ...CONFIRMATION,
      githubRepo: null,
    })[GateCode.DistinctReviewer];
    expect(result.active).toBe(false);
    expect(result.because).toMatch(/AWAITS_CONFIRMATION/);
  });

  it("falls back to legacy soloMode flag when governanceMode is null", () => {
    const result = computeEffectiveGates({
      governanceMode: null,
      soloMode: true,
      requireDistinctReviewer: false,
      githubRepo: null,
    })[GateCode.DistinctReviewer];
    expect(result.active).toBe(false); // soloMode → AUTONOMOUS
  });

  it("falls back to legacy requireDistinctReviewer flag when governanceMode is null", () => {
    const result = computeEffectiveGates({
      governanceMode: null,
      soloMode: false,
      requireDistinctReviewer: true,
      githubRepo: null,
    })[GateCode.DistinctReviewer];
    expect(result.active).toBe(true);
  });
});

describe("self-merge gate.describe()", () => {
  it("is active under REQUIRES_DISTINCT_REVIEWER", () => {
    const r = computeEffectiveGates({ ...DISTINCT, githubRepo: null })[
      GateCode.SelfMerge
    ];
    expect(r.active).toBe(true);
  });

  it("is inactive under AUTONOMOUS and AWAITS_CONFIRMATION", () => {
    expect(
      computeEffectiveGates({ ...AUTONOMOUS, githubRepo: null })[
        GateCode.SelfMerge
      ].active,
    ).toBe(false);
    expect(
      computeEffectiveGates({ ...CONFIRMATION, githubRepo: null })[
        GateCode.SelfMerge
      ].active,
    ).toBe(false);
  });
});

describe("task-status-for-merge gate.describe()", () => {
  it("is always active regardless of governance mode", () => {
    for (const mode of [AUTONOMOUS, DISTINCT, CONFIRMATION]) {
      const r = computeEffectiveGates({ ...mode, githubRepo: null })[
        GateCode.TaskStatusForMerge
      ];
      expect(r.active).toBe(true);
    }
  });
});

describe("task-status-for-merge check", () => {
  it("accepts review", () => {
    expect(checkTaskStatusForMerge({ status: "review" })).toEqual({ ok: true });
  });
  it("accepts done (idempotent retry)", () => {
    expect(checkTaskStatusForMerge({ status: "done" })).toEqual({ ok: true });
  });
  it("rejects open with currentStatus echoed back", () => {
    const r = checkTaskStatusForMerge({ status: "open" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("bad_status");
      expect(r.currentStatus).toBe("open");
    }
  });
  it("rejects in_progress", () => {
    const r = checkTaskStatusForMerge({ status: "in_progress" });
    expect(r.ok).toBe(false);
  });
  it("rejects unknown future states", () => {
    const r = checkTaskStatusForMerge({ status: "archived" });
    expect(r.ok).toBe(false);
  });
});

describe("pr-repo-matches-project gate.describe()", () => {
  it("is active when the project is bound to a GitHub repo", () => {
    const r = computeEffectiveGates({
      ...AUTONOMOUS,
      githubRepo: "LanNguyenSi/agent-tasks",
    })[GateCode.PrRepoMatchesProject];
    expect(r.active).toBe(true);
    expect(r.because).toContain("LanNguyenSi/agent-tasks");
  });

  it("is inactive when the project has no linked repo", () => {
    const r = computeEffectiveGates({ ...AUTONOMOUS, githubRepo: null })[
      GateCode.PrRepoMatchesProject
    ];
    expect(r.active).toBe(false);
  });

  it("is inactive when githubRepo is undefined (uninitialised select)", () => {
    const r = computeEffectiveGates({ ...AUTONOMOUS })[
      GateCode.PrRepoMatchesProject
    ];
    expect(r.active).toBe(false);
  });
});

describe("pr-repo-matches-project check", () => {
  const project = { githubRepo: "LanNguyenSi/agent-tasks" };

  it("accepts matching owner/repo (case-insensitive)", () => {
    expect(
      checkPrRepoMatchesProject(
        "https://github.com/LanNguyenSi/agent-tasks/pull/42",
        project,
      ),
    ).toEqual({ ok: true });
    expect(
      checkPrRepoMatchesProject(
        "https://github.com/lannguyensi/AGENT-TASKS/pull/42",
        project,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects cross-repo PR URL with structured details", () => {
    const r = checkPrRepoMatchesProject(
      "https://github.com/someone-else/their-repo/pull/7",
      project,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("cross_repo");
      expect(r.prOwner).toBe("someone-else");
      expect(r.prRepo).toBe("their-repo");
      expect(r.projectRepo).toBe("LanNguyenSi/agent-tasks");
    }
  });

  it("passes through non-PR URLs (URL validation belongs upstream)", () => {
    expect(
      checkPrRepoMatchesProject("https://example.com/not-a-pr", project),
    ).toEqual({ ok: true });
  });

  it("passes through when the project has no linked repo", () => {
    expect(
      checkPrRepoMatchesProject(
        "https://github.com/a/b/pull/1",
        { githubRepo: null },
      ),
    ).toEqual({ ok: true });
  });
});

describe("computeEffectiveGates — holistic examples", () => {
  it("soloMode + linked repo: only task-status + pr-repo gates are active", () => {
    const result = computeEffectiveGates({
      ...AUTONOMOUS,
      githubRepo: "owner/repo",
    });
    expect(result[GateCode.DistinctReviewer].active).toBe(false);
    expect(result[GateCode.SelfMerge].active).toBe(false);
    expect(result[GateCode.TaskStatusForMerge].active).toBe(true);
    expect(result[GateCode.PrRepoMatchesProject].active).toBe(true);
  });

  it("requireDistinctReviewer + no repo: only governance gates + task-status are active", () => {
    const result = computeEffectiveGates({
      ...DISTINCT,
      githubRepo: null,
    });
    expect(result[GateCode.DistinctReviewer].active).toBe(true);
    expect(result[GateCode.SelfMerge].active).toBe(true);
    expect(result[GateCode.TaskStatusForMerge].active).toBe(true);
    expect(result[GateCode.PrRepoMatchesProject].active).toBe(false);
  });
});
