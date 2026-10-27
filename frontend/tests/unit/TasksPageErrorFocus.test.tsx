/** @vitest-environment jsdom */
/**
 * /tasks page -- keyboard focus when the list fails to load
 * (src/app/tasks/page.tsx).
 *
 * A failed load shows the "Failed to load tasks" banner (with its own Retry)
 * while the results region waits; dismissing the banner keeps the failed
 * outcome and swaps the region to a compact "Couldn't load tasks" message
 * with an inline Retry. Both affordances unmount the button that was focused
 * when they run, so the page moves focus deliberately (keyboard assertions
 * read document.activeElement):
 *   - dismissing the banner -> focus the inline Retry that takes its place;
 *   - either Retry           -> focus the results region, which stays mounted
 *     through the refetch it starts (banner or inline Retry alike).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import TasksPageRaw from "../../src/app/tasks/page";
import { withTeamList } from "./helpers/withTeamList";
const TasksPage = withTeamList(TasksPageRaw);
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetTeamTasks = vi.mocked(getTeamTasks);

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
const TEAM: Team = { id: "team-1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };

/** Render the page into its failed-load state and wait for the banner. */
async function renderLoadFailure(): Promise<void> {
  mockGetTeamTasks.mockRejectedValue(new Error("Backend is down"));
  render(<TasksPage />);
  expect(await screen.findByText("Failed to load tasks")).toBeInTheDocument();
}

/** The inline Retry of the region's "Couldn't load tasks" message. */
function inlineRetry(): HTMLElement {
  const message = document.querySelector(".tasks-load-failed");
  const button = message?.querySelector("button");
  if (!button) throw new Error("inline Retry is not rendered");
  return button as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([TEAM]);
});

afterEach(cleanup);

describe("/tasks failed load: focus when the error affordances unmount", () => {
  it("dismissing the banner focuses the inline Retry that replaces it", async () => {
    await renderLoadFailure();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText("Couldn't load tasks")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(inlineRetry()));
  });

  it("the banner's Retry focuses the results region it refetches into", async () => {
    await renderLoadFailure();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".tasks-table-region")));
  });

  it("the inline Retry focuses the results region it refetches into", async () => {
    await renderLoadFailure();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(document.activeElement).toBe(inlineRetry()));

    await userEvent.click(inlineRetry());

    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".tasks-table-region")));
  });
});
