/**
 * Unit tests for the pure workflow-editor helpers.
 *
 * These helpers live in `src/lib/workflow-draft.ts` — extracted in PR
 * #111 after a Next.js export bug. They carry the most bug-prone logic
 * in the entire workflow editor (rename propagation invariants,
 * reachability BFS, structural diff), and they're the first pure
 * surface in the frontend to be unit-tested at all.
 *
 * Tests cover: deep cloning, requires-set equality, definition
 * structural equality, reachability BFS, reachability categorization,
 * and every error + warning branch of `validateDefinition`.
 */
import { describe, expect, it } from "vitest";
import {
  cloneDefinition,
  computeReachability,
  definitionsEqual,
  reachableStates,
  sameRequires,
  validateDefinition,
} from "../../src/lib/workflow-draft";
import type { WorkflowDefinition } from "../../src/lib/api";

function def(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    initialState: "open",
    states: [
      { name: "open", label: "Open", terminal: false },
      { name: "in_progress", label: "In progress", terminal: false },
      { name: "review", label: "In review", terminal: false },
      { name: "done", label: "Done", terminal: true },
    ],
    transitions: [
      { from: "open", to: "in_progress", requiredRole: "any" },
      { from: "in_progress", to: "review", requiredRole: "any" },
      { from: "review", to: "done", requiredRole: "any" },
    ],
    ...overrides,
  };
}

// ── cloneDefinition ────────────────────────────────────────────────────────

describe("cloneDefinition", () => {
  it("produces a deep copy of states", () => {
    const original = def();
    const clone = cloneDefinition(original);
    clone.states[0]!.name = "backlog";
    expect(original.states[0]!.name).toBe("open");
  });

  it("produces a deep copy of transitions", () => {
    const original = def();
    const clone = cloneDefinition(original);
    clone.transitions[0]!.from = "new_start";
    expect(original.transitions[0]!.from).toBe("open");
  });

  it("deep-copies the requires array on transitions", () => {
    const original = def({
      transitions: [
        {
          from: "open",
          to: "in_progress",
          requiredRole: "any",
          requires: ["branchPresent"],
        },
      ],
    });
    const clone = cloneDefinition(original);
    clone.transitions[0]!.requires!.push("prPresent");
    expect(original.transitions[0]!.requires).toEqual(["branchPresent"]);
  });

  it("preserves transitions without a requires array (field stays absent)", () => {
    const original = def();
    const clone = cloneDefinition(original);
    // Must not inject an empty `requires: []` into transitions that had
    // none — the backend treats missing vs. empty identically but the
    // diff helper compares field presence and a spurious [] would read
    // as a change.
    expect(clone.transitions[0]!.requires).toBeUndefined();
  });

  it("preserves initialState", () => {
    expect(cloneDefinition(def()).initialState).toBe("open");
  });
});

// ── sameRequires ──────────────────────────────────────────────────────────

describe("sameRequires", () => {
  it("treats undefined and empty array as equal", () => {
    expect(sameRequires(undefined, [])).toBe(true);
    expect(sameRequires([], undefined)).toBe(true);
    expect(sameRequires(undefined, undefined)).toBe(true);
  });

  it("is order-insensitive", () => {
    expect(sameRequires(["branchPresent", "prPresent"], ["prPresent", "branchPresent"])).toBe(
      true,
    );
  });

  it("returns false when sizes differ", () => {
    expect(sameRequires(["branchPresent"], ["branchPresent", "prPresent"])).toBe(false);
  });

  it("returns false when contents differ", () => {
    expect(sameRequires(["branchPresent"], ["prPresent"])).toBe(false);
  });
});

// ── definitionsEqual ───────────────────────────────────────────────────────

describe("definitionsEqual", () => {
  it("returns true for structurally identical definitions", () => {
    expect(definitionsEqual(def(), def())).toBe(true);
  });

  it("detects initialState change", () => {
    expect(definitionsEqual(def(), def({ initialState: "in_progress" }))).toBe(false);
  });

  it("detects state name change", () => {
    const changed = def();
    changed.states[0]!.name = "backlog";
    expect(definitionsEqual(def(), changed)).toBe(false);
  });

  it("detects state label change", () => {
    const changed = def();
    changed.states[0]!.label = "Backlog";
    expect(definitionsEqual(def(), changed)).toBe(false);
  });

  it("detects terminal flag change", () => {
    const changed = def();
    changed.states[3]!.terminal = false;
    expect(definitionsEqual(def(), changed)).toBe(false);
  });

  it("treats missing and empty agentInstructions as equal", () => {
    const a = def();
    const b = def();
    b.states[0]!.agentInstructions = "";
    expect(definitionsEqual(a, b)).toBe(true);
  });

  it("detects transition requires difference", () => {
    const a = def();
    const b = def();
    b.transitions[0]!.requires = ["branchPresent"];
    expect(definitionsEqual(a, b)).toBe(false);
  });

  it("detects requiredRole difference (with 'any' default)", () => {
    const a = def();
    const b = def();
    b.transitions[0]!.requiredRole = "ADMIN";
    expect(definitionsEqual(a, b)).toBe(false);
  });

  it("detects transition count change", () => {
    const a = def();
    const b = def({
      transitions: [...def().transitions, { from: "in_progress", to: "open", requiredRole: "any" }],
    });
    expect(definitionsEqual(a, b)).toBe(false);
  });
});

// ── reachableStates ───────────────────────────────────────────────────────

