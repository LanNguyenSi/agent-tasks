/**
 * Helpers that replace the literal `review` / `done` in the engine paths:
 * the terminal target of an approve or autoMerge finish, the rejection text of
 * the merge status gate, and the in-code status check against loaded workflow
 * rows. Each one keeps the built-in text and result, and follows a custom
 * vocabulary where the workflow has one.
 */
import { describe, expect, it } from "vitest";
import {
  defaultWorkflowDefinition,
  isKnownState,
  terminalTargetFrom,
  type WorkflowDefinitionShape,
} from "../../src/services/default-workflow.js";
import { taskStatusForMergeRejectionMessage } from "../../src/services/gates/task-status-for-merge.js";
import { buildTaskStatusFilter, isStatusOfKind, type WorkflowRow } from "../../src/services/workflow-status-filter.js";
import { clearAllClaims, clearReview, clearWork } from "../../src/services/task-claim-fields.js";
import { CUSTOM_VOCABULARY_DEFINITION, OPEN_TO_REVIEW_DEFINITION } from "../helpers/custom-vocabulary-workflow.js";

/** Two terminal states and an edge into each, to pin which one an approve picks. */
const TWO_TERMINALS: WorkflowDefinitionShape = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "build", label: "Build", terminal: false },
    { name: "qa", label: "QA", terminal: false },
    { name: "cancelled", label: "Cancelled", terminal: true },
    { name: "shipped", label: "Shipped", terminal: true },
  ],
  transitions: [
    { from: "open", to: "build" },
    { from: "build", to: "qa" },
    { from: "qa", to: "shipped" },
    { from: "build", to: "cancelled" },
  ],
};

describe("terminalTargetFrom", () => {
  it("is `done` for the built-in workflow from review and from in_progress", () => {
    const def = defaultWorkflowDefinition();
    expect(terminalTargetFrom(def, "review")).toBe("done");
    expect(terminalTargetFrom(def, "in_progress")).toBe("done");
  });

  it("follows the edge of the state the task is in", () => {
    expect(terminalTargetFrom(TWO_TERMINALS, "qa")).toBe("shipped");
    expect(terminalTargetFrom(TWO_TERMINALS, "build")).toBe("cancelled");
  });

  it("falls back to the first terminal state when the state has no edge into one", () => {
    expect(terminalTargetFrom(CUSTOM_VOCABULARY_DEFINITION, "plan")).toBe("shipped");
  });

  it("falls back to `done` only for a definition without any terminal state", () => {
    const noTerminal: WorkflowDefinitionShape = {
      initialState: "open",
      states: [{ name: "open", label: "Open", terminal: false }],
      transitions: [],
    };
    expect(terminalTargetFrom(noTerminal, "open")).toBe("done");
  });
});

describe("isKnownState", () => {
  it("is true for a state of the definition and false for any other name", () => {
    expect(isKnownState(CUSTOM_VOCABULARY_DEFINITION, "qa")).toBe(true);
    expect(isKnownState(CUSTOM_VOCABULARY_DEFINITION, "review")).toBe(false);
    expect(isKnownState(CUSTOM_VOCABULARY_DEFINITION, "backlog")).toBe(false);
  });
});

describe("taskStatusForMergeRejectionMessage", () => {
  it("keeps the built-in texts word for word", () => {
    expect(taskStatusForMergeRejectionMessage("open")).toBe(
      "Cannot merge: task is in 'open', expected 'review'. Transition the task to 'review' first (POST /tasks/:id/transition) — or, if you need to bypass the review flow entirely, force-transition to 'done' as an admin and then re-run this merge.",
    );
    expect(taskStatusForMergeRejectionMessage("in_progress")).toContain("expected 'review'. Transition the task to 'review' first");
    expect(taskStatusForMergeRejectionMessage("backlog")).toBe("Cannot merge: task is in 'backlog', expected 'review' or 'done'.");
  });

  it("names the review and terminal states of the workflow for one of its own states", () => {
    expect(taskStatusForMergeRejectionMessage("build", CUSTOM_VOCABULARY_DEFINITION)).toBe(
      "Cannot merge: task is in 'build', expected 'qa'. Transition the task to 'qa' first (POST /tasks/:id/transition) — or, if you need to bypass the review flow entirely, force-transition to 'shipped' as an admin and then re-run this merge.",
    );
  });

  it("lists the accepted states for a status the workflow does not define", () => {
    expect(taskStatusForMergeRejectionMessage("review", CUSTOM_VOCABULARY_DEFINITION)).toBe(
      "Cannot merge: task is in 'review', expected 'qa' or 'shipped'.",
    );
    expect(taskStatusForMergeRejectionMessage("abandoned", TWO_TERMINALS)).toBe(
      "Cannot merge: task is in 'abandoned', expected 'qa', 'cancelled' or 'shipped'.",
    );
  });

  it("does not promise a review state a workflow without one cannot offer", () => {
    expect(taskStatusForMergeRejectionMessage("review", OPEN_TO_REVIEW_DEFINITION)).toBe("Cannot merge: task is in 'review', expected 'done'.");
  });
});

