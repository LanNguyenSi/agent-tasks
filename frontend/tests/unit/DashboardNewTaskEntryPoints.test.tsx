/** @vitest-environment jsdom */
/**
 * Dashboard page -- generic "New Task" entry points default to Backlog.
 *
 * Contract under test (2026-08-20 operator decision, supersedes D19):
 *   - the toolbar "+ New Task" button opens NewTaskModal with Backlog
 *     preselected;
 *   - the "C" keyboard shortcut does the same;
 *   - both route through the single shared DEFAULT_CREATE_STATUS constant
 *     (lib/status.ts), not a hardcoded "open".
 *
 * Full-page render (src/lib/api mocked wholesale via vi.mock, matching the
 * pattern in SettingsPage.tokenRename.test.tsx / NewTaskFlow.test.tsx):
 * the toolbar button and the "C" shortcut both live inline in
 * DashboardPage and drive its own `newTaskInitialStatus` state, so a
 * component-level test can't observe the actual wiring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User, Team, Project, Task } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getTeams: vi.fn(),
    getProjects: vi.fn(),
    getProject: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    getEffectiveWorkflow: vi.fn(),
  };
});

import DashboardPage from "../../src/app/dashboard/page";
import { ToastProvider } from "../../src/components/ui/Toast";
import {
  getCurrentUser,
  getTeams,
  getProjects,
  getProject,
  getTasks,
} from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetProjects = vi.mocked(getProjects);
const mockGetProject = vi.mocked(getProject);
const mockGetTasks = vi.mocked(getTasks);

const USER: User = {
  id: "u-1",
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: null,
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
};

const TEAM: Team = {
  id: "t-1",
  name: "Team Alpha",
  slug: "team-alpha",
  role: "ADMIN",
  createdAt: new Date(0).toISOString(),
};

const PROJECT: Project = {
  id: "p-1",
  teamId: "t-1",
  name: "Project One",
  slug: "project-one",
  description: null,
  githubRepo: null,
  githubSyncAt: null,
  taskTemplate: null,
  confidenceThreshold: 60,
  requireDistinctReviewer: false,
  soloMode: true,
  governanceMode: "AUTONOMOUS",
  notificationWebhookUrl: null,
  hasNotificationWebhookSecret: false,
  createdAt: new Date(0).toISOString(),
  accessRole: "ADMIN",
};

const TASKS: Task[] = [];

async function renderDashboardReady() {
  render(
    <ToastProvider>
      <DashboardPage />
    </ToastProvider>,
  );
  // Wait for bootstrap to finish and the toolbar's "+ New Task" button to
  // become enabled (gated on a selected project).
  await waitFor(() => expect(screen.getByRole("button", { name: /new task/i })).toBeEnabled());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([TEAM]);
  mockGetProjects.mockResolvedValue([PROJECT]);
  mockGetProject.mockResolvedValue(PROJECT);
  mockGetTasks.mockResolvedValue(TASKS);
  window.history.replaceState({}, "", "/dashboard");
  // jsdom does not implement scrollIntoView; the Select listbox calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("dashboard New Task entry points default to Backlog", () => {
  it("toolbar '+ New Task' opens the modal with Backlog preselected", async () => {
    await renderDashboardReady();
    await userEvent.click(screen.getByRole("button", { name: /new task/i }));

    const statusCombobox = await screen.findByRole("combobox", { name: "Status" });
    expect(statusCombobox).toHaveTextContent("Backlog");
  });

  it("the 'C' keyboard shortcut opens the modal with Backlog preselected", async () => {
    await renderDashboardReady();
    await userEvent.keyboard("c");

    const statusCombobox = await screen.findByRole("combobox", { name: "Status" });
    expect(statusCombobox).toHaveTextContent("Backlog");
  });
});
