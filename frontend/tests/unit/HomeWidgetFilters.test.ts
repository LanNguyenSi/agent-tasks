/**
 * /home dashboard widget filter predicates
 * (isBacklogTask, isPriorityTask, src/app/home/page.tsx).
 *
 * Contract:
 *   - isBacklogTask matches only status "backlog". This is the assertion
 *     the task's mutation probe (swapping the status the Backlog widget
 *     filters on) is expected to turn red.
 *   - isPriorityTask matches HIGH/CRITICAL priority tasks whose status is
 *     actionable (open, in_progress, review): done and abandoned tasks are
 *     finished, and backlog drafts aren't actionable until promoted (they
 *     surface in their own widget instead).
 */
import { describe, it, expect } from "vitest";
import {
  ACTIVE_STATUSES,
  ACTIVE_STATUS_PARAM,
  isActiveTask,
  isBacklogTask,
  isPriorityTask,
  actionableStatusParam,
  terminalStatesResolver,
} from "../../src/app/home/widgetFilters";
import type { Workflow } from "../../src/lib/api";

describe("isBacklogTask", () => {
  it("matches a backlog-status task", () => {
    expect(isBacklogTask({ status: "backlog" })).toBe(true);
  });

  it("does not match open/review/done/in_progress", () => {
    expect(isBacklogTask({ status: "open" })).toBe(false);
    expect(isBacklogTask({ status: "in_progress" })).toBe(false);
    expect(isBacklogTask({ status: "review" })).toBe(false);
    expect(isBacklogTask({ status: "done" })).toBe(false);
  });
});

describe("isPriorityTask", () => {
  it("matches an open HIGH-priority task", () => {
    expect(isPriorityTask({ priority: "HIGH", status: "open" })).toBe(true);
  });

  it("matches an open CRITICAL-priority task", () => {
    expect(isPriorityTask({ priority: "CRITICAL", status: "in_progress" })).toBe(true);
  });

  it("excludes a done task even at CRITICAL priority", () => {
    expect(isPriorityTask({ priority: "CRITICAL", status: "done" })).toBe(false);
  });

  it("excludes a backlog task even at HIGH/CRITICAL priority (unpromoted drafts have their own widget)", () => {
    expect(isPriorityTask({ priority: "HIGH", status: "backlog" })).toBe(false);
    expect(isPriorityTask({ priority: "CRITICAL", status: "backlog" })).toBe(false);
  });

  it("excludes an abandoned task even at HIGH/CRITICAL priority", () => {
    expect(isPriorityTask({ priority: "HIGH", status: "abandoned" })).toBe(false);
    expect(isPriorityTask({ priority: "CRITICAL", status: "abandoned" })).toBe(false);
  });

  it("matches a HIGH-priority task in review", () => {
    expect(isPriorityTask({ priority: "HIGH", status: "review" })).toBe(true);
  });

  it("excludes a status outside the actionable set", () => {
    expect(isPriorityTask({ priority: "CRITICAL", status: "some_future_status" })).toBe(false);
  });

  it("excludes a MEDIUM/LOW priority task regardless of status", () => {
    expect(isPriorityTask({ priority: "MEDIUM", status: "open" })).toBe(false);
    expect(isPriorityTask({ priority: "LOW", status: "open" })).toBe(false);
  });
});

describe("isActiveTask (the one definition of active work)", () => {
  it("matches open and in_progress", () => {
    expect(isActiveTask({ status: "open" })).toBe(true);
    expect(isActiveTask({ status: "in_progress" })).toBe(true);
  });

  it("does not match review, backlog, done or abandoned", () => {
    expect(isActiveTask({ status: "review" })).toBe(false);
    expect(isActiveTask({ status: "backlog" })).toBe(false);
    expect(isActiveTask({ status: "done" })).toBe(false);
    expect(isActiveTask({ status: "abandoned" })).toBe(false);
  });

  it("builds the status request value from the same list", () => {
    expect(ACTIVE_STATUSES).toEqual(["open", "in_progress"]);
    expect(ACTIVE_STATUS_PARAM).toBe("open,in_progress");
  });
});

// ── Workflow-aware priority rule ──────────────────────────────────────────────
//
// The backend's home count (counts.priority, routes/tasks.ts) counts a HIGH or
// CRITICAL task unless it is backlog, abandoned or in a terminal state of ITS
// workflow (the pinned one, else the project default, else the built-in). The
// widget rows go through the same rule once the workflows are known.

function workflow(over: Partial<Workflow> & { id: string; states: [string, boolean][] }): Workflow {
  return {
    projectId: "p1",
    name: over.id,
    isDefault: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
    definition: {
      states: over.states.map(([name, terminal]) => ({ name, label: name, terminal })),
      transitions: [],
      initialState: over.states[0]![0],
    },
  } as Workflow;
}

// A seven-stage style workflow: qa is open work, shipped and wontfix are finished.
const SEVEN = workflow({
  id: "wf-seven",
  isDefault: true,
  states: [["open", false], ["qa", false], ["shipped", true], ["wontfix", true]],
});

