/** @vitest-environment jsdom */
/**
 * /onboarding for each {teams 0/1, shared projects 0/1} combination.
 *
 * Only a user WITH a team is redirected (to /home). A user without teams is
 * never redirected, so /home and /onboarding cannot bounce each other:
 * without shared projects the form is shown alone; with shared projects the
 * form stays (team creation is optional but reachable) plus a "Skip for now"
 * link to /home; when the shared lookup fails the form stays plus a hint with
 * a Retry button (covered in the "shared-lookup hint" block below).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { Project, Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getProjects: vi.fn(),
  createTeam: vi.fn(),
  logout: vi.fn(),
}));

import OnboardingPage from "../../src/app/onboarding/page";
import { createTeam, getCurrentUser, getProjects, getTeams } from "../../src/lib/api";
import { act, fireEvent } from "@testing-library/react";

const USER = { id: "u-1", login: "lan", name: "Lan", avatarUrl: null } as User;
const TEAM = { id: "t1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "x" } as Team;
const SHARED = { id: "p3", name: "Shared Project" } as Project;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function setAccess(teams: Team[], shared: Project[]) {
  vi.mocked(getTeams).mockResolvedValue(teams);
  vi.mocked(getProjects).mockResolvedValue(shared);
}

describe("/onboarding", () => {
  it("no teams, no shared projects: the create-team form, no skip link, no redirect", async () => {
    setAccess([], []);
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    expect(screen.queryByRole("link", { name: "Skip for now" })).toBeNull();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("no teams, shared projects: the form stays and a Skip for now link points to /home", async () => {
    setAccess([], [SHARED]);
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    const skip = screen.getByRole("link", { name: "Skip for now" });
    expect(skip.getAttribute("href")).toBe("/home");
    expect(screen.getByRole("button", { name: "Create team" })).toBeInTheDocument();
    // The user is not bounced back to /home: that would loop with /home's own check.
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("no teams, shared lookup fails: hint with Retry, form without a skip link, no redirect", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockRejectedValue(new Error("projects unavailable"));
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    expect(screen.getByText(/couldn't check for projects shared with you/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Skip for now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create team" })).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a team, no shared projects", shared: [] as Project[] },
    { name: "a team and shared projects", shared: [SHARED] },
  ])("$name: redirects to /home carrying the current team, without showing the form", async ({ shared }) => {
    setAccess([TEAM], shared);
    render(<OnboardingPage />);
    // The only team is the current one (no remembered team stored): the
    // redirect already names it, so /home opens it and writes no URL.
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home?teamId=t1"));
    expect(screen.queryByLabelText("Team name")).toBeNull();
    expect(screen.queryByRole("link", { name: "Skip for now" })).toBeNull();
  });

  it("redirect carries the remembered team, not the first team (precedence)", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    setAccess([TEAM, { ...TEAM, id: "t2", name: "Beta" }], []);
    render(<OnboardingPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home?teamId=t2"));
  });

  it("a remembered team the list lacks falls through: redirect carries the first team", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t-gone");
    setAccess([TEAM], []);
    render(<OnboardingPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home?teamId=t1"));
  });

  it("a signed-out visitor goes to /auth", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    render(<OnboardingPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/auth"));
    expect(getTeams).not.toHaveBeenCalled();
  });
});

describe("/onboarding shared-lookup hint", () => {
  it.each([
    { label: "with shared projects", shared: [SHARED] as Project[] },
    { label: "without shared projects", shared: [] as Project[] },
  ])("lookup succeeds $label: no hint, no Retry", async ({ shared }) => {
    setAccess([], shared);
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    expect(screen.queryByText(/couldn't check for projects shared with you/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("retry succeeds with projects: hint goes away, Skip for now appears", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects)
      .mockRejectedValueOnce(new Error("projects unavailable"))
      .mockResolvedValueOnce([SHARED]);
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("link", { name: "Skip for now" });
    expect(screen.queryByText(/couldn't check for projects shared with you/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("retry succeeds without projects: hint goes away, no skip link", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects)
      .mockRejectedValueOnce(new Error("projects unavailable"))
      .mockResolvedValueOnce([]);
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText(/couldn't check for projects shared with you/i)).toBeNull(),
    );
    expect(screen.queryByRole("link", { name: "Skip for now" })).toBeNull();
  });

  it("retry fails again: the hint stays, shown once, Retry usable again", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects)
      .mockRejectedValueOnce(new Error("projects unavailable"))
      .mockRejectedValueOnce(new Error("still unavailable"));
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    expect(screen.getAllByText(/couldn't check for projects shared with you/i)).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Skip for now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create team" })).toBeInTheDocument();
  });

  it("while the retry is in flight the button is busy and disabled", async () => {
    let settle: (projects: Project[]) => void = () => {};
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects)
      .mockRejectedValueOnce(new Error("projects unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise<Project[]>((resolve) => {
            settle = resolve;
          }),
      );
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const busy = await screen.findByRole("button", { name: /retry/i });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    act(() => settle([SHARED]));
    await screen.findByRole("link", { name: "Skip for now" });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("/onboarding?create=team", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/onboarding?create=team");
  });

  it("a user with a team is redirected to /home carrying it, no form (the New team dialog replaced this entry)", async () => {
    setAccess([TEAM], [SHARED]);
    render(<OnboardingPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home?teamId=t1"));
    expect(screen.queryByLabelText("Team name")).toBeNull();
  });

  it("another create value makes no difference: a user with a team is redirected carrying it", async () => {
    window.history.replaceState(null, "", "/onboarding?create=other");
    setAccess([TEAM], []);
    render(<OnboardingPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home?teamId=t1"));
  });

  it("a user without a team still gets the first-team form", async () => {
    setAccess([], []);
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    expect(screen.getByRole("heading", { name: "Create your first team" })).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});

describe("/onboarding first-team form", () => {
  it("creating calls the API, remembers the team and opens its Home", async () => {
    setAccess([], []);
    vi.mocked(createTeam).mockResolvedValue({ ...TEAM, id: "t2", name: "Second", slug: "second" });
    render(<OnboardingPage />);
    fireEvent.change(await screen.findByLabelText("Team name"), { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home?teamId=t2"));
    expect(createTeam).toHaveBeenCalledWith({ name: "Second", slug: "second" });
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
  });
});
