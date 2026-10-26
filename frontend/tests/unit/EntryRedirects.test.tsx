/** @vitest-environment jsdom */
/**
 * The three entry redirects (landing page, /auth for an already signed-in
 * user, /auth after a login) send a signed-in user to /onboarding only when
 * needsOnboarding(ctx) holds (no teams AND no shared projects), else to /home.
 * Each {teams 0/1, shared projects 0/1} combination is its own case per entry
 * point; either input alone keeps the user out of onboarding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  login: vi.fn(),
  register: vi.fn(),
  discoverSso: vi.fn(),
}));

import LandingPage from "../../src/app/page";
import AuthPage from "../../src/app/auth/page";
import { getCurrentUser, getProjects, getTeams, login } from "../../src/lib/api";

const USER = { id: "u-1", login: "lan" } as User;
const TEAM = { id: "t1", name: "Team", slug: "team", role: "ADMIN", createdAt: "x" } as Team;
const SHARED = { id: "p3", name: "Shared" } as Project;

const COMBOS = [
  { name: "no teams, no shared projects", teams: [], shared: [], target: "/onboarding" },
  { name: "no teams, shared projects", teams: [], shared: [SHARED], target: "/home" },
  { name: "a team, no shared projects", teams: [TEAM], shared: [], target: "/home" },
  { name: "a team and shared projects", teams: [TEAM], shared: [SHARED], target: "/home" },
];

function setAccess(teams: Team[], shared: Project[]) {
  vi.mocked(getTeams).mockResolvedValue(teams);
  vi.mocked(getProjects).mockResolvedValue(shared);
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("landing page (/) redirect for a signed-in user", () => {
  it.each(COMBOS)("$name -> $target", async ({ teams, shared, target }) => {
    vi.mocked(getCurrentUser).mockResolvedValue(USER);
    setAccess(teams, shared);
    render(<LandingPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith(target));
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
  });

  it("a signed-out visitor stays on the landing page", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    render(<LandingPage />);
    await screen.findByRole("heading", { name: /Plan and ship work/ });
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });
});

describe("/auth redirect for an already signed-in user", () => {
  it.each(COMBOS)("$name -> $target", async ({ teams, shared, target }) => {
    vi.mocked(getCurrentUser).mockResolvedValue(USER);
    setAccess(teams, shared);
    render(<AuthPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith(target));
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
  });
});

describe("/auth redirect after submitting the login form", () => {
  it.each(COMBOS)("$name -> $target", async ({ teams, shared, target }) => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    vi.mocked(login).mockResolvedValue(undefined as never);
    setAccess(teams, shared);
    render(<AuthPage />);
    await userEvent.type(await screen.findByLabelText("Email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "password123");
    await userEvent.click(screen.getByRole("button", { name: /^Sign in$/ }));
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith(target));
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);
  });
});
