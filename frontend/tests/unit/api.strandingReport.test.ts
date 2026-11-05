/**
 * The REAL workflow-write helpers (no module mock): each hands back the
 * stranding report fields of the 2xx body (`terminalOutsideWorkflow`,
 * `terminalOutsideTruncated`, `outsideWorkflow`, `outsideTruncated`) as
 * `report`, next to the value it returned before.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  applyWorkflowTemplate,
  createWorkflow,
  resetProjectWorkflow,
  updateWorkflow,
  type WorkflowDefinition,
} from "../../src/lib/api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const DEF: WorkflowDefinition = {
  initialState: "open",
  states: [
    { name: "open", label: "Open", terminal: false },
    { name: "done", label: "Done", terminal: true },
  ],
  transitions: [{ from: "open", to: "done", requiredRole: "any" }],
};

const WORKFLOW = {
  id: "wf-1",
  projectId: "p-1",
  name: "W",
  isDefault: true,
  definition: DEF,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const REPORT = {
  terminalOutsideWorkflow: [{ id: "t-1", status: "shipped" }],
  terminalOutsideTruncated: true,
  outsideWorkflow: [{ id: "t-2", status: "legacy" }],
  outsideTruncated: false,
};

function respondWith(body: unknown) {
  let seen: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return () => seen!;
}

describe("updateWorkflow", () => {
  it("returns { workflow, report } from PUT /api/workflows/:id", async () => {
    const seen = respondWith({ workflow: WORKFLOW, ...REPORT });
    const result = await updateWorkflow("wf-1", { definition: DEF });
    expect(seen().url).toMatch(/\/api\/workflows\/wf-1$/);
    expect(seen().init?.method).toBe("PUT");
    expect(result).toEqual({ workflow: WORKFLOW, report: REPORT });
  });

  it("an older backend without the fields gives a report with no lists", async () => {
    respondWith({ workflow: WORKFLOW });
    const result = await updateWorkflow("wf-1", { name: "x" });
    expect(result.workflow).toEqual(WORKFLOW);
    expect(result.report.terminalOutsideWorkflow).toBeUndefined();
    expect(result.report.outsideWorkflow).toBeUndefined();
  });
});

describe("applyWorkflowTemplate", () => {
  it("keeps the effective-workflow fields and adds the report", async () => {
    const seen = respondWith({ source: "custom", workflowId: "wf-1", definition: DEF, ...REPORT });
    const result = await applyWorkflowTemplate("p-1", "tpl");
    expect(seen().url).toMatch(/\/api\/projects\/p-1\/workflow\/apply-template\/tpl$/);
    expect(result).toEqual({ source: "custom", workflowId: "wf-1", definition: DEF, report: REPORT });
  });
});

describe("resetProjectWorkflow", () => {
  it("keeps the effective-workflow fields and adds the report", async () => {
    const seen = respondWith({ source: "default", workflowId: null, definition: DEF, ...REPORT });
    const result = await resetProjectWorkflow("p-1");
    expect(seen().url).toMatch(/\/api\/projects\/p-1\/workflow$/);
    expect(seen().init?.method).toBe("DELETE");
    expect(result).toEqual({ source: "default", workflowId: null, definition: DEF, report: REPORT });
  });
});

describe("createWorkflow", () => {
  it("keeps the workflow fields and adds the report", async () => {
    const seen = respondWith({ workflow: WORKFLOW, ...REPORT });
    const result = await createWorkflow("p-1", { name: "W", isDefault: true, definition: DEF });
    expect(seen().url).toMatch(/\/api\/projects\/p-1\/workflows$/);
    expect(result).toEqual({ ...WORKFLOW, report: REPORT });
  });
});
