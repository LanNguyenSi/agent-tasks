/** @vitest-environment jsdom */
/**
 * TaskDetail Agent Template badge: keystone-violation branch (task 6a7f696d,
 * follow-up to the c271feb9 review finding).
 *
 * `resolveConfidenceWarning` is unit-tested as a pure function, but the
 * wiring in TaskDetail (passing `conf.blocking` and `enforcementMode`, and
 * choosing the "Keystone violation:" text when the score clears the
 * threshold) needs a rendered test, or a wiring mutant would survive.
 * The threshold is 0 so the score always clears it; only `blocking` decides
 * whether the keystone text shows.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("../../src/lib/api", () => ({
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  claimTask: vi.fn(),
  releaseTask: vi.fn(),
  startTask: vi.fn(),
  createComment: vi.fn(),
  deleteComment: vi.fn(),
  addDependency: vi.fn(),
  removeDependency: vi.fn(),
  reviewTask: vi.fn(),
  transitionTask: vi.fn(),
}));

import TaskDetail from "../../src/components/TaskDetail";
import type { Task } from "../../src/lib/api";
import { calculateConfidence } from "../../src/lib/confidence";

afterEach(cleanup);

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Untitled",
    description: null,
    status: "open",
    priority: "MEDIUM",
    templateData: null,
    claimedByUserId: null,
    claimedByAgentId: null,
    claimedAt: null,
    dueAt: null,
    branchName: null,
    prUrl: null,
    prNumber: null,
    result: null,
    externalRef: null,
    labels: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    attachments: [],
    artifacts: [],
    comments: [],
    blockedBy: [],
    blocks: [],
    ...over,
  };
}

// templateFields must be a truthy object to render the "Agent Template"
// section; description/templateData are both empty above so the score is
// 0 and always below the threshold used in these tests.
const TEMPLATE_FIELDS = {};

const baseProps = {
  tasks: [] as Task[],
  user: null,
  templateFields: TEMPLATE_FIELDS,
  enforcementMode: null,
  onUpdate: () => {},
  onDelete: () => {},
  onClose: () => {},
  onError: () => {},
};


// Empty task: no acceptance criteria and no verification path, so the AC
// keystone is violated (blocking). The verifiable task below clears it.
const KEYSTONE_VIOLATING = () => makeTask({ title: "Untitled" });
const KEYSTONE_CLEAN = () =>
  makeTask({
    title: "Fix the off-by-one in pagination",
    description: "Update `getPage()` in api.ts so the last page is included.",
    templateData: {
      acceptanceCriteria: "- page N returns the final row\n- a vitest covers it",
    },
  });

// Guard the fixtures themselves: a drifting scorer must fail here, not make
// the render assertions below vacuous.
function scoreOf(task: Task) {
  return calculateConfidence({
    title: task.title,
    description: task.description,
    templateData: task.templateData,
    templateFields: TEMPLATE_FIELDS,
  });
}

describe("TaskDetail: keystone-violation badge branch", () => {
  it("fixtures: violating task is blocking, clean task is not, both score >= threshold 0", () => {
    expect(scoreOf(KEYSTONE_VIOLATING()).blocking).toBe(true);
    expect(scoreOf(KEYSTONE_CLEAN()).blocking).toBe(false);
    expect(scoreOf(KEYSTONE_VIOLATING()).score).toBeGreaterThanOrEqual(0);
    expect(scoreOf(KEYSTONE_CLEAN()).score).toBeGreaterThanOrEqual(0);
  });

  it("BLOCK: shows the keystone text with the blocking wording", () => {
    render(
      <TaskDetail
        task={KEYSTONE_VIOLATING()}
        {...baseProps}
        confidenceThreshold={0}
        enforcementMode="BLOCK"
      />,
    );

    expect(screen.getByText(/Keystone violation:/)).toBeInTheDocument();
    expect(screen.getByText(/agents cannot claim this task/)).toBeInTheDocument();
    expect(screen.queryByText(/Below threshold/)).toBeNull();
    expect(screen.queryByText(/advisory in this project/)).toBeNull();
  });

  it("WARN: shows the keystone text with the advisory wording", () => {
    render(
      <TaskDetail
        task={KEYSTONE_VIOLATING()}
        {...baseProps}
        confidenceThreshold={0}
        enforcementMode="WARN"
      />,
    );

    expect(screen.getByText(/Keystone violation:/)).toBeInTheDocument();
    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/Below threshold/)).toBeNull();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });

  it("OFF: shows no warning at all (resolveConfidenceWarning suppresses the keystone signal when the mode is OFF and the score clears the threshold)", () => {
    render(
      <TaskDetail
        task={KEYSTONE_VIOLATING()}
        {...baseProps}
        confidenceThreshold={0}
        enforcementMode="OFF"
      />,
    );

    expect(screen.queryByText(/Keystone violation:/)).toBeNull();
    expect(screen.queryByText(/Below threshold/)).toBeNull();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
    expect(screen.queryByText(/advisory in this project/)).toBeNull();
  });

  it.each(["BLOCK", "WARN", "OFF"] as const)(
    "control, %s: score >= threshold and no keystone violation renders no warning",
    (mode) => {
      render(
        <TaskDetail
          task={KEYSTONE_CLEAN()}
          {...baseProps}
          confidenceThreshold={0}
          enforcementMode={mode}
        />,
      );

      expect(screen.queryByText(/Keystone violation:/)).toBeNull();
      expect(screen.queryByText(/Below threshold/)).toBeNull();
      expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
      expect(screen.queryByText(/advisory in this project/)).toBeNull();
    },
  );
});
