/**
 * Tests for workflow transition validation logic.
 * Tests the pure logic without hitting the database.
 */
import { describe, expect, it } from "vitest";

// Pure function extracted for testing
function validateTransition(
  definition: {
    transitions: { from: string; to: string; requiredRole?: string }[];
  },
  from: string,
  to: string,
  actorRole?: string,
): { valid: boolean; reason?: string } {
  const transition = definition.transitions.find((t) => t.from === from && t.to === to);

  if (!transition) {
    return { valid: false, reason: `No transition defined from '${from}' to '${to}'` };
  }

  if (
    transition.requiredRole &&
    transition.requiredRole !== "any" &&
    actorRole !== transition.requiredRole
  ) {
    return { valid: false, reason: `Requires role: ${transition.requiredRole}` };
  }

  return { valid: true };
}

const exampleWorkflowDef = {
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "in_progress", label: "In Progress", terminal: false },
    { name: "review", label: "In Review", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [
    { from: "open", to: "in_progress", requiredRole: "any" },
    { from: "in_progress", to: "review", requiredRole: "any" },
    { from: "review", to: "done", requiredRole: "REVIEWER" },
    { from: "review", to: "in_progress", requiredRole: "any" },
  ],
  initialState: "open",
};

describe("validateTransition", () => {
  it("allows valid transition", () => {
    const result = validateTransition(exampleWorkflowDef, "open", "in_progress");
    expect(result.valid).toBe(true);
  });

  it("blocks undefined transition", () => {
    const result = validateTransition(exampleWorkflowDef, "open", "done");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("No transition defined");
  });

  it("allows transition requiring any role", () => {
    const result = validateTransition(exampleWorkflowDef, "in_progress", "review", "HUMAN_MEMBER");
    expect(result.valid).toBe(true);
  });

  it("blocks transition requiring specific role when actor lacks it", () => {
    const result = validateTransition(exampleWorkflowDef, "review", "done", "HUMAN_MEMBER");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("REVIEWER");
  });

  it("allows transition requiring specific role when actor has it", () => {
    const result = validateTransition(exampleWorkflowDef, "review", "done", "REVIEWER");
    expect(result.valid).toBe(true);
  });

  it("allows reverse transition (review → in_progress)", () => {
    const result = validateTransition(exampleWorkflowDef, "review", "in_progress");
    expect(result.valid).toBe(true);
  });

  it("blocks transition from done (terminal state)", () => {
    const result = validateTransition(exampleWorkflowDef, "done", "open");
    expect(result.valid).toBe(false);
  });
});
