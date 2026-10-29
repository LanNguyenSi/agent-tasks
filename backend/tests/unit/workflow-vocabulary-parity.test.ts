import { describe, expect, it } from "vitest";
import {
  reviewStates,
  sanitizeStoredDefinition,
  terminalStates,
  type WorkflowDefinitionShape,
} from "../../src/services/default-workflow.js";
import { buildTaskStatusFilter } from "../../src/services/workflow-status-filter.js";
import { WORKFLOW_VOCABULARY_FIXTURES } from "../../../frontend/src/lib/__fixtures__/workflow-vocabulary-fixtures.js";

/**
 * The terminal and review-like names the backend reads from a stored workflow,
 * through the filter builders that every status filter uses (so the fallback
 * for an unreadable definition is included). The frontend port in
 * frontend/src/lib/workflow-vocabulary.ts answers from the same fixture file,
 * so a change here that moves an answer breaks this test before the /tasks
 * presets and the Home widgets drift from the server.
 */
function backendNames(definition: unknown, kind: "review" | "terminal"): string[] {
  const row = { id: "wf-1", projectId: "p-1", isDefault: true, definition };
  const filter = buildTaskStatusFilter([row], kind === "review" ? { kind, match: "in" } : { kind, match: "notIn" });
  const branches = (filter.OR ?? []) as { workflowId?: { in: string[] }; status?: { in?: string[]; notIn?: string[] } }[];
  const pinned = branches.find((b) => b.workflowId?.in.includes("wf-1"));
  return pinned?.status?.in ?? pinned?.status?.notIn ?? [];
}

describe("stored workflow vocabulary: the backend answers the shared fixtures", () => {
  it.each(WORKFLOW_VOCABULARY_FIXTURES.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    expect({
      review: backendNames(fixture.definition, "review"),
      terminal: backendNames(fixture.definition, "terminal"),
    }).toEqual(fixture.expected);
  });

  it("covers the failure shapes: initial backlog, a legacy default copy and a missing transitions list", () => {
    const names = WORKFLOW_VOCABULARY_FIXTURES.map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "built-in workflow",
        "initial backlog with a backlog -> review edge",
        expect.stringMatching(/^legacy copy of the built-in default/),
        "states list without a transitions list",
        expect.stringMatching(/reachable from two places/),
      ]),
    );
  });

  it("agrees with reviewStates and terminalStates of the sanitized definition where the definition is readable", () => {
    for (const fixture of WORKFLOW_VOCABULARY_FIXTURES) {
      let def: WorkflowDefinitionShape;
      let review: string[];
      let terminal: string[];
      try {
        def = sanitizeStoredDefinition(fixture.definition);
        review = reviewStates(def);
        terminal = terminalStates(def);
      } catch {
        continue; // unreadable: the filter builders fall back to the built-in names
      }
      expect({ name: fixture.name, review: [...new Set(review)].sort(), terminal: [...new Set(terminal)].sort() }).toEqual({
        name: fixture.name,
        ...fixture.expected,
      });
    }
  });
});
