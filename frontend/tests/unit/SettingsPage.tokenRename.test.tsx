/** @vitest-environment jsdom */
/**
 * Team settings page (/settings/team) — API tokens, agent-token rename
 * affordance, and the page shell.
 *
 * Full-page render (src/lib/api mocked wholesale via vi.mock, matching the
 * pattern in TaskDetail.variant.test.tsx / NewTaskFlow.test.tsx): the token
 * section reads the page's `selectedTeam` and the loaded token list, so the
 * page is rendered whole. `next/navigation`'s `useRouter` and jsdom's
 * missing `IntersectionObserver` (used by the page's scroll-spy effect) are
 * stubbed so the page can mount at all.
 *
 * Covers:
 *   - The page shell: Team settings title, API Tokens and Enterprise SSO
 *     sections (the SSO card links to /settings/team/sso), and the current-team
 *     rule (?teamId, then the remembered team, then the first team).
 *   - Rename AND Revoke are disabled (with admin-only titles) for a
 *     non-admin `selectedTeam.role`; Rename is enabled for ADMIN.
 *   - A successful save replaces the row's displayed name and closes the
 *     modal (title names the token being renamed).
 *   - A failed save keeps the modal open with exactly ONE error display
 *     (the in-modal banner; the page-level banner excludes this case), and
 *     the stale error is cleared when the modal is reopened.
 *   - Switching teams dismisses an open rename modal (a stale target id
 *     must not be actioned against the newly selected team's tokens).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User, Team, AgentToken } from "../../src/lib/api";

// A stable object: TeamSettingsPage's bootstrap effect depends on `[router]`,
// and useRouter() is called on every render — returning a fresh object
// literal per call would make that dependency "change" on every render,
// re-running the whole fetch-and-setTokens bootstrap effect (with its
// still-stale mocked list) after every user interaction and clobbering
// any local state update, e.g. a just-completed rename.
const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getAgentTokens: vi.fn(),
  createAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
  renameAgentToken: vi.fn(),
  updateDelegationSettings: vi.fn(),
  getGithubTokenHealth: vi.fn(),
  getAvailableScopes: vi.fn(),
}));

import TeamSettingsPage from "../../src/app/settings/team/page";
import { announceTeamChange } from "../../src/lib/teamSwitch";
import {
  getCurrentUser,
  getTeams,
  getAgentTokens,
  renameAgentToken,
  getAvailableScopes,
} from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockGetTeams = vi.mocked(getTeams);
const mockGetAgentTokens = vi.mocked(getAgentTokens);
const mockRenameAgentToken = vi.mocked(renameAgentToken);
const mockGetAvailableScopes = vi.mocked(getAvailableScopes);

// jsdom does not implement scrollIntoView; the custom Select's
// scroll-active-option-into-view effect calls it when its listbox opens
// (the team-switch test below opens that popover).
Element.prototype.scrollIntoView = vi.fn();

// jsdom does not implement IntersectionObserver; the page's scroll-spy
// effect (side-nav active-section tracking) instantiates one on mount.
class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverStub;

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

function makeTeam(role: string, over: Partial<Team> = {}): Team {
  return {
    id: "team-1",
    name: "Pandora",
    slug: "pandora",
    role,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeToken(over: Partial<AgentToken> = {}): AgentToken {
  return {
    id: "tok-1",
    name: "old-name",
    scopes: ["tasks:read"],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

async function renderTeamSettingsPage(role: string, tokens: AgentToken[]) {
  mockGetTeams.mockResolvedValue([makeTeam(role)]);
  mockGetAgentTokens.mockResolvedValue(tokens);
  render(<TeamSettingsPage />);
  // Specifically the section heading, not the side-nav link of the same text.
  await screen.findByRole("heading", { name: "API Tokens" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(makeUser());
  mockGetAvailableScopes.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe("TeamSettingsPage — agent token rename", () => {
  it("disables Rename with an admin-only title when selectedTeam.role is not ADMIN", async () => {
    await renderTeamSettingsPage("HUMAN_MEMBER", [makeToken({ name: "ci-bot" })]);

    const renameBtn = screen.getByRole("button", { name: "Rename" });
    expect(renameBtn).toBeDisabled();
    expect(renameBtn).toHaveAttribute("title", "Only team admins can rename API tokens");

    // The sibling Revoke button carries the same admin gating (added in the
    // same change; mutation probe: removing its `disabled` turns this red).
    const revokeBtn = screen.getByRole("button", { name: "Revoke" });
    expect(revokeBtn).toBeDisabled();
    expect(revokeBtn).toHaveAttribute("title", "Only team admins can revoke API tokens");
  });

  it("enables Rename with no title when selectedTeam.role is ADMIN", async () => {
    await renderTeamSettingsPage("ADMIN", [makeToken({ name: "ci-bot" })]);

    const renameBtn = screen.getByRole("button", { name: "Rename" });
    expect(renameBtn).not.toBeDisabled();
    expect(renameBtn).not.toHaveAttribute("title");
  });

  it("opens the create-token modal titled Create API Token", async () => {
    const user = userEvent.setup();
    await renderTeamSettingsPage("ADMIN", []);

    await user.click(screen.getByRole("button", { name: "Create custom token" }));
    expect(await screen.findByRole("heading", { name: "Create API Token" })).toBeInTheDocument();
  });

  it("a successful save replaces the row's displayed name and closes the modal", async () => {
    const user = userEvent.setup();
    await renderTeamSettingsPage("ADMIN", [makeToken({ id: "tok-1", name: "old-name" })]);
    mockRenameAgentToken.mockResolvedValue(makeToken({ id: "tok-1", name: "new-name" }));

    expect(screen.getByText("old-name")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rename" }));

    // Modal title reflects the token being renamed.
    expect(await screen.findByRole("heading", { name: 'Rename "old-name"' })).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");

    const input = within(dialog).getByPlaceholderText("e.g. ci-bot") as HTMLInputElement;
    expect(input.value).toBe("old-name");
    await user.clear(input);
    await user.type(input, "new-name");

    // Scope the query to the open dialog.
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockRenameAgentToken).toHaveBeenCalledWith("tok-1", "new-name"));

    // Row now shows the new name; old name is gone. Modal is closed.
    await waitFor(() => expect(screen.queryByText("old-name")).not.toBeInTheDocument());
    expect(screen.getByText("new-name")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: 'Rename "old-name"' })).not.toBeInTheDocument();
  });

  it("a failed save keeps the modal open and shows the error inside it, not on the page", async () => {
    const user = userEvent.setup();
    await renderTeamSettingsPage("ADMIN", [makeToken({ id: "tok-1", name: "old-name" })]);
    mockRenameAgentToken.mockRejectedValue(new Error("Only team admins can rename agent tokens"));

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByPlaceholderText("e.g. ci-bot") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "new-name");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await screen.findByText("Only team admins can rename agent tokens");
    // Modal (and the original name) still present — save did not close it.
    expect(screen.getByRole("heading", { name: 'Rename "old-name"' })).toBeInTheDocument();
    expect(screen.getByText("old-name")).toBeInTheDocument();
    // Exactly one error banner rendered (the in-modal one) — the page-level
    // banner excludes the renameTarget case to avoid a double display.
    expect(screen.getAllByText("Only team admins can rename agent tokens")).toHaveLength(1);

    // Stale-error clearing: cancel, reopen — the old failure must not
    // greet the fresh modal (mutation probe: removing the setError(null)
    // on the Rename button's onClick turns this red).
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Only team admins can rename agent tokens")).not.toBeInTheDocument();
  });

  it("switching teams dismisses an open rename modal", async () => {
    const user = userEvent.setup();
    const teamA = makeTeam("ADMIN");
    const teamB = makeTeam("ADMIN", { id: "team-2", name: "Second", slug: "second" });
    mockGetTeams.mockResolvedValue([teamA, teamB]);
    mockGetAgentTokens.mockResolvedValue([makeToken({ name: "ci-bot" })]);
    render(<TeamSettingsPage />);
    await screen.findByRole("heading", { name: "API Tokens" });

    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // A stale rename target must not survive into the newly selected
    // team's token list. The header switcher announces the switch; the page
    // remounts the token section for the new team.
    mockGetAgentTokens.mockResolvedValue([makeToken({ id: "tok-b", name: "other-bot" })]);
    act(() => announceTeamChange("team-2"));
    expect(await screen.findByText("other-bot")).toBeInTheDocument();
    expect(mockGetAgentTokens).toHaveBeenLastCalledWith("team-2");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("switching teams dismisses an open revoke confirmation", async () => {
    const user = userEvent.setup();
    const teamA = makeTeam("ADMIN");
    const teamB = makeTeam("ADMIN", { id: "team-2", name: "Second", slug: "second" });
    mockGetTeams.mockResolvedValue([teamA, teamB]);
    mockGetAgentTokens.mockResolvedValue([makeToken({ name: "ci-bot" })]);
    render(<TeamSettingsPage />);
    await screen.findByRole("heading", { name: "API Tokens" });

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Revoke API token?")).toBeInTheDocument();

    // A stale revoke target must not survive into the newly selected team's
    // token list (the section is keyed by the team).
    mockGetAgentTokens.mockResolvedValue([makeToken({ id: "tok-b", name: "other-bot" })]);
    act(() => announceTeamChange("team-2"));
    expect(await screen.findByText("other-bot")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Revoke API token?")).not.toBeInTheDocument());
  });
});

describe("TeamSettingsPage — page shell", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("renders the Team settings title with API Tokens and Enterprise SSO sections", async () => {
    await renderTeamSettingsPage("ADMIN", []);

    expect(screen.getByRole("heading", { level: 1, name: "Team settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Enterprise SSO" })).toBeInTheDocument();
    // The side-nav lists exactly the team sections.
    const nav = screen.getByRole("complementary", { name: "Team settings sections" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "API Tokens",
      "Enterprise SSO",
    ]);
    // The SSO card keeps linking to the SSO page.
    expect(screen.getByRole("link", { name: "Manage SSO connection" })).toHaveAttribute(
      "href",
      "/settings/team/sso",
    );
    // Personal sections are not on this page.
    expect(screen.queryByRole("heading", { name: "Account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agent Permissions" })).not.toBeInTheDocument();
  });

  it("links back to personal Settings with a breadcrumb", async () => {
    await renderTeamSettingsPage("ADMIN", []);

    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("remembers a team chosen via ?teamId", async () => {
    window.history.replaceState(null, "", "/settings/team?teamId=team-2");
    mockGetTeams.mockResolvedValue([
      makeTeam("ADMIN"),
      makeTeam("ADMIN", { id: "team-2", name: "Second", slug: "second" }),
    ]);
    mockGetAgentTokens.mockResolvedValue([]);
    render(<TeamSettingsPage />);
    await screen.findByRole("heading", { name: "API Tokens" });

    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("team-2");
  });

  it("does not remember the first-team fallback when the URL names no team", async () => {
    await renderTeamSettingsPage("ADMIN", []);

    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBeNull();
  });

  it("scrolls to the hash target once the sections have rendered", async () => {
    window.location.hash = "#sso";
    await renderTeamSettingsPage("ADMIN", []);

    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("sso"));
  });

  it("does not scroll when the URL has no hash", async () => {
    await renderTeamSettingsPage("ADMIN", []);

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("uses the remembered team over the first team", async () => {
    const teamA = makeTeam("ADMIN");
    const teamB = makeTeam("ADMIN", { id: "team-2", name: "Second", slug: "second" });
    window.localStorage.setItem("agent-tasks:lastTeamId", "team-2");
    mockGetTeams.mockResolvedValue([teamA, teamB]);
    mockGetAgentTokens.mockResolvedValue([]);
    render(<TeamSettingsPage />);
    await screen.findByRole("heading", { name: "API Tokens" });

    expect(mockGetAgentTokens).toHaveBeenCalledWith("team-2");
    // The team select moved to the header switcher.
    expect(screen.queryByRole("combobox", { name: "Team" })).not.toBeInTheDocument();
  });

  it("ignores an announced switch to the current or an unknown team", async () => {
    const teamA = makeTeam("ADMIN");
    const teamB = makeTeam("ADMIN", { id: "team-2", name: "Second", slug: "second" });
    mockGetTeams.mockResolvedValue([teamA, teamB]);
    mockGetAgentTokens.mockResolvedValue([]);
    render(<TeamSettingsPage />);
    await screen.findByRole("heading", { name: "API Tokens" });
    expect(mockGetAgentTokens).toHaveBeenCalledTimes(1);

    act(() => announceTeamChange("team-1"));
    act(() => announceTeamChange("ghost"));

    expect(mockGetAgentTokens).toHaveBeenCalledTimes(1);
  });

  it("?teamId in the URL wins over the remembered team", async () => {
    const teamA = makeTeam("ADMIN");
    const teamB = makeTeam("ADMIN", { id: "team-2", name: "Second", slug: "second" });
    window.localStorage.setItem("agent-tasks:lastTeamId", "team-2");
    window.history.replaceState(null, "", "/settings/team?teamId=team-1");
    mockGetTeams.mockResolvedValue([teamA, teamB]);
    mockGetAgentTokens.mockResolvedValue([]);
    render(<TeamSettingsPage />);
    await screen.findByRole("heading", { name: "API Tokens" });

    expect(mockGetAgentTokens).toHaveBeenCalledWith("team-1");
  });

  it("shows the no-team empty state without loading tokens when the user has no teams", async () => {
    mockGetTeams.mockResolvedValue([]);
    render(<TeamSettingsPage />);
    await screen.findByRole("heading", { name: "API Tokens" });

    expect(screen.getByText("No team found yet")).toBeInTheDocument();
    expect(mockGetAgentTokens).not.toHaveBeenCalled();
  });

  it("redirects to /auth when there is no session", async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    render(<TeamSettingsPage />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/auth"));
    expect(mockGetTeams).not.toHaveBeenCalled();
  });
});
