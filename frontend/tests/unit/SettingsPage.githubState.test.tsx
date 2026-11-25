/** @vitest-environment jsdom */
/**
 * /settings: one state for the GitHub connection. `/auth/me` reports
 * `githubConnected: false` both for a user who never connected and for one
 * whose stored token can no longer be used, and the page cannot tell the two
 * apart. Both get the Connect banner, no health request, and a locked
 * Agent Permissions grid; a connected user gets none of that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getAgentTokens: vi.fn(),
  getAvailableScopes: vi.fn(),
  updateDelegationSettings: vi.fn(),
  getGithubTokenHealth: vi.fn(),
}));

import SettingsPageRaw from "../../src/app/settings/page";
import { withTeamList } from "./helpers/withTeamList";
const SettingsPage = withTeamList(SettingsPageRaw);
import { getCurrentUser, getTeams, getGithubTokenHealth } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetGithubTokenHealth = vi.mocked(getGithubTokenHealth);

class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserverStub;

window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  media: "(prefers-color-scheme: dark)",
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => true,
}) as unknown as typeof window.matchMedia;

function makeUser(over: Partial<User> = {}): User {
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
    ...over,
  };
}

async function renderPage() {
  render(<SettingsPage />);
  await screen.findByRole("heading", { name: "Account" });
}

const DELEGATION_LABELS = [
  "Allow agents to create PRs on my behalf",
  "Allow agents to merge PRs on my behalf",
  "Allow agents to comment on PRs on my behalf",
];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockGetGithubTokenHealth.mockResolvedValue({ state: "healthy", lastCheckedAt: null });
  vi.mocked(getTeams).mockResolvedValue([
    { id: "t1", name: "Alpha", slug: "alpha", role: "ADMIN", createdAt: "x" },
  ] as Team[]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("SettingsPage: GitHub connection state", () => {
  it("not connected: the Connect banner, a Connect button, locked permissions, no health request", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser({ githubConnected: false }));
    await renderPage();

    expect(screen.getByText("GitHub not connected")).toBeInTheDocument();
    expect(screen.getByText(/No usable GitHub connection\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/github/connect",
    );
    expect(screen.getByText(/^Connect GitHub first to enable agent permissions\./)).toBeInTheDocument();
    for (const name of DELEGATION_LABELS) {
      expect(screen.getByRole("checkbox", { name })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByText("GitHub token invalid")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Reconnect GitHub" })).not.toBeInTheDocument();
    expect(mockGetGithubTokenHealth).not.toHaveBeenCalled();
  });

  it("the not-connected text names no cause (it covers a never-made and an unusable connection)", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser({ githubConnected: false }));
    await renderPage();

    const banner = screen.getByText(/No usable GitHub connection\./);
    expect(banner.textContent).not.toMatch(/revoked|expired|encryption|key|yet/i);
  });

  it("connected: no Connect banner, permissions editable, health is requested", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser({ githubConnected: true }));
    await renderPage();

    expect(await screen.findByText(/GitHub is connected\./)).toBeInTheDocument();
    expect(screen.queryByText("GitHub not connected")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connect GitHub" })).not.toBeInTheDocument();
    for (const name of DELEGATION_LABELS) {
      expect(screen.getByRole("checkbox", { name })).toBeEnabled();
    }
    expect(mockGetGithubTokenHealth).toHaveBeenCalledTimes(1);
  });
});
