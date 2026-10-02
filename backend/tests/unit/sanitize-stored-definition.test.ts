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

  it("drops every edge into or out of backlog and the backlog state", () => {
    const out = sanitizeStoredDefinition(legacy);
    expect(out.transitions).toEqual([
      { from: "spec", to: "review" },
      { from: "review", to: "done" },
    ]);
    expect(out.states.map((s) => s.name)).not.toContain("backlog");
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
      ...defaultWorkflowDefinition(),
      transitions: [...defaultWorkflowDefinition().transitions, { from: "in_progress", to: "backlog" }],
    };
    const out = sanitizeStoredDefinition(def);
    expect(out.initialState).toBe("open");
    expect(out.transitions.some((t) => t.to === "backlog")).toBe(false);
    expect(out.transitions).toHaveLength(def.transitions.length - 1);
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
