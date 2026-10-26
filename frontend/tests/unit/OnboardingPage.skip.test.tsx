/** @vitest-environment jsdom */
/**
 * /onboarding for each {teams 0/1, shared projects 0/1} combination.
 *
 * Only a user WITH a team is redirected (to /home). A user without teams is
 * never redirected, so /home and /onboarding cannot bounce each other:
 * without shared projects the form is shown alone; with shared projects the
 * form stays (team creation is optional but reachable) plus a "Skip for now"
 * link to /home.
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
import { getCurrentUser, getProjects, getTeams } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan", name: "Lan", avatarUrl: null } as User;
const TEAM = { id: "t1", name: "Pandora", slug: "pandora", role: "ADMIN", createdAt: "x" } as Team;
const SHARED = { id: "p3", name: "Shared Project" } as Project;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(USER);
});
afterEach(cleanup);

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
    expect(screen.getByRole("button", { name: "Create Team" })).toBeInTheDocument();
    // The user is not bounced back to /home: that would loop with /home's own check.
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("no teams, shared lookup fails: the form without a skip link, no redirect", async () => {
    vi.mocked(getTeams).mockResolvedValue([]);
    vi.mocked(getProjects).mockRejectedValue(new Error("projects unavailable"));
    render(<OnboardingPage />);
    await screen.findByLabelText("Team name");
    expect(screen.queryByRole("link", { name: "Skip for now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create Team" })).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a team, no shared projects", shared: [] as Project[] },
    { name: "a team and shared projects", shared: [SHARED] },
  ])("$name: redirects to /home without showing the form", async ({ shared }) => {
    setAccess([TEAM], shared);
    render(<OnboardingPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home"));
    expect(screen.queryByLabelText("Team name")).toBeNull();
    expect(screen.queryByRole("link", { name: "Skip for now" })).toBeNull();
  });

  it("a signed-out visitor goes to /auth", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    render(<OnboardingPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/auth"));
    expect(getTeams).not.toHaveBeenCalled();
  });
});
