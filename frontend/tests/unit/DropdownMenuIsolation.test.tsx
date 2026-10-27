/** @vitest-environment jsdom */
/**
 * ui/DropdownMenu: while a menu is open it isolates keydown from the page,
 * for every caller (the account menu here, and by construction the team
 * menu, the project picker and the /tasks row menus -- the panel does it,
 * not the call sites).
 *
 * The /tasks page listens for "/" and "C" on window; the panel is portaled
 * to document.body but React events bubble through the portal, and the panel
 * stops the event before it can reach the window listeners. Method: a
 * bubble-phase window listener registered after the page mounts sees exactly
 * what the page's own window shortcut listener would see (the page's handler
 * runs first and default-prevents the key when it acts).
 *
 * What must NOT break: Escape still closes the menu (usePopover handles it on
 * document in capture phase, before the panel sees anything) and returns
 * focus to the trigger; the arrow keys still cycle the items; with the menu
 * closed, the page shortcuts still fire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Team, User } from "../../src/lib/api";

vi.mock("next/navigation", async () => {
  const m = await import("../setup/fakeNavigation");
  return { usePathname: m.usePathname, useRouter: m.useRouter, useSearchParams: m.useSearchParams };
});
vi.mock("next/link", async () => ({
  default: (await import("../setup/fakeNavigation")).FakeLink,
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
  updateTask: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../../src/components/tasks/NewTaskFlow", () => ({ default: () => null }));

import AppHeader from "../../src/components/AppHeader";
import TasksPageRaw from "../../src/app/tasks/page";
import { withTeamList } from "./helpers/withTeamList";
import { nav } from "../setup/fakeNavigation";
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

/** Keys a bubble-phase window listener sees, with the page shortcut's
 *  preventDefault marker (the page's listener was registered first). */
let seen: { key: string; prevented: boolean }[];

function recordKey(e: KeyboardEvent): void {
  seen.push({ key: e.key, prevented: e.defaultPrevented });
}

/** Open the account menu and wait for its first item to hold focus. */
async function openAccountMenu(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Account menu for lan" }));
  await waitFor(() =>
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus(),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  nav.reset("/tasks");
  window.localStorage.clear();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockGetTeams.mockResolvedValue([TEAM]);
  mockGetTeamTasks.mockResolvedValue({
    tasks: [],
    projects: [],
    counts: { open: 0, review: 0, done: 0, priority: 0, mine: 0, total: 0 },
    filteredTotal: 0,
  } as never);
  render(
    <>
      <AppHeader user={{ login: USER.login }} teams={[TEAM]} />
      <TasksPage />
    </>,
  );
  // Wait for the loaded state: page shortcuts only act once teamDataReady.
  await screen.findByRole("button", { name: /New task/ });
  seen = [];
  window.addEventListener("keydown", recordKey);
});

afterEach(() => {
  window.removeEventListener("keydown", recordKey);
  cleanup();
  window.localStorage.clear();
});

describe("DropdownMenu isolates page shortcuts while open", () => {
  it("with the account menu open, C does not reach the page shortcut", async () => {
    await openAccountMenu();
    await userEvent.keyboard("c");
    expect(seen.some((e) => e.key === "c" || e.key === "C")).toBe(false);
  });

  it("with the account menu open, / does not reach the page shortcut", async () => {
    await openAccountMenu();
    await userEvent.keyboard("/");
    expect(seen.some((e) => e.key === "/")).toBe(false);
  });

  it("Escape still closes the menu and returns focus to the trigger", async () => {
    await openAccountMenu();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".app-dropdown-menu")).toBeNull());
    expect(screen.getByRole("button", { name: "Account menu for lan" })).toHaveFocus();
  });

  it("arrow keys still move focus between the items", async () => {
    await openAccountMenu();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Team settings" })).toHaveFocus();
  });

  // Split in two: the page ignores all shortcuts while the create flow is
  // open, so pressing "/" after a working "C" would test the wrong state.
  it("with the menu closed, C reaches the page shortcut (the listener acts on it)", async () => {
    await userEvent.keyboard("c");
    await waitFor(() =>
      expect(seen.some((e) => (e.key === "c" || e.key === "C") && e.prevented)).toBe(true),
    );
  });

  it("with the menu closed, / reaches the page shortcut and focuses the search input", async () => {
    await userEvent.keyboard("/");
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector(".db-search-input")),
    );
  });
});
