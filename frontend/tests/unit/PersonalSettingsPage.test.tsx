/** @vitest-environment jsdom */
/**
 * Personal settings page (/settings).
 *
 * Covers the split from team settings:
 *   - Only the per-user sections render (Account, Appearance, GitHub, Agent
 *     Permissions); API tokens and the Enterprise SSO entry moved to
 *     /settings/team, so the page loads no tokens/scopes of its own. It
 *     reads the shell's one team list (TeamListProvider) for no data, only
 *     to resolve the team the "Open team settings" link carries.
 *   - Old `#api-tokens` / `#sso` links are forwarded client-side to the
 *     matching /settings/team section (the hash never reaches the server);
 *     any other hash stays put.
 *   - `?github_connected=1` (the OAuth return) is handled on this page.
 *   - A failed delegation save is reported in the Agent Permissions card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Team, User } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
let searchQuery = "";
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(searchQuery),
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
import {
  getCurrentUser,
  getTeams,
  getAgentTokens,
  getAvailableScopes,
  updateDelegationSettings,
  getGithubTokenHealth,
} from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockUpdateDelegation = vi.mocked(updateDelegationSettings);
const mockGetGithubTokenHealth = vi.mocked(getGithubTokenHealth);

// jsdom does not implement IntersectionObserver (scroll-spy effect).
class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverStub;

// jsdom does not implement matchMedia; <ThemePreferenceField> calls it.
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

beforeEach(() => {
  vi.clearAllMocks();
  searchQuery = "";
  window.localStorage.clear();
  mockGetCurrentUser.mockResolvedValue(makeUser());
  mockGetGithubTokenHealth.mockResolvedValue({ state: "healthy", lastCheckedAt: null });
  // The shell's team list: ready with two teams unless a test overrides.
  vi.mocked(getTeams).mockResolvedValue([
    { id: "t1", name: "Alpha", slug: "alpha", role: "ADMIN", createdAt: "x" },
    { id: "t2", name: "Beta", slug: "beta", role: "MEMBER", createdAt: "x" },
  ] as Team[]);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("SettingsPage (personal)", () => {
  it("renders only the per-user sections and no token or SSO UI", async () => {
    await renderPage();

    for (const name of ["Account", "Appearance", "GitHub Integration", "Agent Permissions"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "API Tokens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Enterprise SSO" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect an agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create custom token" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage SSO connection" })).not.toBeInTheDocument();

    // The side-nav lists exactly the personal sections.
    const nav = screen.getByRole("complementary", { name: "Settings sections" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Account",
      "Appearance",
      "GitHub",
      "Agent Permissions",
      "Team settings",
    ]);

    // The Team settings card is the in-app entry to /settings/team, and it
    // carries the team the shell resolves (no remembered team, no ?teamId:
    // the first team), so /settings/team opens it without rewriting the URL.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open team settings" })).toHaveAttribute(
        "href",
        "/settings/team?teamId=t1",
      ),
    );

    // No token data is fetched for personal settings, and the team list is
    // only the shell's single lookup, never a page-owned second one.
    await waitFor(() => expect(getTeams).toHaveBeenCalledTimes(1));
    expect(getAgentTokens).not.toHaveBeenCalled();
    expect(getAvailableScopes).not.toHaveBeenCalled();
  });

  describe("the Open team settings link", () => {
    it("carries the remembered team when the URL names none", async () => {
      window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
      await renderPage();
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Open team settings" })).toHaveAttribute(
          "href",
          "/settings/team?teamId=t2",
        ),
      );
    });

    it("the URL's ?teamId wins over the remembered team", async () => {
      window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
      searchQuery = "teamId=t1";
      await renderPage();
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Open team settings" })).toHaveAttribute(
          "href",
          "/settings/team?teamId=t1",
        ),
      );
    });

    it("stays bare when the user has no teams", async () => {
      vi.mocked(getTeams).mockResolvedValue([]);
      await renderPage();
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Open team settings" })).toHaveAttribute(
          "href",
          "/settings/team",
        ),
      );
    });

    it("stays bare while the team list failed to load", async () => {
      vi.mocked(getTeams).mockRejectedValue(new Error("teams unavailable"));
      await renderPage();
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Open team settings" })).toHaveAttribute(
          "href",
          "/settings/team",
        ),
      );
    });
  });

  it("forwards /settings#api-tokens to the team settings API tokens section", async () => {
    window.location.hash = "#api-tokens";
    await renderPage();

    expect(routerMocks.replace).toHaveBeenCalledWith("/settings/team#api-tokens");
  });

  it("forwards /settings#sso to the team settings SSO section", async () => {
    window.location.hash = "#sso";
    await renderPage();

    expect(routerMocks.replace).toHaveBeenCalledWith("/settings/team#sso");
  });

  it("does not forward other hashes or the bare page", async () => {
    window.location.hash = "#github";
    await renderPage();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    cleanup();

    window.location.hash = "";
    await renderPage();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("shows the connection banner for ?github_connected=1", async () => {
    window.history.replaceState(null, "", "/settings?github_connected=1");
    await renderPage();

    expect(screen.getByText("GitHub connected successfully.")).toBeInTheDocument();
  });

  it("does not show the connection banner without ?github_connected=1", async () => {
    await renderPage();

    expect(screen.queryByText("GitHub connected successfully.")).not.toBeInTheDocument();
  });

  it("redirects to /auth when there is no session", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    render(<SettingsPage />);

    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/auth"));
  });

  it("reports a failed delegation save inside the Agent Permissions card", async () => {
    const user = userEvent.setup();
    mockGetCurrentUser.mockResolvedValue(makeUser({ githubConnected: true }));
    mockUpdateDelegation.mockRejectedValue(new Error("Delegation save failed"));
    await renderPage();

    await user.click(
      screen.getByRole("checkbox", { name: "Allow agents to create PRs on my behalf" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByText("Delegation save failed");
    expect(alert.closest("#delegation")).not.toBeNull();
  });
});
