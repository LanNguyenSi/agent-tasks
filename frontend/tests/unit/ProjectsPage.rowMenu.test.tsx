/** @vitest-environment jsdom */
/**
 * /projects Table view: the row "..." menu (ProjectRowActions) inside a
 * Table row that links to the project's board (rowHref).
 *
 * The menu panel is portaled to document.body, but React bubbles its events
 * through the portal to the row. The row ignores events from outside its own
 * DOM (ui/Table), so:
 *   - Enter or Space on "Delete project" opens the delete confirmation and
 *     does not navigate to the board; so does a mouse click;
 *   - Enter on "Workflow" goes to the project's workflow page, not the board;
 *   - a click on the "Managed by GitHub sync" note does not navigate.
 * A click on the row itself still opens the board (control).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { waitForCall } from "./helpers/waitForCall";
import userEvent from "@testing-library/user-event";
import type { Project, Team, User } from "../../src/lib/api";

vi.mock("next/navigation", async () => {
  const m = await import("../setup/fakeNavigation");
  return { usePathname: m.usePathname, useRouter: m.useRouter, useSearchParams: m.useSearchParams };
});
// A link click is a router.push (fake router), which is how these tests see
// a navigation.
vi.mock("next/link", async () => ({
  default: (await import("../setup/fakeNavigation")).FakeLink,
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  getTasks: vi.fn(),
  getWorkflows: vi.fn().mockResolvedValue([]),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  syncTeamFromGitHub: vi.fn(),
  logout: vi.fn(),
}));

import ProjectsPageRaw from "../../src/app/projects/page";
import { withTeamList } from "./helpers/withTeamList";
const ProjectsPage = withTeamList(ProjectsPageRaw);
import { nav, router } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getProjects, getTasks } from "../../src/lib/api";

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
  id: "t1",
  name: "Team One",
  slug: "team-one",
  role: "ADMIN",
  createdAt: "2026-01-01T00:00:00Z",
};

const MANUAL: Project = {
  id: "proj-1",
  teamId: "t1",
  name: "Manual Project",
  slug: "manual-project",
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
  createdAt: "2026-01-01T00:00:00Z",
};

const SYNCED: Project = {
  ...MANUAL,
  id: "proj-2",
  name: "Synced Project",
  slug: "synced-project",
  githubRepo: "example-org/synced",
};

beforeEach(() => {
  vi.clearAllMocks();
  nav.reset("/projects?teamId=t1");
  window.localStorage.clear();
  // An explicit Table choice, so the page renders the Table view (with few
  // projects the count-based default would be the cards).
  window.localStorage.setItem("agent-tasks:teams:viewMode", "table");
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
  vi.mocked(getTeams).mockResolvedValue([TEAM]);
  vi.mocked(getProjects).mockResolvedValue([MANUAL, SYNCED]);
  vi.mocked(getTasks).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Wait for the Table view, then return the row of `name`. */
async function tableRow(name: string): Promise<HTMLElement> {
  await screen.findByRole("table");
  const link = await screen.findByRole("link", { name });
  return link.closest("tr") as HTMLElement;
}

function trigger(name: string): HTMLElement {
  return screen.getByRole("button", { name: `Actions for ${name}` });
}

/** The open panel: DropdownMenu portals .app-dropdown-menu to document.body. */
async function menuPanel(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(".app-dropdown-menu")).not.toBeNull());
  return document.querySelector(".app-dropdown-menu") as HTMLElement;
}

/** Open the row menu of `name` by keyboard; focus lands on its first item. */
async function openByKeyboard(name: string): Promise<HTMLElement> {
  await tableRow(name);
  trigger(name).focus();
  await userEvent.keyboard("{Enter}");
  const panel = await menuPanel();
  await waitFor(() =>
    expect(within(panel).getByRole("menuitem", { name: "Workflow" })).toHaveFocus(),
  );
  return panel;
}

async function expectNoBoardNavigation(): Promise<void> {
  await waitFor(() => {
    for (const [url] of [...router.push.mock.calls, ...router.replace.mock.calls]) {
      expect(url).not.toContain("/board");
    }
  });
}

