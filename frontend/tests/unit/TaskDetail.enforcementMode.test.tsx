/** @vitest-environment jsdom */
/**
 * TaskDetail Agent Template badge — enforcement-mode-aware below-threshold
 * copy (task a9dc7e58, follow-up to f186b88b review finding R1).
 *
 * Before this fix the badge always said "agents cannot claim this task"
 * once the score fell below the effective threshold, regardless of the
 * project's `enforcementMode`. That's only true when the project is in
 * `BLOCK` mode — a `WARN` or `OFF` project never actually blocks the claim
 * server-side (see backend lib/enforcement-mode.ts), so the old copy was
 * restrictive-false: harmless (nothing was actually blocked), but
 * misleading to whoever read the badge.
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

describe("TaskDetail — Agent Template badge copy branches on the project's enforcementMode", () => {
  it("BLOCK: keeps the blocking wording", () => {
    render(
      <TaskDetail
        task={makeTask()}
        {...baseProps}
        confidenceThreshold={60}
        enforcementMode="BLOCK"
      />,
    );

    expect(screen.getByText(/agents cannot claim this task/)).toBeInTheDocument();
    expect(screen.queryByText(/advisory in this project/)).toBeNull();
  });

  it("WARN: uses advisory wording, not the blocking claim", () => {
    render(
      <TaskDetail
        task={makeTask()}
        {...baseProps}
        confidenceThreshold={60}
        enforcementMode="WARN"
      />,
    );

    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });

  it("OFF: still surfaces the score with advisory wording (the mode still computes + surfaces, it just never blocks) rather than hiding the badge", () => {
    render(
      <TaskDetail
        task={makeTask()}
        {...baseProps}
        confidenceThreshold={60}
        enforcementMode="OFF"
      />,
    );

    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });

  it("missing/undefined enforcementMode (older cached project data): defaults to advisory wording, matching the backend's own WARN default for an unset mode", () => {
    render(
      <TaskDetail
        task={makeTask()}
        {...baseProps}
        confidenceThreshold={60}
        // enforcementMode intentionally omitted
      />,
    );

    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });

  it("null enforcementMode (row predates the column): same advisory default as undefined", () => {
    render(
      <TaskDetail
        task={makeTask()}
        {...baseProps}
        confidenceThreshold={60}
        enforcementMode={null}
      />,
    );

    expect(screen.getByText(/advisory in this project/)).toBeInTheDocument();
    expect(screen.queryByText(/agents cannot claim this task/)).toBeNull();
  });
});
