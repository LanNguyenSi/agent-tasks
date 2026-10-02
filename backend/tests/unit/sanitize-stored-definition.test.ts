import { describe, expect, it } from "vitest";
import {
  defaultWorkflowDefinition,
  resolveEffectiveDefinition,
  resolveProjectEffectiveDefinition,
  sanitizeStoredDefinition,
  type WorkflowDefinitionShape,
} from "../../src/services/default-workflow.js";

const legacy: WorkflowDefinitionShape = {
  initialState: "backlog",
  states: [
    { name: "backlog", label: "Backlog", terminal: false },
    { name: "spec", label: "Spec", terminal: false },
    { name: "review", label: "Review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "backlog", to: "spec" },
    { from: "spec", to: "backlog", label: "Release" },
    { from: "spec", to: "review" },
    { from: "review", to: "backlog" },
    { from: "review", to: "done" },
  ],
};

describe("sanitizeStoredDefinition", () => {
  it("returns a definition that never mentions backlog as the same object", () => {
    const def = defaultWorkflowDefinition();
    expect(sanitizeStoredDefinition(def)).toBe(def);
  });

  it("drops every edge into backlog and the backlog state, and remaps the edge out of backlog to leave from open", () => {
    const out = sanitizeStoredDefinition(legacy);
    expect(out.transitions).toEqual([
      { from: "open", to: "spec" },
      { from: "spec", to: "review" },
      { from: "review", to: "done" },
    ]);
    expect(out.states.map((s) => s.name)).not.toContain("backlog");
    expect(out.transitions.some((t) => t.from === "backlog" || t.to === "backlog")).toBe(false);
  });

  it("keeps label, requires, requiredRole and extra fields on a remapped edge", () => {
    const def: WorkflowDefinitionShape = {
      ...legacy,
      transitions: [
        { from: "backlog", to: "spec", label: "Start scoping", requires: ["branchPresent"], requiredRole: "any" },
        { from: "spec", to: "review" },
      ],
    };
    const out = sanitizeStoredDefinition(def);
    expect(out.transitions[0]).toEqual({
      from: "open",
      to: "spec",
      label: "Start scoping",
      requires: ["branchPresent"],
      requiredRole: "any",
    });
  });

  it("skips a remapped edge that would duplicate an existing open edge to the same target", () => {
    const def: WorkflowDefinitionShape = {
      ...legacy,
      states: [...legacy.states, { name: "open", label: "Open", terminal: false }],
      transitions: [
        { from: "open", to: "spec", label: "Existing" },
        { from: "backlog", to: "spec", label: "Legacy start" },
        { from: "backlog", to: "review", label: "Legacy fast track" },
      ],
    };
    const out = sanitizeStoredDefinition(def);
    expect(out.transitions).toEqual([
      { from: "open", to: "spec", label: "Existing" },
      { from: "open", to: "review", label: "Legacy fast track" },
    ]);
  });

  it("skips a second remapped edge to the same target and a remapped edge that would loop on open", () => {
    const def: WorkflowDefinitionShape = {
      ...legacy,
      transitions: [
        { from: "backlog", to: "spec", label: "first" },
        { from: "backlog", to: "spec", label: "second" },
        { from: "backlog", to: "open", label: "loop" },
      ],
    };
    const out = sanitizeStoredDefinition(def);
    expect(out.transitions).toEqual([{ from: "open", to: "spec", label: "first" }]);
  });

  it("maps an initialState of backlog to open and adds the open state when it is missing", () => {
    const out = sanitizeStoredDefinition(legacy);
    expect(out.initialState).toBe("open");
    expect(out.states.map((s) => s.name)).toContain("open");
  });

  it("does not duplicate an open state the legacy definition already has", () => {
    const withOpen = { ...legacy, states: [...legacy.states, { name: "open", label: "Open", terminal: false }] };
    const out = sanitizeStoredDefinition(withOpen);
    expect(out.states.filter((s) => s.name === "open")).toHaveLength(1);
  });

  it("keeps a non-backlog initialState and still drops a stray edge into backlog", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "queued",
      states: [
        { name: "queued", label: "Queued", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "queued", to: "in_progress" },
        { from: "in_progress", to: "backlog" },
        { from: "in_progress", to: "done" },
      ],
    };
    const out = sanitizeStoredDefinition(def);
    expect(out.initialState).toBe("queued");
    expect(out.states.map((s) => s.name)).toEqual(["queued", "in_progress", "done"]);
    expect(out.transitions).toEqual([
      { from: "queued", to: "in_progress" },
      { from: "in_progress", to: "done" },
    ]);
  });

  it("adds the open state for a backlog initial state even when no edge leaves backlog", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "backlog",
      states: [
        { name: "backlog", label: "Backlog", terminal: false },
        { name: "spec", label: "Spec", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [{ from: "spec", to: "done" }],
    };
    const out = sanitizeStoredDefinition(def);
    expect(out.initialState).toBe("open");
    expect(out.states.map((s) => s.name)).toEqual(["spec", "done", "open"]);
    expect(out.transitions).toEqual([{ from: "spec", to: "done" }]);
  });

  it("drops, not remaps, an edge out of backlog when the stored initial state is open", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In progress", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "in_progress" },
        { from: "in_progress", to: "review" },
        { from: "review", to: "done" },
        { from: "open", to: "backlog", label: "Park" },
        { from: "backlog", to: "done", label: "Close parked" },
      ],
    };
    const out = sanitizeStoredDefinition(def);
    expect(out.initialState).toBe("open");
    expect(out.transitions).toEqual([
      { from: "open", to: "in_progress" },
      { from: "in_progress", to: "review" },
      { from: "review", to: "done" },
    ]);
  });

  it("drops a stray edge out of backlog and adds no open state when the stored initial state is custom", () => {
    const def: WorkflowDefinitionShape = {
      initialState: "queued",
      states: [
        { name: "queued", label: "Queued", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "queued", to: "done" },
        { from: "backlog", to: "done", label: "Close parked" },
      ],
    };
    const out = sanitizeStoredDefinition(def);
    expect(out.initialState).toBe("queued");
    expect(out.states.map((s) => s.name)).toEqual(["queued", "done"]);
    expect(out.transitions).toEqual([{ from: "queued", to: "done" }]);
  });

  it("does not mutate the stored object", () => {
    const stored = structuredClone(legacy);
    sanitizeStoredDefinition(stored);
    expect(stored).toEqual(legacy);
  });

  it("passes a non-object through unchanged (no new failure mode for malformed rows)", () => {
    expect(sanitizeStoredDefinition(null)).toBeNull();
    expect(sanitizeStoredDefinition(undefined)).toBeUndefined();
  });
});

describe("the effective-definition resolvers sanitize every stored source", () => {
  const prismaWith = (definition: unknown) => ({ workflow: { findFirst: async () => ({ definition }) } });

  it("resolveEffectiveDefinition: task-attached workflow", async () => {
    const def = await resolveEffectiveDefinition(
      { workflowId: "w1", workflow: { definition: legacy }, projectId: "p1" },
      prismaWith(null),
    );
    expect(def.initialState).toBe("open");
    expect(def.transitions.some((t) => t.to === "backlog" || t.from === "backlog")).toBe(false);
  });

  it("resolveEffectiveDefinition: project default workflow", async () => {
    const def = await resolveEffectiveDefinition({ workflowId: null, projectId: "p1" }, prismaWith(legacy));
    expect(def.initialState).toBe("open");
    expect(def.transitions.some((t) => t.to === "backlog" || t.from === "backlog")).toBe(false);
  });

  it("resolveProjectEffectiveDefinition: project default workflow", async () => {
    const def = await resolveProjectEffectiveDefinition("p1", prismaWith(legacy));
    expect(def.initialState).toBe("open");
    expect(def.transitions.some((t) => t.to === "backlog" || t.from === "backlog")).toBe(false);
  });
});
