/**
 * Workflow template registry: structural validation + gate wiring.
 *
 * Every template in `WORKFLOW_TEMPLATES` must pass the same server-side
 * `workflowDefinitionSchema` that guards the apply-template route, must
 * reference only real transition rules, and — for the gated edges — must
 * actually block when the required artifact is missing. These tests lock
 * that contract so a future template edit cannot ship a definition the
 * apply-template route would reject, or a gate the engine cannot evaluate.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { workflowDefinitionSchema } from "../../src/routes/workflows.js";
import {
  WORKFLOW_TEMPLATES,
  findWorkflowTemplate,
} from "../../src/services/workflow-templates.js";
import {
  evaluateTransitionRules,
  isKnownRule,
} from "../../src/services/transition-rules.js";
import type { WorkflowDefinitionShape } from "../../src/services/default-workflow.js";

// `prMerged` is an async rule that queries GitHub. Mock the fetch layer so
// the gate-behaviour tests are deterministic; everything else stays real so
// `GithubChecksError` / `fetchCheckRunStatus` keep working in transition-rules.
vi.mock("../../src/services/github-checks.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/services/github-checks.js")>();
  return { ...actual, fetchPullRequestStatus: vi.fn() };
});
import { fetchPullRequestStatus } from "../../src/services/github-checks.js";
const mockPrStatus = vi.mocked(fetchPullRequestStatus);

function transition(def: WorkflowDefinitionShape, from: string, to: string) {
  return def.transitions.find((t) => t.from === from && t.to === to);
}

describe("WORKFLOW_TEMPLATES registry", () => {
  it("is non-empty", () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("every template definition passes workflowDefinitionSchema", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const result = workflowDefinitionSchema.safeParse(t.definition);
      expect(result.success, `template "${t.slug}" failed schema`).toBe(true);
    }
  });

  it("every transition `requires` entry names a known transition rule", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      for (const tr of t.definition.transitions) {
        for (const rule of tr.requires ?? []) {
          expect(
            isKnownRule(rule),
            `template "${t.slug}" references unknown rule "${rule}"`,
          ).toBe(true);
        }
      }
    }
  });

  it("slugs are unique and non-empty", () => {
    const slugs = WORKFLOW_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s.length).toBeGreaterThan(0);
  });

  it("findWorkflowTemplate resolves every registered slug", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      expect(findWorkflowTemplate(t.slug)).toBe(t);
    }
  });

  it("findWorkflowTemplate returns undefined for an unknown slug", () => {
    expect(findWorkflowTemplate("no-such-template")).toBeUndefined();
  });
});

describe("branch-pr-merge-gated template", () => {
  const template = findWorkflowTemplate("branch-pr-merge-gated");
  const def = template!.definition;

  it("is registered", () => {
    expect(template).toBeDefined();
  });

  it("uses exactly the four locked states with the correct terminal flags", () => {
    const states = def.states.map((s) => s.name).sort();
    expect(states).toEqual(["done", "in_progress", "open", "review"]);
    const terminal = def.states.filter((s) => s.terminal).map((s) => s.name);
    expect(terminal).toEqual(["done"]);
  });

  it("has initialState open", () => {
    expect(def.initialState).toBe("open");
  });

  it("gives every state non-empty agentInstructions", () => {
    for (const s of def.states) {
      expect(s.agentInstructions, `state "${s.name}"`).toBeTruthy();
      expect(s.agentInstructions!.length).toBeGreaterThan(10);
    }
  });

  it("gates each transition exactly as specified", () => {
    expect(transition(def, "open", "in_progress")?.requires).toEqual([
      "branchPresent",
    ]);
    expect(transition(def, "in_progress", "review")?.requires).toEqual([
      "branchPresent",
      "prPresent",
    ]);
    expect(transition(def, "in_progress", "done")?.requires).toEqual([
      "branchPresent",
      "prPresent",
      "prMerged",
    ]);
    expect(transition(def, "review", "done")?.requires).toEqual(["prMerged"]);
    // Release and request-changes are deliberately ungated.
    expect(transition(def, "in_progress", "open")?.requires).toBeUndefined();
    expect(transition(def, "review", "in_progress")?.requires).toBeUndefined();
  });

  it("every edge into `done` requires a merged PR", () => {
    const intoDone = def.transitions.filter((t) => t.to === "done");
    expect(intoDone.length).toBeGreaterThan(0);
    for (const t of intoDone) {
      expect(t.requires, `${t.from} → done`).toContain("prMerged");
    }
  });

  describe("gate behaviour (evaluated through the template's requires)", () => {
    const fullCtx = {
      branchName: "feat/x",
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      projectGithubRepo: "o/r",
      githubToken: "ghs_test",
    };

    beforeEach(() => {
      mockPrStatus.mockReset();
      mockPrStatus.mockResolvedValue({ state: "merged", sha: "deadbeef" });
    });

    it("open → in_progress blocks without a branch, passes with one", async () => {
      const rules = transition(def, "open", "in_progress")!.requires;
      const missing = await evaluateTransitionRules(rules, {
        branchName: null,
        prUrl: null,
        prNumber: null,
      });
      expect(missing.failed).toEqual(["branchPresent"]);

      const present = await evaluateTransitionRules(rules, {
        branchName: "feat/x",
        prUrl: null,
        prNumber: null,
      });
      expect(present.failed).toEqual([]);
    });

    it("in_progress → review blocks until both branch and PR exist", async () => {
      const rules = transition(def, "in_progress", "review")!.requires;
      const none = await evaluateTransitionRules(rules, {
        branchName: null,
        prUrl: null,
        prNumber: null,
      });
      expect(none.failed).toEqual(["branchPresent", "prPresent"]);

      const branchOnly = await evaluateTransitionRules(rules, {
        branchName: "feat/x",
        prUrl: null,
        prNumber: null,
      });
      expect(branchOnly.failed).toEqual(["prPresent"]);

      const both = await evaluateTransitionRules(rules, {
        branchName: "feat/x",
        prUrl: "https://github.com/o/r/pull/7",
        prNumber: 7,
      });
      expect(both.failed).toEqual([]);
    });

    it("in_progress → done (skip review) blocks until the PR is merged", async () => {
      const rules = transition(def, "in_progress", "done")!.requires;

      mockPrStatus.mockResolvedValue({ state: "open", sha: "deadbeef" });
      const unmerged = await evaluateTransitionRules(rules, fullCtx);
      expect(unmerged.failed).toEqual(["prMerged"]);

      mockPrStatus.mockResolvedValue({ state: "merged", sha: "deadbeef" });
      const merged = await evaluateTransitionRules(rules, fullCtx);
      expect(merged.failed).toEqual([]);

      const noBranch = await evaluateTransitionRules(rules, {
        ...fullCtx,
        branchName: null,
      });
      expect(noBranch.failed).toContain("branchPresent");
    });

    it("review → done blocks until the PR is merged", async () => {
      const rules = transition(def, "review", "done")!.requires;

      mockPrStatus.mockResolvedValue({ state: "open", sha: "deadbeef" });
      const unmerged = await evaluateTransitionRules(rules, fullCtx);
      expect(unmerged.failed).toEqual(["prMerged"]);

      mockPrStatus.mockResolvedValue({ state: "merged", sha: "deadbeef" });
      const merged = await evaluateTransitionRules(rules, fullCtx);
      expect(merged.failed).toEqual([]);
    });
  });
});

describe("release-ops-no-pr template", () => {
  const template = findWorkflowTemplate("release-ops-no-pr");
  const def = template!.definition;

  it("is registered", () => {
    expect(template).toBeDefined();
  });

  it("uses exactly the four locked states with the correct terminal flags", () => {
    const states = def.states.map((s) => s.name).sort();
    expect(states).toEqual(["done", "in_progress", "open", "review"]);
    const terminal = def.states.filter((s) => s.terminal).map((s) => s.name);
    expect(terminal).toEqual(["done"]);
  });

  it("has initialState open", () => {
    expect(def.initialState).toBe("open");
  });

  it("gives every state non-empty agentInstructions", () => {
    for (const s of def.states) {
      expect(s.agentInstructions, `state "${s.name}"`).toBeTruthy();
      expect(s.agentInstructions!.length).toBeGreaterThan(10);
    }
  });

  it("drops branchPresent/prPresent on both in_progress → edges, unlike the default workflow", () => {
    expect(transition(def, "in_progress", "review")?.requires).toBeUndefined();
    expect(transition(def, "in_progress", "done")?.requires).toBeUndefined();
  });

  it("carries every other edge over ungated, same as the default workflow", () => {
    expect(transition(def, "open", "in_progress")?.requires).toBeUndefined();
    expect(transition(def, "in_progress", "open")?.requires).toBeUndefined();
    expect(transition(def, "review", "done")?.requires).toBeUndefined();
    expect(transition(def, "review", "in_progress")?.requires).toBeUndefined();
  });

  it("has no ciGreen/prMerged anywhere — there is no PR-shaped artifact left to gate on", () => {
    for (const t of def.transitions) {
      expect(t.requires ?? []).not.toContain("ciGreen");
      expect(t.requires ?? []).not.toContain("prMerged");
    }
  });

  it("has the same transition shape as the default workflow, minus the two dropped gates", () => {
    // Same (from, to, label) pairs as DEFAULT_TRANSITIONS — this template
    // is the default with exactly two `requires` arrays removed, nothing
    // else changed.
    const pairs = def.transitions
      .map((t) => `${t.from}→${t.to}:${t.label ?? ""}`)
      .sort();
    expect(pairs).toEqual(
      [
        "in_progress→done:Mark done",
        "in_progress→open:Release",
        "in_progress→review:Submit for review",
        "open→in_progress:Start",
        "review→done:Approve",
        "review→in_progress:Request changes",
      ].sort(),
    );
  });
});
