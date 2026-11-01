/**
 * The workflow editor restates the backend's state rules (the frontend imports
 * nothing from the backend). These tests pin the restated constants against the
 * backend source and run the same accepted and refused examples through the
 * client-side checks.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkflowDefinition } from "../../src/lib/api";
import {
  RESERVED_STATE_NAMES,
  STATE_NAME_MAX_LENGTH,
  WORKFLOW_INITIAL_STATE,
  validateStateName,
  validateStateRules,
} from "../../src/app/projects/[id]/workflow/_components/stateRules";
import { STATE_NAME_RE } from "../../src/lib/workflow-draft";

const backendSource = readFileSync(
  resolve(__dirname, "../../../backend/src/routes/workflows.ts"),
  "utf8",
);
// The reserved names live in the shared stranded-task service; workflows.ts
// imports and re-exports them.
const reservedSource = readFileSync(
  resolve(__dirname, "../../../backend/src/services/workflow-stranding.ts"),
  "utf8",
);

function def(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "qa", label: "QA", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [
      { from: "open", to: "qa", requiredRole: "any" },
      { from: "qa", to: "done", requiredRole: "any" },
    ],
    ...overrides,
  };
}

describe("restated backend constants", () => {
  it("match backend/src/routes/workflows.ts and services/workflow-stranding.ts", () => {
    expect(backendSource).toContain(`export const STATE_NAME_MAX_LENGTH = ${STATE_NAME_MAX_LENGTH};`);
    expect(backendSource).toContain("export { RESERVED_STATE_NAMES };");
    expect(reservedSource).toContain(
      `export const RESERVED_STATE_NAMES = [${RESERVED_STATE_NAMES.map((n) => `"${n}"`).join(", ")}] as const;`,
    );
    expect(backendSource).toContain(`export const WORKFLOW_INITIAL_STATE = "${WORKFLOW_INITIAL_STATE}";`);
    expect(backendSource).toContain(`const STATE_NAME_RE = ${STATE_NAME_RE.toString()};`);
  });

  it("the reserved names are backlog and abandoned, the initial state is open, 64 characters", () => {
    expect([...RESERVED_STATE_NAMES]).toEqual(["backlog", "abandoned"]);
    expect(WORKFLOW_INITIAL_STATE).toBe("open");
    expect(STATE_NAME_MAX_LENGTH).toBe(64);
  });
});

describe("validateStateName", () => {
  const d = def();

  it("accepts the names the backend accepts", () => {
    for (const name of ["qa", "in_progress", "0", "ship_2", "a".repeat(64)]) {
      expect(validateStateName(name, d, 1)).toBeNull();
    }
  });

  it("refuses the names the backend refuses, with the backend's wording where it has one", () => {
    expect(validateStateName("", d, 1)).toBe("State name cannot be empty.");
    expect(validateStateName("a".repeat(65), d, 1)).toBe("State name must be at most 64 characters.");
    expect(validateStateName("QA", d, 1)).toBe(
      'State name "QA" must match [a-z0-9_]+ (lowercase, digits, underscore).',
    );
    expect(validateStateName("done", d, 1)).toBe('Duplicate state name: "done".');
    expect(validateStateName("backlog", d, 1)).toBe(
      'State name "backlog" is reserved. backlog and abandoned are managed outside the workflow graph and cannot be declared as workflow states.',
    );
    expect(validateStateName("abandoned", d, 1)).toMatch(/"abandoned" is reserved/);
  });

  it("the row's own current name is not a duplicate; another row's is", () => {
    expect(validateStateName("qa", d, 1)).toBeNull();
    expect(validateStateName("qa", d, 0)).toBe('Duplicate state name: "qa".');
  });

  it("checks the format before the duplicate and reserved rules, like the schema does", () => {
    const withReserved = def({
      states: [...def().states, { name: "Backlog", label: "x", terminal: false }],
    });
    expect(validateStateName("Backlog", withReserved, 0)).toMatch(/must match/);
  });
});

describe("validateStateRules", () => {
  it("passes a definition with custom state names", () => {
    expect(validateStateRules(def())).toEqual([]);
  });

  it("flags a reserved state name", () => {
    const d = def({ states: [...def().states, { name: "backlog", label: "B", terminal: false }] });
    expect(validateStateRules(d).some((e) => /"backlog" is reserved/.test(e))).toBe(true);
  });

  it("flags a state name over 64 characters", () => {
    const d = def({ states: [...def().states, { name: "a".repeat(65), label: "L", terminal: false }] });
    expect(validateStateRules(d).some((e) => /at most 64 characters/.test(e))).toBe(true);
  });

  it("flags an initial state other than open", () => {
    const d = def({ initialState: "qa" });
    expect(validateStateRules(d)).toContain('initialState must be "open", got "qa".');
  });

  it("flags a terminal initial state", () => {
    const d = def({
      states: [{ name: "open", label: "Open", terminal: true }, ...def().states.slice(1)],
    });
    expect(validateStateRules(d)).toContain('Initial state "open" must not be a terminal state.');
  });

  it("flags a definition without a terminal state", () => {
    const d = def({ states: def().states.map((s) => ({ ...s, terminal: false })) });
    expect(validateStateRules(d)).toContain("The workflow needs at least one terminal state.");
  });

  it("flags a transition from or to a reserved state", () => {
    const from = def({ transitions: [{ from: "backlog", to: "qa", requiredRole: "any" }] });
    expect(validateStateRules(from).some((e) => /Transition from reserved state "backlog"/.test(e))).toBe(true);
    const to = def({ transitions: [{ from: "qa", to: "abandoned", requiredRole: "any" }] });
    expect(validateStateRules(to).some((e) => /Transition to reserved state "abandoned"/.test(e))).toBe(true);
  });
});
