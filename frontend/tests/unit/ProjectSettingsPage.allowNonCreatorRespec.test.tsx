/** @vitest-environment jsdom */
/**
 * Project settings page: the allowNonCreatorRespec toggle in the Governance
 * card.
 *
 * Full-page render with src/lib/api mocked (same pattern as
 * SettingsPage.tokenRename.test.tsx). Covers:
 *   - the checkbox reflects the loaded project value (true and false, and
 *     an omitted field reads as false);
 *   - toggling and saving sends the new value in the PATCH payload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project, User } from "../../src/lib/api";

// Stable object: the page's bootstrap effect depends on `[projectId, router]`.
const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useParams: () => ({ id: "proj-1" }),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
}));

import ProjectSettingsPage from "../../src/app/projects/[id]/settings/page";
import { getCurrentUser, getProject, updateProject } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetProject = vi.mocked(getProject);
const mockUpdateProject = vi.mocked(updateProject);

const LABEL = /allow agents to respec open tasks they did not create/i;

function makeUser(): User {
  return {
    id: "u-1",
    login: "lan",
    name: "Lan",
    avatarUrl: null,
    email: "lan@example.com",
    githubConnected: false,
    allowAgentPrCreate: false,
    allowAgentPrMerge: false,
    allowAgentPrComment: false,
  };
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    teamId: "team-1",
    name: "agent-tasks",
    slug: "agent-tasks",
    description: null,
    githubRepo: null,
    githubSyncAt: null,
    taskTemplate: null,
    confidenceThreshold: 60,
    requireDistinctReviewer: false,
    soloMode: false,
    governanceMode: "AWAITS_CONFIRMATION",
    notificationWebhookUrl: null,
    hasNotificationWebhookSecret: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  } as Project;
}

async function renderPage(project: Project) {
  mockGetProject.mockResolvedValue(project);
  render(<ProjectSettingsPage />);
  return (await screen.findByLabelText(LABEL)) as HTMLInputElement;
}

describe("ProjectSettingsPage allowNonCreatorRespec toggle", () => {
  beforeEach(() => {
    mockGetCurrentUser.mockResolvedValue(makeUser());
    mockUpdateProject.mockImplementation(async (_id, body) =>
      makeProject({ allowNonCreatorRespec: body.allowNonCreatorRespec }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("is checked when the project has the flag set", async () => {
    const box = await renderPage(makeProject({ allowNonCreatorRespec: true }));
    expect(box.checked).toBe(true);
  });

  it("is unchecked when the project has the flag cleared", async () => {
    const box = await renderPage(makeProject({ allowNonCreatorRespec: false }));
    expect(box.checked).toBe(false);
  });

  it("reads an omitted field as unchecked", async () => {
    const box = await renderPage(makeProject());
    expect(box.checked).toBe(false);
  });

  it("sends the toggled value on save", async () => {
    const user = userEvent.setup();
    const box = await renderPage(makeProject({ allowNonCreatorRespec: false }));
    await user.click(box);
    expect(box.checked).toBe(true);
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() => expect(mockUpdateProject).toHaveBeenCalledTimes(1));
    expect(mockUpdateProject).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({ allowNonCreatorRespec: true }),
    );
  });

  it("sends false when an enabled flag is switched off", async () => {
    const user = userEvent.setup();
    const box = await renderPage(makeProject({ allowNonCreatorRespec: true }));
    await user.click(box);
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() => expect(mockUpdateProject).toHaveBeenCalledTimes(1));
    expect(mockUpdateProject.mock.calls[0][1].allowNonCreatorRespec).toBe(false);
  });
});
