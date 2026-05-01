import { describe, expect, it } from "vitest";
import {
  formatTasks,
  formatTask,
  formatSignals,
  formatProjects,
  formatProject,
  formatPickup,
  formatStart,
  formatGates,
} from "../src/format.js";

describe("formatTasks", () => {
  const tasks = [
    { id: "t1", title: "Fix bug", status: "open", priority: "HIGH", project: { name: "p", slug: "p" } },
    { id: "t2", title: "Add feature", status: "review", priority: "MEDIUM", project: { name: "p", slug: "p" } },
  ];

  it("formats as table by default", () => {
    const out = formatTasks(tasks, "table");
    expect(out).toContain("Fix bug");
    expect(out).toContain("HIGH");
    expect(out).toContain("PRIORITY");
  });

  it("formats as JSON", () => {
    const out = formatTasks(tasks, "json");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("t1");
  });

  it("formats as quiet (IDs only)", () => {
    const out = formatTasks(tasks, "quiet");
    expect(out).toBe("t1\nt2");
  });

  it("shows message for empty list", () => {
    expect(formatTasks([], "table")).toBe("No tasks found.");
  });
});

describe("formatTask", () => {
  const task = { id: "t1", title: "Fix bug", status: "review", priority: "HIGH", branchName: "feat/fix", prUrl: "https://pr/1" };

  it("shows task details", () => {
    const out = formatTask(task, "table");
    expect(out).toContain("Fix bug");
    expect(out).toContain("feat/fix");
    expect(out).toContain("https://pr/1");
  });

  it("returns just ID in quiet mode", () => {
    expect(formatTask(task, "quiet")).toBe("t1");
  });
});

describe("formatSignals", () => {
  const signals = [
    { id: "s1", type: "review_needed", taskId: "t1", projectId: "p1", context: { taskTitle: "Fix bug" }, acknowledgedAt: null, createdAt: "2026-04-06T12:00:00Z" },
  ];

  it("formats signal list", () => {
    const out = formatSignals(signals, "table");
    expect(out).toContain("review_needed");
    expect(out).toContain("Fix bug");
  });

  it("shows message for empty list", () => {
    expect(formatSignals([], "table")).toBe("No signals.");
  });

  it("formats as JSON", () => {
    const out = formatSignals(signals, "json");
    expect(JSON.parse(out)).toHaveLength(1);
  });
});

describe("formatProjects", () => {
  const projects = [
    { id: "p1-id", name: "Project One", slug: "project-one", githubRepo: "acme/one" },
    { id: "p2-id", name: "Project Two", slug: "project-two", githubRepo: null },
  ];

  it("formats as table with slug + repo + name", () => {
    const out = formatProjects(projects, "table");
    expect(out).toContain("project-one");
    expect(out).toContain("acme/one");
    expect(out).toContain("Project Two");
    expect(out).toContain("SLUG");
  });

  it("formats as JSON", () => {
    const parsed = JSON.parse(formatProjects(projects, "json"));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].slug).toBe("project-one");
  });

  it("quiet mode returns slugs, one per line", () => {
    expect(formatProjects(projects, "quiet")).toBe("project-one\nproject-two");
  });

  it("shows message for empty list", () => {
    expect(formatProjects([], "table")).toBe("No projects found.");
  });
});