describe("isStatusOfKind", () => {
  const row = (over: Partial<WorkflowRow> & Pick<WorkflowRow, "id" | "definition">): WorkflowRow => ({
    projectId: "p1",
    isDefault: false,
    ...over,
  });
  const qa = row({ id: "wf-qa", definition: CUSTOM_VOCABULARY_DEFINITION });
  const doneIsWork = row({
    id: "wf-done-work",
    definition: {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "done", label: "Done", terminal: false },
        { name: "shipped", label: "Shipped", terminal: true },
      ],
      transitions: [
        { from: "open", to: "done" },
        { from: "done", to: "shipped" },
      ],
    },
  });

  it("judges a pinned task by its pinned workflow", () => {
    const task = { workflowId: "wf-qa", projectId: "p1", status: "shipped" };
    expect(isStatusOfKind([qa, doneIsWork], task, "terminal")).toBe(true);
    expect(isStatusOfKind([qa, doneIsWork], { ...task, status: "done" }, "terminal")).toBe(false);
    expect(isStatusOfKind([qa, doneIsWork], { ...task, status: "qa" }, "review")).toBe(true);
  });

  it("judges a state name per workflow: `done` is terminal in the built-in workflow and a work state in another", () => {
    expect(isStatusOfKind([], { workflowId: null, projectId: "p1", status: "done" }, "terminal")).toBe(true);
    expect(isStatusOfKind([doneIsWork], { workflowId: "wf-done-work", projectId: "p1", status: "done" }, "terminal")).toBe(false);
  });

  it("judges an unpinned task by the first default row of its project, else the built-in workflow", () => {
    const projectDefault = row({ id: "wf-default", definition: CUSTOM_VOCABULARY_DEFINITION, isDefault: true });
    const task = { workflowId: null, projectId: "p1", status: "shipped" };
    expect(isStatusOfKind([projectDefault], task, "terminal")).toBe(true);
    expect(isStatusOfKind([projectDefault], { ...task, status: "done" }, "terminal")).toBe(false);
    // Another project's default row does not apply.
    expect(isStatusOfKind([projectDefault], { ...task, projectId: "p2", status: "done" }, "terminal")).toBe(true);
    // A non-default row of the project does not apply to an unpinned task.
    expect(isStatusOfKind([qa], { ...task, status: "shipped" }, "terminal")).toBe(false);
  });

  it("falls back to the project default when the pinned row is not among the rows", () => {
    const projectDefault = row({ id: "wf-default", definition: CUSTOM_VOCABULARY_DEFINITION, isDefault: true });
    expect(isStatusOfKind([projectDefault], { workflowId: "gone", projectId: "p1", status: "shipped" }, "terminal")).toBe(true);
  });

  it("falls back per kind when the stored definition is partly unreadable", () => {
    const transitionsBroken = row({
      id: "wf-broken",
      definition: { initialState: "open", states: CUSTOM_VOCABULARY_DEFINITION.states, transitions: "x" } as unknown as WorkflowDefinitionShape,
    });
    const task = { workflowId: "wf-broken", projectId: "p1" };
    // Terminal states are readable from `states`; review-like ones need the transitions.
    expect(isStatusOfKind([transitionsBroken], { ...task, status: "shipped" }, "terminal")).toBe(true);
    expect(isStatusOfKind([transitionsBroken], { ...task, status: "done" }, "terminal")).toBe(false);
    expect(isStatusOfKind([transitionsBroken], { ...task, status: "review" }, "review")).toBe(true);
    expect(isStatusOfKind([transitionsBroken], { ...task, status: "qa" }, "review")).toBe(false);

    const statesBroken = row({
      id: "wf-states-broken",
      definition: { initialState: "open", states: "x", transitions: [] } as unknown as WorkflowDefinitionShape,
    });
    expect(isStatusOfKind([statesBroken], { workflowId: "wf-states-broken", projectId: "p1", status: "done" }, "terminal")).toBe(true);
    expect(isStatusOfKind([statesBroken], { workflowId: "wf-states-broken", projectId: "p1", status: "review" }, "review")).toBe(true);
  });

  it("builds one terminal condition per workflow plus the built-in branch", () => {
    const filter = buildTaskStatusFilter([qa], { kind: "terminal", match: "in" });
    expect(filter).toEqual({ OR: [{ workflowId: { in: ["wf-qa"] }, status: { in: ["shipped"] } }, { workflowId: null, status: { in: ["done"] } }] });
  });
});

