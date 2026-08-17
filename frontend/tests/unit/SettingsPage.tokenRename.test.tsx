/** @vitest-environment jsdom */
/**
 * Settings page — agent-token rename affordance.
 *
 * Full-page render (src/lib/api mocked wholesale via vi.mock, matching the
 * pattern in TaskDetail.variant.test.tsx / NewTaskFlow.test.tsx) rather than
 * a mechanical component extraction: the rename button/modal live inline in
 * SettingsPage and read `selectedTeam`/`tokens` state that already exists
 * there, so pulling them into a separate component would be a structural
 * change to page.tsx beyond this task's scope. `next/navigation`'s
 * `useRouter` and jsdom's missing `IntersectionObserver` (used by the
 * page's scroll-spy effect) are stubbed so the page can mount at all.
 *
 * Covers:
 *   - Rename is disabled (with an admin-only title) for a non-admin
 *     `selectedTeam.role`, and enabled for ADMIN.
 *   - A successful save replaces the row's displayed name and closes the
 *     modal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User, Team, AgentToken } from "../../src/lib/api";

// A stable object: SettingsPage's bootstrap effect depends on `[router]`,
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

import SettingsPage from "../../src/app/settings/page";
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

// jsdom does not implement matchMedia either; the page renders
// <ThemePreferenceField>, whose "system" preference effect calls it on
// mount (see tests/unit/ThemePreferenceField.test.tsx for the same stub).
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

async function renderSettingsPage(role: string, tokens: AgentToken[]) {
  mockGetTeams.mockResolvedValue([makeTeam(role)]);
  mockGetAgentTokens.mockResolvedValue(tokens);
  render(<SettingsPage />);
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

describe("SettingsPage — agent token rename", () => {
  it("disables Rename with an admin-only title when selectedTeam.role is not ADMIN", async () => {
    await renderSettingsPage("HUMAN_MEMBER", [makeToken({ name: "ci-bot" })]);

    const renameBtn = screen.getByRole("button", { name: "Rename" });
    expect(renameBtn).toBeDisabled();
    expect(renameBtn).toHaveAttribute("title", "Only team admins can rename agent tokens");
  });

  it("enables Rename with no title when selectedTeam.role is ADMIN", async () => {
    await renderSettingsPage("ADMIN", [makeToken({ name: "ci-bot" })]);

    const renameBtn = screen.getByRole("button", { name: "Rename" });
    expect(renameBtn).not.toBeDisabled();
    expect(renameBtn).not.toHaveAttribute("title");
  });

  it("a successful save replaces the row's displayed name and closes the modal", async () => {
    const user = userEvent.setup();
    await renderSettingsPage("ADMIN", [makeToken({ id: "tok-1", name: "old-name" })]);
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

    // "Save" also exists as the (unrelated) delegation-settings save
    // button, so scope the query to the open dialog.
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockRenameAgentToken).toHaveBeenCalledWith("tok-1", "new-name"));

    // Row now shows the new name; old name is gone. Modal is closed.
    await waitFor(() => expect(screen.queryByText("old-name")).not.toBeInTheDocument());
    expect(screen.getByText("new-name")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: 'Rename "old-name"' })).not.toBeInTheDocument();
  });

  it("a failed save keeps the modal open and shows the error inside it, not on the page", async () => {
    const user = userEvent.setup();
    await renderSettingsPage("ADMIN", [makeToken({ id: "tok-1", name: "old-name" })]);
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
  });
});
