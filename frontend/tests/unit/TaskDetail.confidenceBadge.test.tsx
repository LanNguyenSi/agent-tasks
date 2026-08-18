/** @vitest-environment jsdom */
/**
 * TaskDetail Agent Template badge — effective (per-task-type) threshold,
 * not the flat project threshold (task f186b88b).
 *
 * Before this fix, the badge compared the client-side score against the
 * `confidenceThreshold` PROP only — the project's flat value. A project
 * with a per-task-type override (e.g. `taskTypeThresholds: { security: 90 }`)
 * therefore showed a task as above-threshold in the UI while the real
 * `/tasks/:id/start` claim gate — which resolves the SAME layered hierarchy
 * via resolveEffectiveThreshold — would 422 it. This is affirmatively wrong
 * in the permissive direction: the UI told an operator/agent a task was
 * claimable when it was not.
 *
 * The fixture task below scores 75 (measured against the real scorer, see
 * the description/templateData below) — comfortably ABOVE a flat threshold
 * of 60 but BELOW a security-type override of 90, so it only exercises the
 * bug if the badge is threshold-effective-aware.
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

const SECURITY_DESCRIPTION = [
  "Harden the auth token rotation endpoint against replay attacks.",
  "",
  "The rotation handler in backend/src/routes/auth-token.ts issues a new",
  "refresh token on every call without invalidating the previous one,",
  "so a captured old token stays valid for its full TTL after rotation.",
  "",
  "- Verify the fix with `npm test -- auth-token.rotation`",
  "- Check the audit log records a `token.rotated` event with the old",
  "  token id",
].join("\n");

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Harden token rotation against replay",
    description: SECURITY_DESCRIPTION,
    status: "open",
    priority: "MEDIUM",
    templateData: {
      goal: "Invalidate the previous refresh token on every rotation.",
      scope: "backend/src/routes/auth-token.ts rotation handler only.",
      taskType: "security",
    },
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
// section at all — an empty-but-present TemplateFields object is enough.
const TEMPLATE_FIELDS = {};

const baseProps = {
  tasks: [] as Task[],
  user: null,
  templateFields: TEMPLATE_FIELDS,
  onUpdate: () => {},
  onDelete: () => {},
  onClose: () => {},
  onError: () => {},
};

describe("TaskDetail — Agent Template badge uses the EFFECTIVE (per-task-type) threshold", () => {
  it("security-type task scoring 75: below the type override (90), even though it clears the flat project threshold (60)", () => {
    render(
      <TaskDetail
        task={makeTask()}
        {...baseProps}
        confidenceThreshold={60}
        taskTypeThresholds={{ security: 90 }}
      />,
    );

    // The bug this pins: comparing against the flat 60 would show NO warning
    // (75 >= 60) and hide the fact that /start would 422 this task.
    expect(screen.getByText(/Below threshold \(90\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Below threshold \(60\)/)).toBeNull();
  });

  it("same task, no taskTypeThresholds override on the project: falls through to the flat threshold (60), no warning at score 75", () => {
    render(
      <TaskDetail
        task={makeTask()}
        {...baseProps}
        confidenceThreshold={60}
        taskTypeThresholds={null}
      />,
    );

    expect(screen.queryByText(/Below threshold/)).toBeNull();
  });

  it("untyped task (no templateData.taskType): a security override never applies, badge uses the flat threshold", () => {
    render(
      <TaskDetail
        task={makeTask({
          templateData: {
            goal: "Invalidate the previous refresh token on every rotation.",
            scope: "backend/src/routes/auth-token.ts rotation handler only.",
          },
        })}
        {...baseProps}
        confidenceThreshold={60}
        taskTypeThresholds={{ security: 90 }}
      />,
    );

    // Untyped task: same 75-ish score clears the flat 60, and the security
    // override cannot apply because there is no explicit taskType to key on.
    expect(screen.queryByText(/Below threshold/)).toBeNull();
  });
});