describe("isPriorityTask with a custom workflow", () => {
  const byProject = new Map<string, Workflow[]>([["p1", [SEVEN]]]);
  const of = terminalStatesResolver(byProject);
  const hi = (status: string, extra: Record<string, unknown> = {}) =>
    isPriorityTask({ priority: "HIGH", status, projectId: "p1", ...extra }, of);

  it("counts a custom non-terminal state as open", () => {
    expect(hi("qa")).toBe(true);
  });

  it("counts a custom terminal state as done", () => {
    expect(hi("shipped")).toBe(false);
    expect(hi("wontfix")).toBe(false);
  });

  it("keeps backlog and abandoned out, whatever the workflow says", () => {
    expect(hi("backlog")).toBe(false);
    expect(hi("abandoned")).toBe(false);
  });

  it("still needs HIGH or CRITICAL", () => {
    expect(isPriorityTask({ priority: "MEDIUM", status: "qa", projectId: "p1" }, of)).toBe(false);
    expect(isPriorityTask({ priority: "CRITICAL", status: "qa", projectId: "p1" }, of)).toBe(true);
  });

  it("reads `done` as open when the project's workflow does not make it terminal", () => {
    // Same as the backend: terminal means terminal in the task's own workflow.
    expect(hi("done")).toBe(true);
  });

  it("uses the pinned workflow of a task before the project default", () => {
    const pinned = workflow({ id: "wf-pinned", states: [["open", false], ["qa", true]] });
    const resolver = terminalStatesResolver(new Map([["p1", [SEVEN, pinned]]]));
    const task = { priority: "HIGH" as const, status: "qa", projectId: "p1" };
    expect(isPriorityTask(task, resolver)).toBe(true);
    expect(isPriorityTask({ ...task, workflowId: "wf-pinned" }, resolver)).toBe(false);
    // A pin that matches no loaded row falls back to the default, like the backend.
    expect(isPriorityTask({ ...task, workflowId: "gone" }, resolver)).toBe(true);
  });

  it("takes the first default row of a project, as the backend does", () => {
    const second = workflow({ id: "wf-second", isDefault: true, states: [["open", false], ["qa", true]] });
    const resolver = terminalStatesResolver(new Map([["p1", [SEVEN, second]]]));
    expect(isPriorityTask({ priority: "HIGH", status: "qa", projectId: "p1" }, resolver)).toBe(true);
  });

  it("falls back to the built-in workflow for a project with no stored default", () => {
    const resolver = terminalStatesResolver(new Map([["p1", [workflow({ id: "wf-x", states: [["qa", true]] })]]]));
    expect(isPriorityTask({ priority: "HIGH", status: "done", projectId: "p1" }, resolver)).toBe(false);
    expect(isPriorityTask({ priority: "HIGH", status: "open", projectId: "p1" }, resolver)).toBe(true);
    expect(isPriorityTask({ priority: "HIGH", status: "review", projectId: "other" }, resolver)).toBe(true);
    expect(isPriorityTask({ priority: "HIGH", status: "done", projectId: "other" }, resolver)).toBe(false);
  });

  it("reads an unreadable stored definition as the built-in workflow, like the backend", () => {
    const broken = { ...SEVEN, id: "wf-broken", definition: { states: "garbage" } } as unknown as Workflow;
    const resolver = terminalStatesResolver(new Map([["p1", [broken]]]));
    expect(isPriorityTask({ priority: "HIGH", status: "done", projectId: "p1" }, resolver)).toBe(false);
    expect(isPriorityTask({ priority: "HIGH", status: "qa", projectId: "p1" }, resolver)).toBe(true);
  });

  it("matches the four-state rule when the project has the built-in workflow", () => {
    const builtin = terminalStatesResolver(new Map());
    for (const status of ["open", "in_progress", "review"]) {
      expect(isPriorityTask({ priority: "HIGH", status, projectId: "p1" }, builtin)).toBe(true);
    }
    for (const status of ["done", "backlog", "abandoned"]) {
      expect(isPriorityTask({ priority: "HIGH", status, projectId: "p1" }, builtin)).toBe(false);
    }
  });
});

describe("actionableStatusParam", () => {
  it("is the built-in actionable list while no workflow is known", () => {
    expect(actionableStatusParam(new Map())).toBe("open,in_progress,review");
  });

  it("adds the non-terminal states of every stored workflow, once", () => {
    const other = workflow({ id: "wf-o", projectId: "p2", states: [["open", false], ["triage", false], ["qa", false], ["closed", true]] });
    expect(actionableStatusParam(new Map([["p1", [SEVEN]], ["p2", [other]]]))).toBe(
      "open,in_progress,review,qa,triage",
    );
  });

  it("never asks for backlog or abandoned, even if a stored definition names them", () => {
    const odd = workflow({ id: "wf-b", states: [["backlog", false], ["abandoned", false], ["qa", false]] });
    expect(actionableStatusParam(new Map([["p1", [odd]]]))).toBe("open,in_progress,review,qa");
  });
});