describe("reachableStates", () => {
  it("reaches every state in a linear graph", () => {
    const r = reachableStates(def());
    expect(r).toEqual(new Set(["open", "in_progress", "review", "done"]));
  });

  it("returns empty when initialState is missing from states", () => {
    const d = def({ initialState: "ghost" });
    expect(reachableStates(d).size).toBe(0);
  });

  it("terminates on a cycle", () => {
    const d = def({
      transitions: [
        { from: "open", to: "in_progress", requiredRole: "any" },
        { from: "in_progress", to: "review", requiredRole: "any" },
        { from: "review", to: "in_progress", requiredRole: "any" }, // cycle
      ],
    });
    const r = reachableStates(d);
    expect(r.has("open")).toBe(true);
    expect(r.has("in_progress")).toBe(true);
    expect(r.has("review")).toBe(true);
    expect(r.has("done")).toBe(false);
  });

  it("does not reach unreachable tail states", () => {
    const d = def({
      transitions: [{ from: "open", to: "in_progress", requiredRole: "any" }],
    });
    const r = reachableStates(d);
    expect(r.has("review")).toBe(false);
    expect(r.has("done")).toBe(false);
  });
});

// ── computeReachability ───────────────────────────────────────────────────

describe("computeReachability", () => {
  it("categorizes a clean default workflow as all-healthy", () => {
    const r = computeReachability(def());
    expect(r.unreachable).toEqual([]);
    expect(r.deadEnds).toEqual([]);
    expect(r.orphans).toEqual([]);
  });

  it("flags unreachable states", () => {
    const d = def({
      transitions: [
        { from: "open", to: "in_progress", requiredRole: "any" },
        { from: "in_progress", to: "done", requiredRole: "any" },
      ],
    });
    const r = computeReachability(d);
    expect(r.unreachable).toEqual(["review"]);
  });

  it("flags non-terminal dead ends (no outgoing)", () => {
    const d = def({
      transitions: [
        { from: "open", to: "in_progress", requiredRole: "any" },
        { from: "in_progress", to: "review", requiredRole: "any" },
      ],
    });
    const r = computeReachability(d);
    expect(r.deadEnds).toContain("review");
    expect(r.deadEnds).not.toContain("done"); // done is terminal, not a dead end
  });

  it("flags orphans (no incoming, not initial)", () => {
    const d = def({
      transitions: [
        { from: "open", to: "done", requiredRole: "any" },
      ],
    });
    const r = computeReachability(d);
    expect(r.orphans).toContain("in_progress");
    expect(r.orphans).toContain("review");
    expect(r.orphans).not.toContain("open"); // initialState is not an orphan
  });
});

// ── validateDefinition — errors ──────────────────────────────────────────

describe("validateDefinition errors", () => {
  it("passes a clean default workflow", () => {
    const r = validateDefinition(def());
    expect(r.errors).toEqual([]);
  });

  it("rejects duplicate state names", () => {
    const d = def();
    d.states.push({ name: "open", label: "Open 2", terminal: false });
    const r = validateDefinition(d);
    expect(r.errors.some((e) => /duplicate state name/i.test(e))).toBe(true);
  });

  it("rejects state names with uppercase letters", () => {
    const d = def();
    d.states[0]!.name = "Open";
    const r = validateDefinition(d);
    expect(r.errors.some((e) => /\[a-z0-9_\]\+/.test(e))).toBe(true);
  });

  it("rejects empty state labels", () => {
    const d = def();
    d.states[0]!.label = "  ";
    const r = validateDefinition(d);
    expect(r.errors.some((e) => /has no label/i.test(e))).toBe(true);
  });

  it("rejects initialState not in states list", () => {
    const d = def({ initialState: "ghost" });
    const r = validateDefinition(d);
    expect(r.errors.some((e) => /initial state/i.test(e))).toBe(true);
  });

  it("rejects transitions with missing from state", () => {
    const d = def();
    d.transitions.push({ from: "ghost", to: "done", requiredRole: "any" });
    const r = validateDefinition(d);
    expect(r.errors.some((e) => /missing "from"/i.test(e))).toBe(true);
  });

  it("rejects transitions with missing to state", () => {
    const d = def();
    d.transitions.push({ from: "open", to: "phantom", requiredRole: "any" });
    const r = validateDefinition(d);
    expect(r.errors.some((e) => /missing "to"/i.test(e))).toBe(true);
  });

  it("rejects duplicate (from,to) transition pairs", () => {
    const d = def();
    d.transitions.push({ from: "open", to: "in_progress", requiredRole: "any" });
    const r = validateDefinition(d);
    expect(r.errors.some((e) => /duplicate transition/i.test(e))).toBe(true);
  });
});

// ── validateDefinition — warnings ────────────────────────────────────────

describe("validateDefinition warnings", () => {
  it("warns when no terminal state is marked", () => {
    const d = def();
    d.states[3]!.terminal = false;
    const r = validateDefinition(d);
    expect(r.warnings.some((w) => /terminal state/i.test(w))).toBe(true);
  });

  it("warns about unreachable states when the graph is otherwise valid", () => {
    const d = def({
      transitions: [
        { from: "open", to: "in_progress", requiredRole: "any" },
        { from: "in_progress", to: "done", requiredRole: "any" },
      ],
    });
    const r = validateDefinition(d);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /unreachable/i.test(w))).toBe(true);
  });

  it("does not run reachability analysis when there are errors", () => {
    // Running reachability on a broken graph produces confusing noise;
    // the code gates it on errors.length === 0.
    const d = def({ initialState: "ghost" });
    const r = validateDefinition(d);
    expect(r.errors.some((e) => /initial state/i.test(e))).toBe(true);
    expect(r.warnings.every((w) => !/unreachable/i.test(w))).toBe(true);
  });
});