describe("formatPickup", () => {
  const project = { id: "p1", name: "P", slug: "p" };

  it("renders idle", () => {
    const out = formatPickup({ kind: "idle" }, "table");
    expect(out).toContain("Idle");
  });

  it("renders work pickup with task + project", () => {
    const out = formatPickup(
      {
        kind: "work",
        task: { id: "t1", title: "Do thing", status: "open", priority: "MEDIUM" },
        project,
      },
      "table",
    );
    expect(out).toContain("[work]");
    expect(out).toContain("Do thing");
    expect(out).toContain("p");
  });

  it("renders signal pickup with type + title from context", () => {
    const out = formatPickup(
      {
        kind: "signal",
        signal: {
          id: "s1",
          type: "review_needed",
          taskId: "t1",
          projectId: "p1",
          context: { taskTitle: "Review me" },
          acknowledgedAt: null,
          createdAt: "2026-04-27T00:00:00Z",
        },
      },
      "table",
    );
    expect(out).toContain("[signal]");
    expect(out).toContain("review_needed");
    expect(out).toContain("Review me");
  });

  it("quiet returns task id for work/review, signal id for signal, empty for idle", () => {
    expect(
      formatPickup(
        {
          kind: "work",
          task: { id: "t1", title: "x", status: "open", priority: "LOW" },
          project,
        },
        "quiet",
      ),
    ).toBe("t1");
    expect(
      formatPickup(
        {
          kind: "signal",
          signal: {
            id: "s1",
            type: "x",
            taskId: "t1",
            projectId: "p1",
            context: {},
            acknowledgedAt: null,
            createdAt: "2026-04-27T00:00:00Z",
          },
        },
        "quiet",
      ),
    ).toBe("s1");
    expect(formatPickup({ kind: "idle" }, "quiet")).toBe("");
  });

  it("json round-trips", () => {
    const result = { kind: "idle" } as const;
    expect(JSON.parse(formatPickup(result, "json"))).toEqual(result);
  });
});

describe("formatStart", () => {
  const result = {
    kind: "work" as const,
    task: { id: "t1", title: "Hello", status: "in_progress", priority: "HIGH" },
    project: { id: "p1", name: "P", slug: "proj" },
    expectedFinishState: "review",
  };

  it("shows kind, task id, project, and expectedFinishState", () => {
    const out = formatStart(result, "table");
    expect(out).toContain("Started work on t1");
    expect(out).toContain("Hello");
    expect(out).toContain("proj");
    expect(out).toContain("expectedFinishState: review");
  });

  it("quiet returns task id", () => {
    expect(formatStart(result, "quiet")).toBe("t1");
  });

  it("json includes the full payload", () => {
    expect(JSON.parse(formatStart(result, "json"))).toEqual(result);
  });
});

describe("formatGates", () => {
  const gates = [
    {
      code: "branch_present",
      name: "Branch present",
      active: true,
      because: "PR submission required",
      appliesTo: ["task_finish"],
    },
    {
      code: "distinct_reviewer",
      name: "Distinct reviewer",
      active: false,
      because: "soloMode disables this gate",
      appliesTo: ["task_finish"],
    },
  ];

  it("renders header + ✓/· markers", () => {
    const out = formatGates(gates, "table");
    expect(out).toContain("ACTIVE");
    expect(out).toContain("branch_present");
    expect(out).toContain("✓");
    expect(out).toContain("·");
  });

  it("quiet returns only active gate codes", () => {
    expect(formatGates(gates, "quiet")).toBe("branch_present");
  });

  it("empty list shows message", () => {
    expect(formatGates([], "table")).toBe("No gates configured.");
  });
});

describe("formatProject", () => {
  const project = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Project One",
    slug: "project-one",
    description: "Does a thing",
    githubRepo: "acme/one",
  };

  it("shows id, slug, name, and optional fields when set", () => {
    const out = formatProject(project, "table");
    expect(out).toContain("Project One");
    expect(out).toContain("project-one");
    expect(out).toContain("acme/one");
    expect(out).toContain("Does a thing");
  });

  it("omits optional fields when not set", () => {
    const minimal = {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Lean",
      slug: "lean",
    };
    const out = formatProject(minimal, "table");
    expect(out).not.toContain("GitHub repo");
    expect(out).not.toContain("Description");
  });

  it("quiet mode returns just the ID", () => {
    expect(formatProject(project, "quiet")).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("formats as JSON", () => {
    const parsed = JSON.parse(formatProject(project, "json"));
    expect(parsed.slug).toBe("project-one");
  });
});
