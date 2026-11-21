/**
 * isEffectiveWorkflow: the shape gate the workflow editor runs on every
 * server response it stores as its workflow. Each accepted and refused
 * shape is its own case: the two sources, a null or string workflowId, a
 * definition with a states array (extra keys like the write routes'
 * `report` pass), and the refusals (non-object, array, wrong or missing
 * source, missing or non-string workflowId, missing or malformed
 * definition).
 */
import { describe, it, expect } from "vitest";
import { isEffectiveWorkflow } from "../../src/lib/api";

const definition = {
  initialState: "open",
  states: [{ name: "open", label: "Open", terminal: false }],
  transitions: [],
};

describe("isEffectiveWorkflow: what it accepts", () => {
  it("accepts a custom workflow with a string workflowId", () => {
    expect(isEffectiveWorkflow({ source: "custom", workflowId: "wf-1", definition })).toBe(true);
  });

  it("accepts a default workflow with a null workflowId", () => {
    expect(isEffectiveWorkflow({ source: "default", workflowId: null, definition })).toBe(true);
  });

  it("accepts extra keys (the write routes add a `report`)", () => {
    expect(
      isEffectiveWorkflow({ source: "custom", workflowId: "wf-1", definition, report: { outsideWorkflow: [] } }),
    ).toBe(true);
  });

  it("accepts a definition whose states array is empty (the shape is the contract, not the content)", () => {
    expect(isEffectiveWorkflow({ source: "custom", workflowId: "wf-1", definition: { states: [] } })).toBe(true);
  });
});

describe("isEffectiveWorkflow: what it refuses", () => {
  it("refuses the mock artifact body {ok:true}", () => {
    expect(isEffectiveWorkflow({ ok: true })).toBe(false);
  });

  it("refuses non-objects (null, a string, undefined, a number)", () => {
    for (const v of [null, "workflow", undefined, 7]) {
      expect(isEffectiveWorkflow(v)).toBe(false);
    }
  });

  it("refuses an array", () => {
    expect(isEffectiveWorkflow([{ source: "custom", workflowId: null, definition }])).toBe(false);
  });

  it("refuses a wrong or missing source", () => {
    expect(isEffectiveWorkflow({ source: "shared", workflowId: null, definition })).toBe(false);
    expect(isEffectiveWorkflow({ workflowId: null, definition })).toBe(false);
  });

  it("refuses a workflowId that is absent or not a string", () => {
    expect(isEffectiveWorkflow({ source: "custom", definition })).toBe(false);
    expect(isEffectiveWorkflow({ source: "custom", workflowId: 3, definition })).toBe(false);
  });

  it("refuses a definition that is absent, null, not an object or an array", () => {
    expect(isEffectiveWorkflow({ source: "custom", workflowId: null })).toBe(false);
    expect(isEffectiveWorkflow({ source: "custom", workflowId: null, definition: null })).toBe(false);
    expect(isEffectiveWorkflow({ source: "custom", workflowId: null, definition: "states" })).toBe(false);
    expect(isEffectiveWorkflow({ source: "custom", workflowId: null, definition: [] })).toBe(false);
  });

  it("refuses a definition without a states array", () => {
    expect(isEffectiveWorkflow({ source: "custom", workflowId: null, definition: {} })).toBe(false);
    expect(
      isEffectiveWorkflow({ source: "custom", workflowId: null, definition: { states: "open" } }),
    ).toBe(false);
  });
});
