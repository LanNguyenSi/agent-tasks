/** @vitest-environment jsdom */
/**
 * TaskDetail must thread isProjectAdmin into the attachments and artifacts
 * sections as canManageAll, so a project admin gets the delete affordance on
 * items they did not create. The sections implement canManageAll themselves
 * (covered in TaskAttachmentsSection.test.tsx); this file guards the WIRING,
 * which was missing (canManageAll silently defaulted to false for everyone).
 * The backend authorizes either way — this is affordance-only.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  adminReleaseClaim: vi.fn(),
  uploadTaskAttachmentFile: vi.fn(),
  deleteTaskAttachment: vi.fn(),
  listTaskArtifacts: vi.fn(),
  getTaskArtifact: vi.fn(),
  deleteTaskArtifact: vi.fn(),
  rawAttachmentUrl: (taskId: string, attId: string) =>
    `http://api.test/api/tasks/${taskId}/attachments/${attId}/raw`,
}));

import TaskDetail from "../../src/components/TaskDetail";
import type { Task, TaskAttachment, TaskArtifactMeta, User } from "../../src/lib/api";

afterEach(cleanup);

const VIEWER: User = {
  id: "user-1",
  login: "viewer",
  name: "Viewer",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
};

// Both items are created by user-2, NOT the viewer: without canManageAll the
// sections hide Delete for them.
const FOREIGN_ATTACHMENT: TaskAttachment = {
  id: "att-1",
  taskId: "task-1",
  name: "foreign.txt",
  url: "/uploads/foreign.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  type: "DOCUMENT",
  createdByUserId: "user-2",
  createdByUser: null,
  createdAt: "2026-08-01T00:00:00.000Z",
};

const FOREIGN_ARTIFACT: TaskArtifactMeta = {
  id: "art-1",
  taskId: "task-1",
  type: "build_log",
  name: "build.log",
  description: null,
  url: null,
  mimeType: "text/plain",
  sizeBytes: 0,
  createdByUserId: "user-2",
  createdByAgentId: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  createdByUser: { id: "user-2", login: "other", name: "Other", avatarUrl: null },
};

function makeTask(): Task {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Fix the thing",
    description: "Some description",
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
    attachments: [FOREIGN_ATTACHMENT],
    artifacts: [FOREIGN_ARTIFACT],
    comments: [],
    blockedBy: [],
    blocks: [],
  };
}

const baseProps = {
  tasks: [] as Task[],
  user: VIEWER,
  templateFields: null,
  confidenceThreshold: 60,
  onUpdate: () => {},
  onDelete: () => {},
  onClose: () => {},
  onError: () => {},
};

async function renderAndExpandSections(isProjectAdmin: boolean) {
  render(<TaskDetail task={makeTask()} {...baseProps} isProjectAdmin={isProjectAdmin} />);
  // Both sections render collapsed; expand them to reach the rows.
  await userEvent.click(screen.getByRole("button", { name: /Attachments/ }));
  await userEvent.click(screen.getByRole("button", { name: /Artifacts/ }));
}

describe("TaskDetail — admin delete affordance wiring", () => {
  it("project admin sees Delete on a foreign attachment and a foreign artifact", async () => {
    await renderAndExpandSections(true);
    // Attachment delete carries a per-item aria-label; the two-step confirm
    // itself is covered by the section's own tests.
    expect(screen.getByRole("button", { name: "Delete foreign.txt" })).toBeInTheDocument();
    // Artifact delete is the bare InlineConfirmDelete with visible text.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("non-admin sees no Delete on either foreign item", async () => {
    await renderAndExpandSections(false);
    expect(screen.queryByRole("button", { name: "Delete foreign.txt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});
