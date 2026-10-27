/** @vitest-environment jsdom */
/**
 * Pages that used to leave the page frame while loading or redirecting:
 *   - /projects/workflow (legacy redirect) renders its missing-id and
 *     redirecting states inside PageShell's default column;
 *   - /settings and /settings/team render the real band and column while the
 *     data loads (no viewport-centred spinner), so the title does not move;
 *   - the project settings page measure is a class, not an inline style.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { Project, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useParams: () => ({ id: "proj-1" }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getAgentTokens: vi.fn(),
  getAvailableScopes: vi.fn(),
  getGithubTokenHealth: vi.fn(),
  updateDelegationSettings: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("../../src/lib/teamSwitch", () => ({
  useCurrentTeam: () => ({ team: null, teams: [], setTeam: vi.fn() }),
  // /settings resolves the team its team-settings link carries; the loading
  // frame renders before any list answer exists.
  useResolvedTeam: () => null,
}));

import WorkflowRedirectPage from "../../src/app/projects/workflow/page";
import SettingsPageRaw from "../../src/app/settings/page";
import { withTeamList } from "./helpers/withTeamList";
const SettingsPage = withTeamList(SettingsPageRaw);
import TeamSettingsPageRaw from "../../src/app/settings/team/page";
const TeamSettingsPage = withTeamList(TeamSettingsPageRaw);
import ProjectSettingsPage from "../../src/app/projects/[id]/settings/page";
import { getCurrentUser, getTeams, getProject } from "../../src/lib/api";

class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverStub;

const pending = <T,>() => new Promise<T>(() => {});

function setSearch(search: string) {
  window.history.replaceState({}, "", `/projects/workflow${search}`);
}

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset();
  vi.mocked(getTeams).mockReset();
  // The shell list under the provider stays pending in every frame here
  // (tests that need an answer set their own).
  vi.mocked(getTeams).mockReturnValue(pending<Awaited<ReturnType<typeof getTeams>>>());
  vi.mocked(getProject).mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("/projects/workflow redirect page", () => {
  it("missing id: EmptyState inside the default PageShell column", async () => {
    setSearch("");
    render(<WorkflowRedirectPage />);
    const heading = await screen.findByText("Missing project ID");
    const main = screen.getByRole("main");
    expect(main).toHaveClass("pshell", "pshell--default");
    expect(main.querySelector(":scope > .pshell-content")).toContainElement(heading);
    expect(document.querySelector(".wf-redirect-shell")).toBeNull();
    expect(document.querySelectorAll("main")).toHaveLength(1);
  });

  it("redirecting: busy PageShell with the status skeleton, then replace()", async () => {
    setSearch("?projectId=p1");
    render(<WorkflowRedirectPage />);
    const main = screen.getByRole("main");
    expect(main).toHaveClass("pshell", "pshell--default");
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Redirecting to workflow editor");
    expect(document.querySelector(".wf-redirect-shell")).toBeNull();
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/projects/p1/workflow"));
  });

  it("blank projectId counts as missing", async () => {
    setSearch("?projectId=%20");
    render(<WorkflowRedirectPage />);
    await screen.findByText("Missing project ID");
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});

describe("settings loading frame", () => {
  it("/settings: the Settings band and a busy default column while loading", () => {
    vi.mocked(getCurrentUser).mockReturnValue(pending<User>());
    render(<SettingsPage />);
    const main = screen.getByRole("main");
    expect(main).toHaveClass("pshell", "pshell--default");
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings");
    expect(main.querySelector(":scope > .pshell-content [role=status]")).not.toBeNull();
    expect(main).not.toHaveClass("full-page-loader");
    expect(document.querySelector(".full-page-loader")).toBeNull();
  });

  it("/settings/team: the band with its breadcrumb and a busy default column while loading", () => {
    vi.mocked(getCurrentUser).mockReturnValue(pending<User>());
    vi.mocked(getTeams).mockReturnValue(pending());
    render(<TeamSettingsPage />);
    const main = screen.getByRole("main");
    expect(main).toHaveClass("pshell", "pshell--default");
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Team settings");
    expect(main.querySelector(".settings-breadcrumb")).toHaveTextContent("Settings");
    expect(main.querySelector(":scope > .pshell-content [role=status]")).not.toBeNull();
    expect(document.querySelector(".full-page-loader")).toBeNull();
  });
});

describe("project settings measure", () => {
  const project = {
    id: "proj-1",
    teamId: "team-1",
    name: "agent-tasks",
    slug: "s",
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
    allowNonCreatorRespec: false,
    createdAt: "2026-03-05T12:00:00",
  } as unknown as Project;

  it("loading and loaded states use the class, no inline max-width", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u" } as User);
    vi.mocked(getProject).mockResolvedValue(project);
    const { container } = render(<ProjectSettingsPage />);
    const loading = screen.getByRole("status");
    expect(loading).toHaveClass("proj-settings-measure");
    expect(loading.getAttribute("style")).toBeNull();
    await screen.findByText("General");
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("proj-settings-measure");
    expect(root.style.maxWidth).toBe("");
  });
});
