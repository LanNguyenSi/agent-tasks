/**
 * The terminal and review-like names the /tasks presets and the Home widgets
 * read from a stored workflow, against the backend's answers for the shared
 * fixtures (src/lib/__fixtures__/workflow-vocabulary-fixtures.ts, whose
 * expected values the backend test backend/tests/unit/workflow-vocabulary-parity.test.ts
 * pins): the backend judges a definition only after sanitizing it, and falls
 * back to the built-in names when it cannot read it.
 */
import { describe, expect, it } from "vitest";
import type { Workflow } from "../../src/lib/api";
import { WORKFLOW_VOCABULARY_FIXTURES } from "../../src/lib/__fixtures__/workflow-vocabulary-fixtures";
import { storedReviewStates, storedTerminalStates } from "../../src/lib/workflow-vocabulary";
import {
  reviewStatesResolver,
  terminalStatesResolver,
  workflowStatusNames,
} from "../../src/app/home/widgetFilters";

function row(definition: unknown): Workflow {
  return {
    id: "wf-1",
    projectId: "p1",
    name: "wf",
    isDefault: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    definition,
  } as Workflow;
}

const task = { projectId: "p1" };
const fixture = (prefix: string) => {
  const f = WORKFLOW_VOCABULARY_FIXTURES.find((x) => x.name.startsWith(prefix));
  if (!f) throw new Error(`no fixture ${prefix}`);
  return f;
};

describe("stored workflow vocabulary: the port answers the backend's names for every shared fixture", () => {
  it.each(WORKFLOW_VOCABULARY_FIXTURES.map((f) => [f.name, f] as const))("%s", (_name, f) => {
    const wf = row(f.definition);
    expect({ review: storedReviewStates(wf), terminal: storedTerminalStates(wf) }).toEqual(f.expected);
    // The per-task resolvers the widgets and the row filters use read the same names.
    const byProject = new Map([["p1", [wf]]]);
    expect([...reviewStatesResolver(byProject)(task)].sort()).toEqual(f.expected.review);
    expect([...terminalStatesResolver(byProject)(task)].sort()).toEqual(f.expected.terminal);
  });
});

describe("the requests ask for the sanitized view of a stored workflow", () => {
  it("an initial backlog with a backlog -> review edge: review is review-like, nothing else is added", () => {
    const names = workflowStatusNames(new Map([["p1", [row(fixture("initial backlog with a backlog -> review").definition)]]]));
    expect(names.review).toEqual(["review"]);
    expect(names.terminal).toEqual(["done"]);
    expect(names.actionable).toEqual(["open", "in_progress", "review"]);
  });

  it("a legacy copy of the built-in default: in_progress is not review-like", () => {
    const byProject = new Map([["p1", [row(fixture("legacy copy of the built-in default").definition)]]]);
    expect(workflowStatusNames(byProject).review).toEqual(["review"]);
    expect([...reviewStatesResolver(byProject)({ projectId: "p1" })]).toEqual(["review"]);
  });

  it("a states list without a transitions list: the built-in review name is the fallback and the terminal states stay its own", () => {
    const byProject = new Map([["p1", [row(fixture("states list without a transitions list").definition)]]]);
    const names = workflowStatusNames(byProject);
    expect(names.review).toEqual(["review"]);
    expect(names.terminal).toEqual(["done", "shipped"]);
    expect(names.actionable).toEqual(["open", "in_progress", "review", "check"]);
  });

  it("never lists backlog as an actionable or terminal name, however the stored definition spells it", () => {
    const names = workflowStatusNames(
      new Map([
        ["p1", [row(fixture("terminal backlog").definition)]],
        ["p2", [{ ...row(fixture("backlog state kept").definition), id: "wf-2", projectId: "p2" }]],
      ]),
    );
    expect(names.terminal).not.toContain("backlog");
    expect(names.actionable).not.toContain("backlog");
  });

  it("a stored definition that cannot be read adds no names beyond the built-in ones", () => {
    for (const prefix of ["states is not a list", "definition is null", "a state entry that is not an object"]) {
      expect(workflowStatusNames(new Map([["p1", [row(fixture(prefix).definition)]]]))).toEqual({
        actionable: ["open", "in_progress", "review"],
        review: ["review"],
        terminal: ["done"],
      });
    }
  });
});
