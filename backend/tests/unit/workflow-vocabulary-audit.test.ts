/**
 * Classification of one stored workflow row by the vocabulary audit, and the
 * guarantee that the audit only reads (a client without any write method
 * suffices).
 */
import { describe, expect, it, vi } from "vitest";
import { auditWorkflowVocabulary, classifyWorkflowRow } from "../../src/scripts/workflow-vocabulary-audit.js";
import { defaultWorkflowDefinition } from "../../src/services/default-workflow.js";

const row = (definition: unknown) => ({ id: "w1", projectId: "p1", name: "W", isDefault: true, definition });
const def = (initialState: string, names: string[], edges: Array<[string, string]> = []) => ({
  initialState,
  states: names.map((name) => ({ name, label: name, terminal: name === "done" })),
  transitions: edges.map(([from, to]) => ({ from, to })),
});

describe("classifyWorkflowRow", () => {
  it("leaves the built-in four-state definition out", () => {
    expect(classifyWorkflowRow(row(defaultWorkflowDefinition()))).toBeNull();
  });

  it("flags a custom state name and lists it sorted and unique", () => {
    expect(classifyWorkflowRow(row(def("open", ["open", "qa", "build", "done"])))).toMatchObject({
      hasBacklog: false,
      outsideBuiltIns: ["build", "qa"],
    });
  });

  it("flags a backlog state without counting it as another name", () => {
    expect(classifyWorkflowRow(row(def("open", ["open", "backlog", "done"])))).toMatchObject({
      hasBacklog: true,
      outsideBuiltIns: [],
    });
  });

  it.each([
    ["an initialState of backlog", def("backlog", ["open", "done"])],
    ["an edge from backlog", def("open", ["open", "done"], [["backlog", "open"]])],
    ["an edge to backlog", def("open", ["open", "done"], [["open", "backlog"]])],
  ])("flags %s", (_label, definition) => {
    expect(classifyWorkflowRow(row(definition))).toMatchObject({ hasBacklog: true });
  });

  it.each([null, "text", 3, [], {}, { states: [], transitions: "x" }, { states: {}, transitions: [] }])(
    "reports %j as unreadable",
    (definition) => {
      expect(classifyWorkflowRow(row(definition))).toBe("unreadable");
    },
  );

  it("skips malformed state and edge entries instead of throwing", () => {
    const definition = { initialState: "open", states: [null, { name: 4 }, { name: "open" }], transitions: [null, 1, { from: "open", to: "open" }] };
    expect(classifyWorkflowRow(row(definition))).toBeNull();
  });
});

describe("auditWorkflowVocabulary", () => {
  it("only calls findMany and count", async () => {
    const findMany = vi.fn().mockResolvedValue([row(def("backlog", ["backlog", "spec"])), { ...row(defaultWorkflowDefinition()), id: "w2" }]);
    const count = vi.fn().mockResolvedValue(3);
    const client = { workflow: { findMany }, task: { count } };
    const audit = await auditWorkflowVocabulary(client);
    expect(audit).toMatchObject({ totalRows: 2, affectedRows: 1, rowsWithBacklog: 1, rowsWithOtherNames: 1 });
    expect(audit.affected[0]).toMatchObject({ id: "w1", pinnedTasks: 3 });
    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({ where: { workflowId: "w1" } });
    expect(Object.keys(client.workflow)).toEqual(["findMany"]);
    expect(Object.keys(client.task)).toEqual(["count"]);
  });
});
