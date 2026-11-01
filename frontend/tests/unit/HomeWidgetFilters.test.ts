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
  activeStatesResolver,
  activeStatusParam,
  isActiveTask,
  isBacklogTask,
  isPriorityTask,
  actionableStatusParam,
  isActionableTask,
  reviewStatesResolver,
  terminalStatesResolver,
  widgetRequest,
  workflowStatusNames,
  WIDGET_REQUESTS,
  type WidgetKey,
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

  it("is safe as a bare Array.filter callback (the row index arrives as a second argument)", () => {
    expect([{ status: "open" }, { status: "qa" }].filter(isActiveTask).length).toBe(1);
  });

  it("builds the status request value from the same list", () => {
    expect(ACTIVE_STATUSES).toEqual(["open", "in_progress"]);
    expect(ACTIVE_STATUS_PARAM).toBe("open,in_progress");
  });
});

describe("isActiveTask with a workflow resolver (active = not terminal, not review-like)", () => {
  // QA_FLOW is defined further down (with the review-like fixtures); the
  // resolver is built per call so collecting this block stays order-safe.
  const on = (status: string, projectId = "p1") =>
    isActiveTask({ status, projectId }, activeStatesResolver(new Map([["p1", [QA_FLOW]]])));

  it("counts a non-terminal non-review-like state of the task's own workflow", () => {
    expect(on("open")).toBe(true);
    expect(on("work")).toBe(true);
  });

  it("does not count the review-like or terminal state of that workflow", () => {
    expect(on("qa")).toBe(false); // review-like in QA_FLOW
    expect(on("shipped")).toBe(false);
    expect(on("wontfix")).toBe(false);
  });

  it("does not count a name that is no state of that workflow", () => {
    // in_progress is active in the built-in workflow and in another project,
    // but QA_FLOW has no such state: the task's own workflow decides.
    expect(on("in_progress")).toBe(false);
    expect(on("in_progress", "p2")).toBe(true); // p2 is not loaded: built-in
  });

  it("keeps backlog and abandoned out, whatever the workflow says", () => {
    expect(on("backlog")).toBe(false);
    expect(on("abandoned")).toBe(false);
  });

  it("is exactly open + in_progress for the four-state (built-in) workflow", () => {
    const builtin = activeStatesResolver(new Map());
    for (const status of ["open", "in_progress"]) {
      expect(isActiveTask({ status, projectId: "p1" }, builtin)).toBe(true);
    }
    for (const status of ["review", "done", "backlog", "abandoned", "qa"]) {
      expect(isActiveTask({ status, projectId: "p1" }, builtin)).toBe(false);
    }
  });

  it("uses the pinned workflow of a task before the project default", () => {
    const pinned = def(
      "open",
      [["open", false], ["build", false], ["audit", false], ["closed", true]],
      [["open", "build"], ["build", "audit"], ["audit", "closed"]],
      { id: "wf-pinned", isDefault: false },
    );
    const resolver = activeStatesResolver(new Map([["p1", [QA_FLOW, pinned]]]));
    expect(isActiveTask({ status: "work", projectId: "p1" }, resolver)).toBe(true);
    expect(isActiveTask({ status: "work", projectId: "p1", workflowId: "wf-pinned" }, resolver)).toBe(false);
    expect(isActiveTask({ status: "build", projectId: "p1", workflowId: "wf-pinned" }, resolver)).toBe(true);
    expect(isActiveTask({ status: "audit", projectId: "p1", workflowId: "wf-pinned" }, resolver)).toBe(false);
  });

  it("reads an unreadable stored definition as the built-in active names", () => {
    const broken = { ...QA_FLOW, id: "wf-broken", definition: { states: "garbage" } } as unknown as Workflow;
    const resolver = activeStatesResolver(new Map([["p1", [broken]]]));
    expect(isActiveTask({ status: "open", projectId: "p1" }, resolver)).toBe(true);
    expect(isActiveTask({ status: "in_progress", projectId: "p1" }, resolver)).toBe(true);
    expect(isActiveTask({ status: "work", projectId: "p1" }, resolver)).toBe(false);
    // A transitions list the backend cannot read sends its whole active list
    // back to the built-in names too (the review-like judgement needs it).
    const noTransitions = {
      ...QA_FLOW,
      id: "wf-notransitions",
      definition: { ...(QA_FLOW.definition as object), transitions: "x" },
    } as unknown as Workflow;
    const resolver2 = activeStatesResolver(new Map([["p1", [noTransitions]]]));
    expect(isActiveTask({ status: "work", projectId: "p1" }, resolver2)).toBe(false);
    expect(isActiveTask({ status: "in_progress", projectId: "p1" }, resolver2)).toBe(true);
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

// ── Review-like and terminal names, widget requests ───────────────────────────
//
// reviewStatesResolver is a port of the backend's isReviewState
// (services/default-workflow.ts). The expected names below are what the
// backend's reviewStates() / terminalStates() return for the same definitions
// (measured by running them on these fixtures); the workflow rows here are the
// frontend shape of those definitions.

function def(
  initialState: string,
  states: [string, boolean][],
  edges: [string, string][],
  over: Partial<Workflow> & { id: string },
): Workflow {
  return {
    projectId: "p1",
    name: over.id,
    isDefault: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
    definition: {
      states: states.map(([name, terminal]) => ({ name, label: name, terminal })),
      transitions: edges.map(([from, to]) => ({ from, to })),
      initialState,
    },
  } as Workflow;
}

const BUILT_IN_DEF = def(
  "open",
  [["open", false], ["in_progress", false], ["review", false], ["done", true]],
  [["open", "in_progress"], ["in_progress", "review"], ["in_progress", "done"], ["in_progress", "open"], ["review", "done"], ["review", "in_progress"]],
  { id: "wf-builtin" },
);

// The retired seven-stage pipeline with `open` as its entry state.
const SEVEN_STAGE = def(
  "open",
  [["open", false], ["spec", false], ["plan", false], ["implement", false], ["test", false], ["review", false], ["done", true]],
  [
    ["open", "spec"], ["spec", "plan"], ["plan", "implement"], ["implement", "test"], ["test", "review"],
    ["test", "implement"], ["review", "done"], ["review", "implement"], ["implement", "plan"], ["plan", "spec"], ["spec", "open"],
  ],
  { id: "wf-seven-stage" },
);

// Custom names: qa is the review-like state, shipped and wontfix are finished.
const QA_FLOW = def(
  "open",
  [["open", false], ["work", false], ["qa", false], ["shipped", true], ["wontfix", true]],
  [["open", "work"], ["work", "qa"], ["qa", "shipped"], ["qa", "work"], ["work", "wontfix"]],
  { id: "wf-qa" },
);

// The entry state has an edge to a terminal one and the terminal states `done` and
// `closed` have edges to each other (none of them is review-like); hotfix is reachable from the entry state and ends in a
// terminal one (not review-like); check is two steps in (review-like); lonely has no edge
// to a terminal state.
const EDGY = def(
  "open",
  [["open", false], ["hotfix", false], ["work", false], ["check", false], ["done", true], ["closed", true], ["lonely", false]],
  [["open", "done"], ["done", "closed"], ["closed", "done"], ["open", "hotfix"], ["hotfix", "done"], ["open", "work"], ["work", "check"], ["check", "done"], ["check", "work"], ["open", "lonely"]],
  { id: "wf-edgy" },
);

const taskIn = (projectId: string, workflowId?: string) => ({ projectId, workflowId });

describe("reviewStatesResolver: parity with the backend isReviewState", () => {
  it.each([
    ["built-in workflow", BUILT_IN_DEF, ["review"]],
    ["seven-stage workflow", SEVEN_STAGE, ["review"]],
    ["custom review-like name", QA_FLOW, ["qa"]],
    ["entry-state targets and dead ends are not review-like", EDGY, ["check"]],
  ])("%s", (_label, wf, expected) => {
    expect([...reviewStatesResolver(new Map([["p1", [wf]]]))(taskIn("p1"))].sort()).toEqual(expected);
  });

  it("reads the legacy backlog-entry shape like the sanitized backend definition", () => {
    // Stored with initialState backlog and a backlog state; the backend's
    // sanitizeStoredDefinition turns the entry state into open and reviewStates()
    // then answers `review`.
    const legacy = def(
      "backlog",
      [["backlog", false], ["spec", false], ["plan", false], ["implement", false], ["test", false], ["review", false], ["done", true]],
      [["backlog", "spec"], ["spec", "plan"], ["spec", "backlog"], ["plan", "implement"], ["implement", "test"], ["test", "review"], ["review", "done"], ["review", "implement"]],
      { id: "wf-legacy" },
    );
    expect([...reviewStatesResolver(new Map([["p1", [legacy]]]))(taskIn("p1"))]).toEqual(["review"]);
  });

  it("never lists backlog, and lists abandoned only where the stored definition makes it review-like like the backend does", () => {
    const odd = def("open", [["open", false], ["backlog", false], ["abandoned", false], ["done", true]], [["open", "backlog"], ["backlog", "done"], ["abandoned", "done"]], { id: "wf-odd" });
    expect([...reviewStatesResolver(new Map([["p1", [odd]]]))(taskIn("p1"))]).toEqual(["abandoned"]);
  });

  it("reads a project that is not loaded as the built-in workflow", () => {
    expect([...reviewStatesResolver(new Map())(taskIn("p9"))]).toEqual(["review"]);
  });

  it("reads an unreadable stored definition as the built-in workflow", () => {
    const broken = { ...BUILT_IN_DEF, id: "wf-x", definition: null } as unknown as Workflow;
    expect([...reviewStatesResolver(new Map([["p1", [broken]]]))(taskIn("p1"))]).toEqual(["review"]);
  });

  it("uses the pinned workflow of a task before the project default", () => {
    const pinned = def("open", [["open", false], ["work", false], ["audit", false], ["closed", true]], [["open", "work"], ["work", "audit"], ["audit", "closed"]], { id: "wf-pinned", isDefault: false });
    const resolve = reviewStatesResolver(new Map([["p1", [QA_FLOW, pinned]]]));
    expect([...resolve(taskIn("p1"))]).toEqual(["qa"]);
    expect([...resolve(taskIn("p1", "wf-pinned"))]).toEqual(["audit"]);
  });
});

describe("workflowStatusNames", () => {
  it("is the built-in lists while no workflow is known", () => {
    expect(workflowStatusNames(new Map())).toEqual({
      actionable: ["open", "in_progress", "review"],
      review: ["review"],
      terminal: ["done"],
    });
  });

  it("adds the custom names of the stored workflows after the built-in ones", () => {
    expect(workflowStatusNames(new Map([["p1", [QA_FLOW]]]))).toEqual({
      actionable: ["open", "in_progress", "review", "work", "qa"],
      review: ["review", "qa"],
      terminal: ["done", "shipped", "wontfix"],
    });
  });

  it("lists the seven-stage names", () => {
    const names = workflowStatusNames(new Map([["p1", [SEVEN_STAGE]]]));
    expect(names.actionable).toEqual(["open", "in_progress", "review", "spec", "plan", "implement", "test"]);
    expect(names.review).toEqual(["review"]);
    expect(names.terminal).toEqual(["done"]);
  });

  it("keeps a name that is terminal in one workflow and open in another in both lists", () => {
    const other = def("open", [["open", false], ["shipped", false], ["closed", true]], [["open", "shipped"], ["shipped", "closed"]], { id: "wf-o", projectId: "p2" });
    const names = workflowStatusNames(new Map([["p1", [QA_FLOW]], ["p2", [other]]]));
    expect(names.terminal).toContain("shipped");
    expect(names.actionable).toContain("shipped");
  });

  it("agrees with actionableStatusParam", () => {
    const byProject = new Map([["p1", [QA_FLOW]]]);
    expect(actionableStatusParam(byProject)).toBe(workflowStatusNames(byProject).actionable.join(","));
  });
});

describe("isActionableTask", () => {
  const resolve = terminalStatesResolver(new Map([["p1", [QA_FLOW]]]));

  it("counts a custom non-terminal state, not a custom terminal one", () => {
    expect(isActionableTask({ status: "qa", projectId: "p1" }, resolve)).toBe(true);
    expect(isActionableTask({ status: "shipped", projectId: "p1" }, resolve)).toBe(false);
  });

  it("keeps backlog and abandoned out", () => {
    expect(isActionableTask({ status: "backlog", projectId: "p1" }, resolve)).toBe(false);
    expect(isActionableTask({ status: "abandoned", projectId: "p1" }, resolve)).toBe(false);
  });

  it("is the built-in allowlist without a resolver", () => {
    expect(isActionableTask({ status: "review" })).toBe(true);
    expect(isActionableTask({ status: "qa" })).toBe(false);
  });
});

describe("widgetRequest", () => {
  const KEYS = Object.keys(WIDGET_REQUESTS) as WidgetKey[];
  const byProject = new Map([["p1", [QA_FLOW]]]);

  it("is the fixed request of every widget while no workflow is known", () => {
    for (const key of KEYS) expect(widgetRequest(key, new Map())).toEqual(WIDGET_REQUESTS[key]);
  });

  it("asks the mine widget for the actionable names, mine only", () => {
    expect(widgetRequest("mine", byProject)).toEqual({ ...WIDGET_REQUESTS.mine, status: "open,in_progress,review,work,qa" });
  });

  it("asks the priority widget for the actionable names and the priority filter", () => {
    expect(widgetRequest("priority", byProject)).toEqual({ ...WIDGET_REQUESTS.priority, status: "open,in_progress,review,work,qa" });
  });

  it("asks the review widget for the review-like names", () => {
    expect(widgetRequest("review", byProject)).toEqual({ ...WIDGET_REQUESTS.review, status: "review,qa" });
  });

  it("asks the done widget for the terminal names and keeps the recency window", () => {
    const r = widgetRequest("done", byProject);
    expect(r.status).toBe("done,shipped,wontfix");
    expect(r.recency).toBe("recent");
  });

  it("asks the active widget for the active names of the stored workflows", () => {
    // work is open work in QA_FLOW, qa is review-like and shipped/wontfix are
    // terminal, so only work is added to the built-in active pair.
    expect(widgetRequest("open", byProject)).toEqual({
      ...WIDGET_REQUESTS.open,
      status: "open,in_progress,work",
    });
  });

  it("leaves the backlog widget alone", () => {
    expect(widgetRequest("backlog", byProject)).toEqual(WIDGET_REQUESTS.backlog);
  });
});

describe("activeStatusParam", () => {
  it("is the built-in active pair while no workflow is known", () => {
    expect(activeStatusParam(new Map())).toBe("open,in_progress");
    expect(activeStatusParam(new Map())).toBe(ACTIVE_STATUS_PARAM);
  });

  it("adds the active states of every stored workflow, never its review-like or terminal ones", () => {
    expect(activeStatusParam(new Map([["p1", [QA_FLOW]]]))).toBe("open,in_progress,work");
  });

  it("lists the seven-stage active states (review is review-like there)", () => {
    expect(activeStatusParam(new Map([["p1", [SEVEN_STAGE]]]))).toBe(
      "open,in_progress,spec,plan,implement,test",
    );
  });

  it("never asks for backlog or abandoned, even if a stored definition names them", () => {
    const odd = def("open", [["open", false], ["backlog", false], ["abandoned", false], ["triage", false], ["done", true]], [["open", "triage"], ["triage", "done"]], { id: "wf-odd" });
    expect(activeStatusParam(new Map([["p1", [odd]]]))).toBe("open,in_progress,triage");
  });
});
