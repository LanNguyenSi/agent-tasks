/**
 * Backend zod validation for Workflow.definition structural integrity.
 *
 * The frontend editor performs the same checks, but clients cannot be
 * trusted — these tests lock the server-side defense in place so a
 * future schema edit can't accidentally downgrade to the pre-#109
 * "accept anything" behavior that allowed corrupted workflow graphs.
 */
import { describe, expect, it } from "vitest";
import { STATE_NAME_MAX_LENGTH, workflowDefinitionSchema } from "../../src/routes/workflows.js";

function validDef() {
  return {
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "in_progress", label: "In progress", terminal: false },
      { name: "review", label: "In review", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [
      { from: "open", to: "in_progress" },
      { from: "in_progress", to: "review" },
      { from: "review", to: "done" },
    ],
    initialState: "open",
  };
}

describe("workflowDefinitionSchema", () => {
  it("accepts a well-formed definition", () => {
    const result = workflowDefinitionSchema.safeParse(validDef());
    expect(result.success).toBe(true);
  });

  it("bounds a state name at 64 characters: 64 is accepted, 65 is refused", () => {
    expect(STATE_NAME_MAX_LENGTH).toBe(64);
    const ok = validDef();
    ok.states[3]!.name = "a".repeat(64);
    ok.transitions[2]!.to = ok.states[3]!.name;
    expect(workflowDefinitionSchema.safeParse(ok).success).toBe(true);
    const tooLong = validDef();
    tooLong.states[3]!.name = "a".repeat(65);
    tooLong.transitions[2]!.to = tooLong.states[3]!.name;
    expect(workflowDefinitionSchema.safeParse(tooLong).success).toBe(false);
  });

  it("rejects state names with uppercase letters", () => {
    const d = validDef();
    d.states[0]!.name = "Open";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects state names with spaces", () => {
    const d = validDef();
    d.states[0]!.name = "in progress";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects state names with dashes", () => {
    const d = validDef();
    d.states[0]!.name = "in-progress";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects state names with shell metacharacters", () => {
    const d = validDef();
    d.states[0]!.name = "open; DROP TABLE";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate state names", () => {
    const d = validDef();
    d.states.push({ name: "open", label: "Open 2", terminal: false });
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate/i.test(i.message))).toBe(true);
    }
  });

  it("rejects initialState not in the states list", () => {
    const d = validDef();
    d.initialState = "ghost";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /initialState/i.test(i.message))).toBe(true);
    }
  });

  it("rejects a transition with a missing 'from' state", () => {
    const d = validDef();
    d.transitions.push({ from: "ghost", to: "done" });
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /missing "from"/i.test(i.message))).toBe(true);
    }
  });

  it("rejects a transition with a missing 'to' state", () => {
    const d = validDef();
    d.transitions.push({ from: "open", to: "phantom" });
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /missing "to"/i.test(i.message))).toBe(true);
    }
  });

  describe("custom state vocabulary", () => {
    const messages = (def: unknown): string[] => {
      const r = workflowDefinitionSchema.safeParse(def);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };

    function sevenStage() {
      return {
        states: [
          { name: "open", label: "Open", terminal: false },
          { name: "spec", label: "Spec", terminal: false },
          { name: "plan", label: "Plan", terminal: false },
          { name: "implement", label: "Implement", terminal: false },
          { name: "test", label: "Test", terminal: false },
          { name: "review", label: "Review", terminal: false },
          { name: "done", label: "Done", terminal: true },
        ],
        transitions: [
          { from: "open", to: "spec" },
          { from: "spec", to: "open" },
          { from: "spec", to: "plan" },
          { from: "plan", to: "implement" },
          { from: "implement", to: "test" },
          { from: "test", to: "review" },
          { from: "review", to: "done" },
        ],
        initialState: "open",
      };
    }

    it("accepts state names outside the four built-ins", () => {
      expect(messages(sevenStage())).toEqual([]);
      expect(workflowDefinitionSchema.safeParse(sevenStage()).success).toBe(true);
    });

    it("accepts a deploy-style state reached after done", () => {
      const d = validDef();
      d.states.push({ name: "deployed", label: "Deployed", terminal: true });
      d.transitions.push({ from: "done", to: "deployed" });
      expect(workflowDefinitionSchema.safeParse(d).success).toBe(true);
    });

    it("accepts a definition that omits built-in names other than open", () => {
      const result = workflowDefinitionSchema.safeParse({
        states: [
          { name: "open", label: "Open", terminal: false },
          { name: "shipped", label: "Shipped", terminal: true },
        ],
        transitions: [{ from: "open", to: "shipped" }],
        initialState: "open",
      });
      expect(result.success).toBe(true);
    });

    it("accepts a different terminal flag set (custom terminal, done non-terminal)", () => {
      const d = validDef();
      d.states[3]!.terminal = false; // done is no longer terminal
      d.states.push({ name: "shipped", label: "Shipped", terminal: true });
      d.transitions.push({ from: "done", to: "shipped" });
      expect(workflowDefinitionSchema.safeParse(d).success).toBe(true);
    });

    it("accepts several terminal states", () => {
      const d = validDef();
      d.states.push({ name: "cancelled", label: "Cancelled", terminal: true });
      d.transitions.push({ from: "open", to: "cancelled" });
      expect(workflowDefinitionSchema.safeParse(d).success).toBe(true);
    });

    it("keeps rejecting an unsupported name format for custom names", () => {
      const d = validDef();
      d.states.push({ name: "Deployed-1", label: "Bad", terminal: false });
      expect(workflowDefinitionSchema.safeParse(d).success).toBe(false);
    });
  });

  describe("initialState stays open", () => {
    it("rejects initialState other than \"open\"", () => {
      const d = validDef();
      d.initialState = "in_progress";
      const msgs = (() => {
        const r = workflowDefinitionSchema.safeParse(d);
        return r.success ? [] : r.error.issues.map((i) => i.message);
      })();
      expect(msgs.some((m) => /initialState must be "open"/i.test(m))).toBe(true);
    });

    it("rejects a custom initialState even when it is a declared state", () => {
      const result = workflowDefinitionSchema.safeParse({
        states: [
          { name: "intake", label: "Intake", terminal: false },
          { name: "shipped", label: "Shipped", terminal: true },
        ],
        transitions: [{ from: "intake", to: "shipped" }],
        initialState: "intake",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => /initialState must be "open"/.test(i.message))).toBe(true);
      }
    });

    it("rejects initialState \"open\" when no state is named open", () => {
      const result = workflowDefinitionSchema.safeParse({
        states: [
          { name: "intake", label: "Intake", terminal: false },
          { name: "shipped", label: "Shipped", terminal: true },
        ],
        transitions: [{ from: "intake", to: "shipped" }],
        initialState: "open",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => /initialState "open" is not one of the workflow's states/.test(i.message)),
        ).toBe(true);
      }
    });

    it("rejects a terminal open state", () => {
      const d = validDef();
      d.states[0]!.terminal = true;
      const result = workflowDefinitionSchema.safeParse(d);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => /initialState "open" must not be a terminal state/.test(i.message))).toBe(true);
      }
    });

    it("rejects a workflow without any terminal state", () => {
      const d = validDef();
      d.states[3]!.terminal = false;
      const result = workflowDefinitionSchema.safeParse(d);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => /at least one terminal state/.test(i.message))).toBe(true);
      }
    });
  });

  describe("reserved state names", () => {
    const issues = (def: unknown) => {
      const r = workflowDefinitionSchema.safeParse(def);
      return r.success ? [] : r.error.issues;
    };

    for (const reserved of ["backlog", "abandoned"] as const) {
      it(`rejects a state named ${reserved}`, () => {
        const d = validDef();
        d.states.push({ name: reserved, label: "Reserved", terminal: false });
        const found = issues(d).filter((i) => new RegExp(`State name "${reserved}" is reserved`).test(i.message));
        expect(found).toHaveLength(1);
      });

      it(`rejects an edge from ${reserved} (and does not also report a missing state)`, () => {
        const d = validDef();
        d.transitions.push({ from: reserved, to: "open" });
        const all = issues(d);
        const found = all.filter((i) => new RegExp(`from reserved state "${reserved}"`).test(i.message));
        expect(found).toHaveLength(1);
        expect(found[0]!.path).toEqual(["transitions", 3, "from"]);
        expect(all.some((i) => /missing "from"/.test(i.message))).toBe(false);
      });

      it(`rejects an edge to ${reserved} (and does not also report a missing state)`, () => {
        const d = validDef();
        d.transitions.push({ from: "open", to: reserved });
        const all = issues(d);
        const found = all.filter((i) => new RegExp(`to reserved state "${reserved}"`).test(i.message));
        expect(found).toHaveLength(1);
        expect(found[0]!.path).toEqual(["transitions", 3, "to"]);
        expect(all.some((i) => /missing "to"/.test(i.message))).toBe(false);
      });

      it(`rejects ${reserved} as a declared state together with edges in both directions`, () => {
        const d = validDef();
        d.states.push({ name: reserved, label: "Reserved", terminal: false });
        d.transitions.push({ from: "open", to: reserved }, { from: reserved, to: "open" });
        const all = issues(d);
        expect(all.filter((i) => /is reserved/.test(i.message))).toHaveLength(1);
        expect(all.filter((i) => /reserved state/.test(i.message))).toHaveLength(2);
      });
    }
  });

  it("requires at least one state", () => {
    const result = workflowDefinitionSchema.safeParse({
      states: [],
      transitions: [],
      initialState: "open",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty state name", () => {
    const d = validDef();
    d.states[0]!.name = "";
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate transition (from, to) pairs", () => {
    const d = validDef();
    d.transitions.push({ from: "open", to: "in_progress" });
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate transition/i.test(i.message))).toBe(true);
    }
  });

  it("accepts transitions with requires arrays (gates)", () => {
    const d = validDef();
    d.transitions[0] = { from: "open", to: "in_progress", requires: ["branchPresent"] } as any;
    const result = workflowDefinitionSchema.safeParse(d);
    expect(result.success).toBe(true);
  });
});