describe("isStatusOfKind with kind 'active' (the Active counts rule)", () => {
  // active = a state of the task's own workflow that is neither terminal nor
  // review-like, and never backlog or abandoned. The custom vocabulary below
  // is open -> plan -> build -> qa -> shipped with qa review-like, so its
  // active states are open, plan and build; the built-in four-state workflow
  // answers exactly open + in_progress.
  const customDefault: WorkflowRow = {
    id: "wf-custom",
    projectId: "p1",
    isDefault: true,
    definition: CUSTOM_VOCABULARY_DEFINITION,
  };
  const task = (projectId: string, status: string): { workflowId: null; projectId: string; status: string } => ({
    workflowId: null,
    projectId,
    status,
  });

  it("a build task of the custom workflow counts as active, a shipped one does not", () => {
    expect(isStatusOfKind([customDefault], task("p1", "build"), "active")).toBe(true);
    expect(isStatusOfKind([customDefault], task("p1", "shipped"), "active")).toBe(false);
  });

  it("counts every non-terminal non-review-like state of the custom workflow", () => {
    for (const status of ["open", "plan", "build"]) {
      expect(isStatusOfKind([customDefault], task("p1", status), "active")).toBe(true);
    }
    // qa is review-like, shipped terminal, backlog/abandoned never count,
    // and a name that is no state of the workflow never counts either.
    for (const status of ["qa", "shipped", "backlog", "abandoned", "triage_legacy", "done"]) {
      expect(isStatusOfKind([customDefault], task("p1", status), "active")).toBe(false);
    }
  });

  it("does not count a stranded status the task's own workflow does not have (intentional: a task left on a removed state is not active work)", () => {
    const noBuild: WorkflowRow = {
      id: "wf-no-build",
      projectId: "p1",
      isDefault: true,
      definition: {
        initialState: "open",
        states: [
          { name: "open", label: "Open", terminal: false },
          { name: "ship", label: "Ship", terminal: true },
        ],
        transitions: [{ from: "open", to: "ship" }],
      },
    };
    const stranded = { workflowId: "wf-no-build", projectId: "p1", status: "build" };
    expect(isStatusOfKind([noBuild], stranded, "active")).toBe(false);
    // The workflow itself keeps answering its own states.
    expect(isStatusOfKind([noBuild], { ...stranded, status: "open" }, "active")).toBe(true);
  });

  it("is exactly open + in_progress for the built-in workflow", () => {
    for (const status of ["open", "in_progress"]) {
      expect(isStatusOfKind([], task("p1", status), "active")).toBe(true);
    }
    for (const status of ["review", "done", "backlog", "abandoned", "build"]) {
      expect(isStatusOfKind([], task("p1", status), "active")).toBe(false);
    }
  });

  it("falls back to the built-in active names when the transitions are unreadable", () => {
    const broken: WorkflowRow = {
      id: "wf-broken",
      projectId: "p1",
      isDefault: true,
      definition: {
        initialState: "open",
        states: CUSTOM_VOCABULARY_DEFINITION.states,
        transitions: "x",
      },
    };
    // The review-like judgement needs the transitions; without them the
    // whole active list falls back, like safeStates does per kind.
    expect(isStatusOfKind([broken], { workflowId: "wf-broken", projectId: "p1", status: "build" }, "active")).toBe(false);
    expect(isStatusOfKind([broken], { workflowId: "wf-broken", projectId: "p1", status: "in_progress" }, "active")).toBe(true);
  });

  it("builds one active condition per workflow plus the built-in branch", () => {
    const filter = buildTaskStatusFilter([customDefault], { kind: "active", match: "in" });
    expect(filter).toEqual({
      OR: [
        { workflowId: { in: ["wf-custom"] }, status: { in: ["build", "open", "plan"] } },
        { workflowId: null, projectId: { in: ["p1"] }, status: { in: ["build", "open", "plan"] } },
        { workflowId: null, projectId: { notIn: ["p1"] }, status: { in: ["in_progress", "open"] } },
      ],
    });
  });
});

describe("claim fields", () => {
  it("clears every holder and timestamp, and the all-claims set is the two together", () => {
    expect(clearWork).toEqual({ claimedByUserId: null, claimedByAgentId: null, claimedAt: null });
    expect(clearReview).toEqual({ reviewClaimedByUserId: null, reviewClaimedByAgentId: null, reviewClaimedAt: null });
    expect(clearAllClaims).toEqual({ ...clearWork, ...clearReview });
  });
});
