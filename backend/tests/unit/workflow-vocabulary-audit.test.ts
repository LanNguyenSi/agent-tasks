/**
 * Classification of one stored workflow row by the vocabulary audit, and the
 * guarantee that the audit only reads (a client without any write method
 * suffices).
 */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { auditWorkflowVocabulary, classifyWorkflowRow, isInvokedDirectly } from "../../src/scripts/workflow-vocabulary-audit.js";
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
  /** A client whose every property access is recorded, so a write method would show up in `touched`. */
  function recordingClient(rows: unknown[], taskCount: (where: Record<string, unknown>) => number) {
    const touched: string[] = [];
    const calls: Array<Record<string, unknown>> = [];
    const guard = (table: string, impl: Record<string, (...args: never[]) => unknown>) =>
      new Proxy(impl, {
        get(target, prop) {
          touched.push(`${table}.${String(prop)}`);
          return Reflect.get(target, prop);
        },
      });
    const client = {
      workflow: guard("workflow", { findMany: (async () => rows) as never }),
      task: guard("task", {
        count: (async (args: { where: Record<string, unknown> }) => {
          calls.push(args.where);
          return taskCount(args.where);
        }) as never,
      }),
    };
    return { client, touched, calls };
  }

  it("only reads: findMany and count are the only properties it touches", async () => {
    const { client, touched } = recordingClient([row(def("backlog", ["backlog", "spec"]))], () => 0);
    await auditWorkflowVocabulary(client as never);
    expect([...new Set(touched)].sort()).toEqual(["task.count", "workflow.findMany"]);
  });

  it("counts explicit pins by workflowId and, for a default row, implicit followers by project", async () => {
    const rows = [
      row(def("backlog", ["backlog", "spec"])),
      { ...row(def("open", ["open", "qa", "done"])), id: "w2", projectId: "p2", isDefault: false },
      { ...row(defaultWorkflowDefinition()), id: "w3" },
    ];
    const { client, calls } = recordingClient(rows, (where) => (where.workflowId === null ? 4 : 3));
    const audit = await auditWorkflowVocabulary(client as never);
    expect(audit).toMatchObject({ totalRows: 3, affectedRows: 2, rowsWithBacklog: 1, rowsWithOtherNames: 2 });
    expect(audit.affected.map((r) => [r.id, r.pinnedTasks, r.implicitTasks])).toEqual([
      ["w1", 3, 4],
      ["w2", 3, 0],
    ]);
    expect(calls).toEqual([{ workflowId: "w1" }, { projectId: "p1", workflowId: null }, { workflowId: "w2" }]);
  });
});

describe("isInvokedDirectly", () => {
  const moduleUrl = pathToFileURL(resolve("src/scripts/workflow-vocabulary-audit.ts")).href;
  const modulePath = resolve("src/scripts/workflow-vocabulary-audit.ts");

  it("is true for the module's own path", () => {
    expect(isInvokedDirectly(modulePath, moduleUrl)).toBe(true);
  });

  it("is true when started through a symlink to the module", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-link-"));
    const link = join(dir, "run-audit.ts");
    try {
      symlinkSync(modulePath, link);
      expect(isInvokedDirectly(link, moduleUrl)).toBe(true);
    } finally {
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true });
    }
  });

  it("is false for another file, a missing path and no path", () => {
    expect(isInvokedDirectly(resolve("src/scripts/shadow-report.ts"), moduleUrl)).toBe(false);
    expect(isInvokedDirectly(join(tmpdir(), "does-not-exist-audit.ts"), moduleUrl)).toBe(false);
    expect(isInvokedDirectly(undefined, moduleUrl)).toBe(false);
  });
});
