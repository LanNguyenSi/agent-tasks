/**
 * buildBoardColumns: the board's column list from the project's stored
 * workflows. Order (backlog first, default workflow's states with the initial
 * state first and terminal states last, pinned-workflow-only states after,
 * in workflow order), label precedence (workflow label, then the built-in
 * STATUS_LABELS name, then the readable state name), the built-in fallbacks
 * (unreadable workflow list, missing default row, unreadable definition),
 * the reserved backlog state, one column per duplicated state name, the
 * reserved abandoned status (never a column), and the no-invisible-task
 * invariant (every fixture: the column set covers every task status but an
 * abandoned one exactly once).
 */
import { describe, it, expect } from "vitest";
import { buildBoardColumns, type BoardColumn } from "../../src/lib/boardColumns";
import { sanitizeStoredDefinition } from "../../src/lib/workflow-vocabulary";
import { WORKFLOW_VOCABULARY_FIXTURES } from "../../src/lib/__fixtures__/workflow-vocabulary-fixtures";
import type { Workflow } from "../../src/lib/api";

function workflow(over: Partial<Workflow> & { id: string }): Workflow {
  return {
    projectId: "p-1",
    name: over.isDefault === false ? "Pinned" : "Default",
    isDefault: true,
    definition: {
      initialState: "open",
      states: [
        { name: "open", label: "Open", terminal: false },
        { name: "in_progress", label: "In Progress", terminal: false },
        { name: "review", label: "Review", terminal: false },
        { name: "done", label: "Done", terminal: true },
      ],
      transitions: [
        { from: "open", to: "in_progress" },
        { from: "in_progress", to: "review" },
        { from: "review", to: "done" },
      ],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Workflow;
}

function definition(
  initialState: string,
  states: [name: string, label: string, terminal: boolean][],
  edges: [from: string, to: string][],
) {
  return {
    initialState,
    states: states.map(([name, label, terminal]) => ({ name, label, terminal })),
    transitions: edges.map(([from, to]) => ({ from, to })),
  };
}

const CUSTOM = definition(
  "open",
  [
    ["open", "Open", false],
    ["plan", "Planning", false],
    ["build", "Build", false],
    ["qa", "QA", false],
    ["shipped", "Shipped", true],
  ],
  [
    ["open", "plan"],
    ["plan", "build"],
    ["build", "qa"],
    ["qa", "shipped"],
    ["qa", "build"],
  ],
);

const statuses = (columns: BoardColumn[]) => columns.map((c) => c.status);

/** The column counts as BoardView renders them add up to every task handed in
 *  except the abandoned ones, which the board never shows. */
const sumInvariant = (columns: BoardColumn[], tasks: { status: string }[]) => {
  const countable = tasks.filter((t) => t.status !== "abandoned");
  const counts = columns.reduce((sum, c) => sum + tasks.filter((t) => t.status === c.status).length, 0);
  expect(counts).toBe(countable.length);
};

describe("buildBoardColumns -- built-in workflow", () => {
  const builtIn = [workflow({ id: "w1" })];

  it("gives the five built-in columns in today's order with today's labels and ids", () => {
    const columns = buildBoardColumns(builtIn, []);
    expect(statuses(columns)).toEqual(["backlog", "open", "in_progress", "review", "done"]);
    expect(columns.map((c) => c.label)).toEqual(["Backlog", "Open", "In Progress", "Review", "Done"]);
    expect(columns.map((c) => c.builtIn)).toEqual([true, true, true, true, true]);
    expect(columns.map((c) => c.terminal)).toEqual([false, false, false, false, true]);
  });

  it("is the same five when the list is unreadable (null or undefined)", () => {
    for (const workflows of [null, undefined]) {
      const columns = buildBoardColumns(workflows, []);
      expect(statuses(columns)).toEqual(["backlog", "open", "in_progress", "review", "done"]);
    }
  });

  it("is the same five for an empty workflow list (no default row)", () => {
    expect(statuses(buildBoardColumns([], []))).toEqual([
      "backlog",
      "open",
      "in_progress",
      "review",
      "done",
    ]);
  });

  it("falls back to the five built-in columns when the default definition cannot be read", () => {
    const broken = workflow({ id: "w1", definition: { states: "not-a-list" } as unknown as Workflow["definition"] });
    expect(statuses(buildBoardColumns([broken], []))).toEqual([
      "backlog",
      "open",
      "in_progress",
      "review",
      "done",
    ]);
  });

  it("puts backlog first even when nothing else does", () => {
    const columns = buildBoardColumns([workflow({ id: "w1", isDefault: false })], []);
    expect(columns[0]!.status).toBe("backlog");
  });
});

describe("buildBoardColumns -- custom default workflow", () => {
  it("lists the default workflow's states in graph order: initial first, terminal last", () => {
    const columns = buildBoardColumns([workflow({ id: "w1", definition: CUSTOM as Workflow["definition"] })], []);
    expect(statuses(columns)).toEqual(["backlog", "open", "plan", "build", "qa", "shipped"]);
    expect(columns.map((c) => c.label)).toEqual(["Backlog", "Open", "Planning", "Build", "QA", "Shipped"]);
    expect(columns.find((c) => c.status === "shipped")!.terminal).toBe(true);
    expect(columns.find((c) => c.status === "qa")!.terminal).toBe(false);
  });

  it("moves a terminal state to the last column even when the graph reaches it early", () => {
    // Terminal state named before the states the walk reaches later.
    const def = definition(
      "open",
      [
        ["open", "Open", false],
        ["shipped", "Shipped", true],
        ["plan", "Plan", false],
      ],
      [
        ["open", "shipped"],
        ["open", "plan"],
        ["plan", "shipped"],
      ],
    );
    const columns = buildBoardColumns([workflow({ id: "w1", definition: def as Workflow["definition"] })], []);
    expect(statuses(columns)).toEqual(["backlog", "open", "plan", "shipped"]);
  });

  it("keeps states no edge reaches behind the walked ones, in listed order, before the terminal states", () => {
    const def = definition(
      "open",
      [
        ["orphan", "Orphan", false],
        ["open", "Open", false],
        ["next", "Next", false],
        ["done", "Done", true],
      ],
      [
        ["open", "next"],
        ["next", "done"],
      ],
    );
    const columns = buildBoardColumns([workflow({ id: "w1", definition: def as Workflow["definition"] })], []);
    expect(statuses(columns)).toEqual(["backlog", "open", "next", "orphan", "done"]);
  });

  it("never renders a second backlog column for a legacy definition that mentions backlog", () => {
    const legacy = definition(
      "backlog",
      [
        ["backlog", "Backlog", false],
        ["open", "Open", false],
        ["done", "Done", true],
      ],
      [
        ["backlog", "open"],
        ["open", "done"],
      ],
    );
    const columns = buildBoardColumns([workflow({ id: "w1", definition: legacy as unknown as Workflow["definition"] })], []);
    // sanitizeStoredDefinition: initial state reads as open, the backlog
    // state is dropped; the board's own backlog column stays first.
    expect(statuses(columns)).toEqual(["backlog", "open", "done"]);
  });

  it("ignores a backlog state of a modern definition (reserved name, backend-refused)", () => {
    const def = definition(
      "open",
      [
        ["open", "Open", false],
        ["backlog", "Sneaky", false],
        ["done", "Done", true],
      ],
      [
        ["open", "done"],
      ],
    );
    const columns = buildBoardColumns([workflow({ id: "w1", definition: def as Workflow["definition"] })], []);
    expect(statuses(columns)).toEqual(["backlog", "open", "done"]);
    expect(columns[0]!.label).toBe("Backlog");
  });

  it("tripwire: every stored fixture definition starts at open, the only start with a + on the board", () => {
    // The + renders on backlog and open only, because the backend refuses an
    // initialState other than `open` (`workflowDefinitionSchema` in
    // `backend/src/routes/workflows.ts`). If a future change unlocked the
    // initial state, a stored workflow could start at a custom state whose
    // column has no +, and a task there would be uncreatable from the board:
    // this walk over the shared fixture corpus (the same definitions the
    // backend parity test reads) fails then and names what to revisit.
    const offenders: string[] = [];
    for (const fixture of WORKFLOW_VOCABULARY_FIXTURES) {
      try {
        const initial = sanitizeStoredDefinition(fixture.definition).initialState;
        if (initial !== "open") offenders.push(`${fixture.name}: ${String(initial)}`);
      } catch {
        // Unreadable definitions fall back to the built-in workflow, open.
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("buildBoardColumns -- pinned workflows and duplicates", () => {
  it("appends states that only occur in other workflows, in the order the workflows are listed", () => {
    const pinnedA = workflow({
      id: "w2",
      isDefault: false,
      name: "Pinned A",
      definition: definition(
        "open",
        [
          ["open", "Open", false],
          ["expedite", "Expedite", false],
          ["won", "Won", true],
        ],
        [
          ["open", "expedite"],
          ["expedite", "won"],
        ],
      ) as Workflow["definition"],
    });
    const pinnedB = workflow({
      id: "w3",
      isDefault: false,
      name: "Pinned B",
      definition: definition(
        "open",
        [
          ["open", "Open", false],
          ["hold", "Hold", false],
          ["closed", "Closed", true],
        ],
        [
          ["open", "hold"],
          ["hold", "closed"],
        ],
      ) as Workflow["definition"],
    });
    const columns = buildBoardColumns([workflow({ id: "w1" }), pinnedA, pinnedB], []);
    expect(statuses(columns)).toEqual([
      "backlog",
      "open",
      "in_progress",
      "review",
      "done",
      "expedite",
      "won",
      "hold",
      "closed",
    ]);
  });

  it("reverses that order when the pinned workflows swap places", () => {
    const pinnedA = workflow({
      id: "w2",
      isDefault: false,
      definition: definition(
        "open",
        [
          ["open", "", false],
          ["expedite", "", false],
          ["won", "", true],
        ],
        [
          ["open", "expedite"],
          ["expedite", "won"],
        ],
      ) as Workflow["definition"],
    });
    const pinnedB = workflow({
      id: "w3",
      isDefault: false,
      definition: definition(
        "open",
        [
          ["open", "", false],
          ["hold", "", false],
          ["closed", "", true],
        ],
        [
          ["open", "hold"],
          ["hold", "closed"],
        ],
      ) as Workflow["definition"],
    });
    const columns = buildBoardColumns([workflow({ id: "w1" }), pinnedB, pinnedA], []);
    expect(statuses(columns).slice(5)).toEqual(["hold", "closed", "expedite", "won"]);
  });

  it("lists a state named in several workflows once, labelled from the first that names it", () => {
    const pinned = workflow({
      id: "w2",
      isDefault: false,
      definition: definition(
        "open",
        [
          ["open", "Ready", false],
          ["triage", "Triage", false],
          ["shipped", "Out", true],
        ],
        [
          ["open", "triage"],
          ["triage", "shipped"],
        ],
      ) as Workflow["definition"],
    });
    const columns = buildBoardColumns([workflow({ id: "w1" }), pinned], []);
    expect(statuses(columns)).toEqual(["backlog", "open", "in_progress", "review", "done", "triage", "shipped"]);
    // open is a built-in name: the board vocabulary wins over "Ready".
    expect(columns.find((c) => c.status === "open")!.label).toBe("Open");
    // The pinned-only states take their workflow labels.
    expect(columns.find((c) => c.status === "triage")!.label).toBe("Triage");
    expect(columns.find((c) => c.status === "shipped")!.label).toBe("Out");
  });

  it("treats an unreadable pinned definition as contributing no states", () => {
    const broken = workflow({
      id: "w2",
      isDefault: false,
      definition: { transitions: "nope" } as unknown as Workflow["definition"],
    });
    const columns = buildBoardColumns([workflow({ id: "w1" }), broken], []);
    expect(statuses(columns)).toEqual(["backlog", "open", "in_progress", "review", "done"]);
  });
});

describe("buildBoardColumns -- label precedence", () => {
  it("uses the workflow state's label when it is set on a custom state", () => {
    const def = definition(
      "open",
      [
        ["open", "Ready", false],
        ["plan", "Planning", false],
        ["shipped", "Shipped!", true],
      ],
      [
        ["open", "plan"],
        ["plan", "shipped"],
      ],
    );
    const columns = buildBoardColumns([workflow({ id: "w1", definition: def as Workflow["definition"] })], []);
    expect(columns.find((c) => c.status === "plan")!.label).toBe("Planning");
    expect(columns.find((c) => c.status === "shipped")!.label).toBe("Shipped!");
  });

  it("keeps the built-in board names for the five built-in states even when the workflow labels them differently", () => {
    // The stored built-in default labels "In progress" / "In review"; the
    // board's five columns keep today's STATUS_LABELS titles (pixel rule).
    const def = definition(
      "open",
      [
        ["open", "Ready", false],
        ["in_progress", "In progress", false],
        ["review", "In review", false],
        ["done", "Done!", true],
      ],
      [
        ["open", "in_progress"],
        ["in_progress", "review"],
        ["review", "done"],
      ],
    );
    const columns = buildBoardColumns([workflow({ id: "w1", definition: def as Workflow["definition"] })], []);
    expect(columns.map((c) => c.label)).toEqual(["Backlog", "Open", "In Progress", "Review", "Done"]);
  });

  it("falls back to the built-in STATUS_LABELS name when a built-in state has no label", () => {
    const def = definition(
      "open",
      [
        ["open", "", false],
        ["in_progress", "   ", false],
        ["done", "", true],
      ],
      [
        ["open", "in_progress"],
        ["in_progress", "done"],
      ],
    );
    const columns = buildBoardColumns([workflow({ id: "w1", definition: def as Workflow["definition"] })], []);
    expect(columns.find((c) => c.status === "open")!.label).toBe("Open");
    expect(columns.find((c) => c.status === "in_progress")!.label).toBe("In Progress");
    expect(columns.find((c) => c.status === "done")!.label).toBe("Done");
  });

  it("makes a custom state name readable when it has neither a workflow label nor a built-in name", () => {
    const def = definition(
      "open",
      [
        ["open", "", false],
        ["waiting_on", "", false],
        ["done", "", true],
      ],
      [
        ["open", "waiting_on"],
        ["waiting_on", "done"],
      ],
    );
    const columns = buildBoardColumns([workflow({ id: "w1", definition: def as Workflow["definition"] })], []);
    expect(columns.find((c) => c.status === "waiting_on")!.label).toBe("Waiting on");
  });
});

describe("buildBoardColumns -- unknown statuses (every task but an abandoned one is visible)", () => {
  it("adds an extra last column per status no column covers, titled with the raw name", () => {
    const columns = buildBoardColumns([workflow({ id: "w1" })], [
      { status: "open" },
      { status: "legacy_x" },
      { status: "gone_state" },
      { status: "legacy_x" },
    ]);
    expect(statuses(columns)).toEqual(["backlog", "open", "in_progress", "review", "done", "legacy_x", "gone_state"]);
    expect(columns[5]!.label).toBe("legacy_x");
    expect(columns[5]!.builtIn).toBe(false);
    expect(columns[5]!.terminal).toBe(false);
  });

  it("titles an extra column whose name is a built-in state with the board's own label", () => {
    // A custom workflow that left in_progress, review and done out: work still
    // in those states is not shown under a lowercase raw name.
    const columns = buildBoardColumns([workflow({ id: "w1", definition: CUSTOM as Workflow["definition"] })], [
      { status: "in_progress" },
      { status: "review" },
      { status: "done" },
      { status: "legacy_x" },
    ]);
    expect(statuses(columns).slice(6)).toEqual(["in_progress", "review", "done", "legacy_x"]);
    expect(columns.slice(6).map((c) => c.label)).toEqual(["In Progress", "Review", "Done", "legacy_x"]);
    // Still an extra column, not a workflow column: no built-in treatment.
    expect(columns.slice(6).map((c) => c.builtIn)).toEqual([false, false, false, false]);
  });

  it("adds the extra column even when the workflows are unreadable", () => {
    const columns = buildBoardColumns(null, [{ status: "plan" }]);
    expect(statuses(columns)).toEqual(["backlog", "open", "in_progress", "review", "done", "plan"]);
  });

  it("adds no extra column when every status has one", () => {
    const columns = buildBoardColumns([workflow({ id: "w1" })], [
      { status: "backlog" },
      { status: "open" },
      { status: "in_progress" },
      { status: "review" },
      { status: "done" },
    ]);
    expect(columns).toHaveLength(5);
  });

  it("gives abandoned tasks no column on the built-in workflow (the board never showed them)", () => {
    const tasks = [{ status: "abandoned" }, { status: "abandoned" }, { status: "open" }];
    const columns = buildBoardColumns([workflow({ id: "w1" })], tasks);
    expect(statuses(columns)).toEqual(["backlog", "open", "in_progress", "review", "done"]);
    // The two discarded tasks are counted nowhere: no column claims the status.
    expect(columns.filter((c) => c.status === "abandoned")).toHaveLength(0);
    expect(columns.reduce((sum, c) => sum + tasks.filter((t) => t.status === c.status).length, 0)).toBe(1);
  });

  it("gives abandoned tasks no column on a custom workflow either", () => {
    const columns = buildBoardColumns([workflow({ id: "w1", definition: CUSTOM as Workflow["definition"] })], [
      { status: "abandoned" },
      { status: "shipped" },
    ]);
    expect(statuses(columns)).toEqual(["backlog", "open", "plan", "build", "qa", "shipped"]);
    expect(statuses(columns)).not.toContain("abandoned");
  });

  it("sums to the task count for every fixture shape (column set covers every status but an abandoned one once)", () => {
    const fixtures: [readonly Workflow[] | null, { status: string }[]][] = [
      [[workflow({ id: "w1" })], []],
      [[workflow({ id: "w1" })], [{ status: "open" }, { status: "open" }, { status: "done" }]],
      [null, [{ status: "open" }, { status: "nope" }]],
      [[], [{ status: "gone" }, { status: "backlog" }]],
      [[workflow({ id: "w1" })], [{ status: "abandoned" }, { status: "abandoned" }]],
      [[workflow({ id: "w1" })], [{ status: "abandoned" }, { status: "open" }, { status: "legacy_x" }]],
      [
        [workflow({ id: "w1", definition: CUSTOM as Workflow["definition"] })],
        [
          { status: "backlog" },
          { status: "open" },
          { status: "plan" },
          { status: "build" },
          { status: "qa" },
          { status: "shipped" },
          { status: "legacy_x" },
          { status: "in_progress" },
          { status: "abandoned" },
        ],
      ],
    ];
    for (const [workflows, tasks] of fixtures) {
      const columns = buildBoardColumns(workflows, tasks);
      expect(new Set(statuses(columns)).size, "one column per status").toBe(statuses(columns).length);
      expect(statuses(columns), "abandoned is never a column").not.toContain("abandoned");
      const countable = tasks.filter((t) => t.status !== "abandoned");
      const covered = countable.filter((t) => columns.some((c) => c.status === t.status)).length;
      expect(covered, "no task without a column").toBe(countable.length);
      sumInvariant(columns, tasks);
    }
  });
});
