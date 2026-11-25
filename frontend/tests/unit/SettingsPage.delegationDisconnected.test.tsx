/** @vitest-environment jsdom */
/**
 * /settings, Agent Permissions without a usable GitHub connection: a
 * permission that is stored on can still be switched off (stale flags must be
 * clearable), one stored off cannot be switched on, and Save only sends an
 * all-off body. A connected user is not restricted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { getCurrentUser, getTeams, getGithubTokenHealth, updateDelegationSettings } from "../../src/lib/api";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockUpdate = vi.mocked(updateDelegationSettings);
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

const CREATE = "Allow agents to create PRs on my behalf";
const MERGE = "Allow agents to merge PRs on my behalf";
const COMMENT = "Allow agents to comment on PRs on my behalf";

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

const allOff = { allowAgentPrCreate: false, allowAgentPrMerge: false, allowAgentPrComment: false };

describe("SettingsPage: Agent Permissions while disconnected", () => {
  it("stale on flags can be switched off and saved as all-false; the off one stays locked", async () => {
    const stale = makeUser({ githubConnected: false, allowAgentPrCreate: true, allowAgentPrMerge: false, allowAgentPrComment: true });
    mockGetCurrentUser.mockResolvedValue(stale);
    mockUpdate.mockResolvedValue(makeUser({ githubConnected: false, ...allOff }));
    const user = userEvent.setup();
    await renderPage();

    expect(screen.getByText(/only switch permissions off/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: CREATE })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: MERGE })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: COMMENT })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: CREATE }));
    // still one flag on: saving would send a true flag, so Save stays locked
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: COMMENT }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(allOff);
  });

  it("a box stored off cannot be switched on, clicking it changes nothing", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser({ githubConnected: false, allowAgentPrCreate: true }));
    const user = userEvent.setup();
    await renderPage();

    const merge = screen.getByRole("checkbox", { name: MERGE });
    await user.click(merge);
    expect(merge).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("an unchecked stale box can be checked again back to its stored value", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser({ githubConnected: false, allowAgentPrCreate: true }));
    const user = userEvent.setup();
    await renderPage();

    const create = screen.getByRole("checkbox", { name: CREATE });
    await user.click(create);
    expect(create).not.toBeChecked();
    await user.click(create);
    expect(create).toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("connected: every box is operable and Save sends the chosen flags", async () => {
    mockGetCurrentUser.mockResolvedValue(makeUser({ githubConnected: true }));
    mockUpdate.mockResolvedValue(makeUser({ githubConnected: true, allowAgentPrMerge: true }));
    const user = userEvent.setup();
    await renderPage();

    expect(screen.queryByText(/Connect GitHub first/)).not.toBeInTheDocument();
    for (const name of [CREATE, MERGE, COMMENT]) expect(screen.getByRole("checkbox", { name })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: MERGE }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mockUpdate).toHaveBeenCalledWith({ ...allOff, allowAgentPrMerge: true });
  });
});