describe("/projects Table view: row menu items run instead of opening the board", () => {
  beforeEach(() => {
    render(<ProjectsPage />);
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("%s on Delete project opens the confirmation and does not navigate", async (_label, key) => {
    const panel = await openByKeyboard("Manual Project");
    await userEvent.keyboard("{ArrowDown}");
    expect(within(panel).getByRole("menuitem", { name: "Delete project" })).toHaveFocus();
    await userEvent.keyboard(key);

    expect(await screen.findByRole("dialog", { name: "Delete project?" })).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
    expect(nav.url).toBe("/projects?teamId=t1");
  });

  it("a mouse click on Delete project opens the confirmation and does not navigate", async () => {
    await tableRow("Manual Project");
    await userEvent.click(trigger("Manual Project"));
    const panel = await menuPanel();
    await userEvent.click(within(panel).getByRole("menuitem", { name: "Delete project" }));

    expect(await screen.findByRole("dialog", { name: "Delete project?" })).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("Enter on Workflow goes to the project's workflow page, not the board", async () => {
    await openByKeyboard("Manual Project");
    await userEvent.keyboard("{Enter}");

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/projects/workflow?projectId=proj-1");
    await expectNoBoardNavigation();
  });

  it("a click on the Managed by GitHub sync note does not navigate", async () => {
    await tableRow("Synced Project");
    await userEvent.click(trigger("Synced Project"));
    const panel = await menuPanel();
    await userEvent.click(within(panel).getByText("Managed by GitHub sync"));

    expect(router.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Delete project?" })).not.toBeInTheDocument();
  });

  it("control: a click on the row itself opens the project's board", async () => {
    const tr = await tableRow("Manual Project");
    fireEvent.click(within(tr).getByText("Manual project"));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect((await waitForCall(router.push))[0]?.[0]).toContain("/projects/proj-1/board");
  });
});

/**
 * Menu semantics (same pattern as the /tasks row menu and AppHeader): the
 * trigger declares aria-haspopup="menu" and aria-expanded, the panel holds a
 * role="menu" named after the project with role="menuitem" items, and the
 * "Managed by GitHub sync" note is an aria-disabled menuitem the keyboard
 * reaches (focusable, never activated). Escape closes and returns focus to
 * the trigger.
 */
describe("/projects Table view: row menu semantics", () => {
  beforeEach(() => {
    render(<ProjectsPage />);
  });

  /** Open the row menu of `name` with the mouse; focus lands on the first item. */
  async function openMenu(name: string): Promise<HTMLElement> {
    await tableRow(name);
    await userEvent.click(trigger(name));
    const panel = await menuPanel();
    await waitFor(() =>
      expect(panel.querySelector(".app-dropdown-item")).toHaveFocus(),
    );
    return panel;
  }

  it("trigger declares a menu popup and follows the open state", async () => {
    await tableRow("Manual Project");
    const btn = trigger("Manual Project");
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("the panel is a menu named after the project and its items are menuitems", async () => {
    const panel = await openMenu("Manual Project");
    const menu = within(panel).getByRole("menu", { name: "Actions for Manual Project" });
    expect(within(menu).getByRole("menuitem", { name: "Workflow" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Delete project" })).toBeInTheDocument();
  });

  it("the GitHub-sync note is an aria-disabled menuitem the keyboard cycles through", async () => {
    const panel = await openMenu("Synced Project");
    const note = within(panel).getByRole("menuitem", { name: "Managed by GitHub sync" });
    expect(note).toHaveAttribute("aria-disabled", "true");
    // ArrowDown from the first item (Workflow) lands on the note; another
    // ArrowDown cycles back, so the note is in the panel's item cycle.
    await userEvent.keyboard("{ArrowDown}");
    expect(note).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(within(panel).getByRole("menuitem", { name: "Workflow" })).toHaveFocus();
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    await tableRow("Manual Project");
    const btn = trigger("Manual Project");
    btn.focus();
    await userEvent.keyboard("{Enter}");
    const panel = await menuPanel();
    await waitFor(() => expect(panel.querySelector(".app-dropdown-item")).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".app-dropdown-menu")).toBeNull());
    await waitFor(() => expect(btn).toHaveFocus());
  });
});
