/** @vitest-environment jsdom */
/**
 * /settings/team and the header switcher agree about the current team.
 *
 * The page and AppHeader are rendered together on one in-memory history
 * (tests/setup/fakeNavigation.ts), so a pick in the header pushes a real URL,
 * and `nav.back()` / `nav.forward()` stand in for the browser buttons. After
 * every step the header's team and the team named in the page's API Tokens
 * section must be the same team, whatever order the token responses arrive in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { AgentToken, Team, User } from "../../src/lib/api";

vi.mock("next/navigation", async () => {
  const m = await import("../setup/fakeNavigation");
  return {
    usePathname: m.usePathname,
    useRouter: m.useRouter,
    useSearchParams: m.useSearchParams,
  };
});

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getAgentTokens: vi.fn(),
  createAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
  renameAgentToken: vi.fn(),
  getAvailableScopes: vi.fn(),
  logout: vi.fn(),
}));

import TeamSettingsPageRaw from "../../src/app/settings/team/page";
import { withTeamList } from "./helpers/withTeamList";
const TeamSettingsPage = withTeamList(TeamSettingsPageRaw);
import AppHeader from "../../src/components/AppHeader";
import { nav } from "../setup/fakeNavigation";
import { getCurrentUser, getTeams, getAgentTokens, getAvailableScopes } from "../../src/lib/api";

Element.prototype.scrollIntoView = vi.fn();
class IntersectionObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverStub;

const mockGetAgentTokens = vi.mocked(getAgentTokens);

function team(id: string, name: string): Team {
  return { id, name, slug: id, role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };
}
const TEAMS = [team("team-a", "Alpha"), team("team-b", "Beta")];

function token(id: string, name: string): AgentToken {
  return {
    id,
    name,
    scopes: ["tasks:read"],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
  };
}

/** A promise the test settles by hand, to control response order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderBoth() {
  return render(
    <>
      <AppHeader user={{ login: "lan", avatarUrl: null }} teams={TEAMS} />
      <TeamSettingsPage />
    </>,
  );
}

/** Pick a team in the header switcher, the way a user would. */
function pick(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

function headerTeam(): string {
  const label = screen.getByRole("button", { name: /Switch team/ }).getAttribute("aria-label");
  return /current team (.+)$/.exec(label ?? "")?.[1] ?? "";
}
function pageTeam(): string {
  // "API tokens for <strong>Team</strong>", in both the loaded section and
  // the loading/error placeholder.
  return document.querySelector("#api-tokens strong")?.textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  nav.reset("/settings/team?teamId=team-a");
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
  vi.mocked(getAvailableScopes).mockResolvedValue([]);
  mockGetAgentTokens.mockImplementation(async (teamId: string) => [
    token(`tok-${teamId}`, teamId === "team-b" ? "beta-bot" : "alpha-bot"),
  ]);
});
afterEach(() => cleanup());

describe("/settings/team follows the header team", () => {
  it("a fast B then A switch ends on A, and B's late response is ignored", async () => {
    renderBoth();
    expect(await screen.findByText("alpha-bot")).toBeInTheDocument();

    const lateB = deferred<AgentToken[]>();
    mockGetAgentTokens.mockImplementation((teamId: string) =>
      teamId === "team-b"
        ? lateB.promise
        : Promise.resolve([token("tok-team-a", "alpha-bot")]),
    );
    pick("Beta");
    pick("Alpha");

    expect(await screen.findByText("alpha-bot")).toBeInTheDocument();
    expect(headerTeam()).toBe("Alpha");
    expect(pageTeam()).toBe("Alpha");

    // B's response arrives after A has loaded: it must not replace A.
    await act(async () => {
      lateB.resolve([token("tok-team-b", "beta-bot")]);
    });
    expect(screen.queryByText("beta-bot")).not.toBeInTheDocument();
    expect(screen.getByText("alpha-bot")).toBeInTheDocument();
    expect(headerTeam()).toBe("Alpha");
    expect(pageTeam()).toBe("Alpha");
  });

  it("a fast A, B, A switch while B is still loading leaves A on the page", async () => {
    renderBoth();
    await screen.findByText("alpha-bot");
    const lateB = deferred<AgentToken[]>();
    mockGetAgentTokens.mockImplementation((teamId: string) =>
      teamId === "team-b" ? lateB.promise : Promise.resolve([token("tok-team-a", "alpha-bot")]),
    );

    pick("Beta");
    await waitFor(() => expect(mockGetAgentTokens).toHaveBeenCalledWith("team-b"));
    pick("Alpha");
    await screen.findByText("alpha-bot");
    await act(async () => {
      lateB.resolve([token("tok-team-b", "beta-bot")]);
    });

    expect(screen.queryByText("beta-bot")).not.toBeInTheDocument();
    expect(pageTeam()).toBe("Alpha");
    expect(headerTeam()).toBe("Alpha");
  });

  it("browser back and forward move the page and the header together", async () => {
    renderBoth();
    await screen.findByText("alpha-bot");

    pick("Beta");
    expect(await screen.findByText("beta-bot")).toBeInTheDocument();
    expect(headerTeam()).toBe("Beta");
    expect(pageTeam()).toBe("Beta");

    act(() => nav.back());
    expect(await screen.findByText("alpha-bot")).toBeInTheDocument();
    expect(headerTeam()).toBe("Alpha");
    expect(pageTeam()).toBe("Alpha");
    expect(mockGetAgentTokens).toHaveBeenLastCalledWith("team-a");

    act(() => nav.forward());
    expect(await screen.findByText("beta-bot")).toBeInTheDocument();
    expect(headerTeam()).toBe("Beta");
    expect(pageTeam()).toBe("Beta");
    expect(mockGetAgentTokens).toHaveBeenLastCalledWith("team-b");
  });

  it("back to an earlier team while a later team is still loading drops the later response", async () => {
    renderBoth();
    await screen.findByText("alpha-bot");
    const lateB = deferred<AgentToken[]>();
    mockGetAgentTokens.mockImplementation((teamId: string) =>
      teamId === "team-b" ? lateB.promise : Promise.resolve([token("tok-team-a", "alpha-bot")]),
    );

    pick("Beta");
    await waitFor(() => expect(mockGetAgentTokens).toHaveBeenCalledWith("team-b"));
    act(() => nav.back());
    await screen.findByText("alpha-bot");
    await act(async () => {
      lateB.resolve([token("tok-team-b", "beta-bot")]);
    });

    expect(screen.queryByText("beta-bot")).not.toBeInTheDocument();
    expect(pageTeam()).toBe("Alpha");
    expect(headerTeam()).toBe("Alpha");
  });

  it("a token fetch that rejects on a switch shows the error for that team, and page and header agree", async () => {
    renderBoth();
    await screen.findByText("alpha-bot");
    mockGetAgentTokens.mockImplementation(async (teamId: string) => {
      if (teamId === "team-b") throw new Error("Tokens unavailable");
      return [token("tok-team-a", "alpha-bot")];
    });

    pick("Beta");

    expect(await screen.findByText("Tokens unavailable")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load API tokens");
    // The old team's tokens are gone and the page names the new team.
    expect(screen.queryByText("alpha-bot")).not.toBeInTheDocument();
    expect(headerTeam()).toBe("Beta");
    expect(pageTeam()).toBe("Beta");

    // Switching on from the failed team recovers.
    pick("Alpha");
    expect(await screen.findByText("alpha-bot")).toBeInTheDocument();
    expect(screen.queryByText("Tokens unavailable")).not.toBeInTheDocument();
    expect(headerTeam()).toBe("Alpha");
    expect(pageTeam()).toBe("Alpha");
  });

  it("never mounts the token section for the new team with the old team's tokens", async () => {
    renderBoth();
    await screen.findByText("alpha-bot");
    // One mount so far: the section of the first team. getAvailableScopes is
    // called from the section's passive mount effect, which can run after the
    // DOM update findByText saw, so wait for it instead of reading the count.
    await waitFor(() => expect(vi.mocked(getAvailableScopes)).toHaveBeenCalledTimes(1));

    pick("Beta");
    expect(await screen.findByText("beta-bot")).toBeInTheDocument();

    // Exactly one more mount: Beta's own, once its tokens had arrived. A
    // Beta section seeded with Alpha's tokens (before Beta's load started)
    // would be a third. Wait for the second call, then let pending effects
    // and promises settle and require that no third call follows.
    await waitFor(() => expect(vi.mocked(getAvailableScopes)).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(getAvailableScopes)).toHaveBeenCalledTimes(2);
  });

  it("Retry reloads the current team's tokens after a failure", async () => {
    mockGetAgentTokens.mockRejectedValueOnce(new Error("Tokens unavailable"));
    renderBoth();
    expect(await screen.findByText("Tokens unavailable")).toBeInTheDocument();
    expect(pageTeam()).toBe("Alpha");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("alpha-bot")).toBeInTheDocument();
    expect(screen.queryByText("Tokens unavailable")).not.toBeInTheDocument();
    expect(mockGetAgentTokens).toHaveBeenCalledTimes(2);
  });

  it("a rejection that arrives after the user moved on is dropped", async () => {
    renderBoth();
    await screen.findByText("alpha-bot");
    const failingB = deferred<AgentToken[]>();
    mockGetAgentTokens.mockImplementation((teamId: string) =>
      teamId === "team-b" ? failingB.promise : Promise.resolve([token("tok-team-a", "alpha-bot")]),
    );

    pick("Beta");
    await waitFor(() => expect(mockGetAgentTokens).toHaveBeenCalledWith("team-b"));
    pick("Alpha");
    await screen.findByText("alpha-bot");
    await act(async () => {
      failingB.reject(new Error("late failure"));
    });

    expect(screen.queryByText("late failure")).not.toBeInTheDocument();
    expect(pageTeam()).toBe("Alpha");
  });
});

describe("/settings/team ignores superseded loads of the same team", () => {
  it("an earlier failed load of B does not show its error while B's newer load is pending", async () => {
    renderBoth();
    await screen.findByText("alpha-bot");
    const firstB = deferred<AgentToken[]>();
    const secondB = deferred<AgentToken[]>();
    let bCalls = 0;
    mockGetAgentTokens.mockImplementation((teamId: string) => {
      if (teamId !== "team-b") return Promise.resolve([token("tok-team-a", "alpha-bot")]);
      bCalls += 1;
      return bCalls === 1 ? firstB.promise : secondB.promise;
    });

    pick("Beta");
    await waitFor(() => expect(bCalls).toBe(1));
    pick("Alpha");
    await screen.findByText("alpha-bot");
    pick("Beta");
    await waitFor(() => expect(bCalls).toBe(2));
    await act(async () => {
      firstB.reject(new Error("first load failed"));
    });

    expect(screen.queryByText("first load failed")).not.toBeInTheDocument();
    expect(screen.getByText("Loading tokens…")).toBeInTheDocument();

    await act(async () => {
      secondB.resolve([token("tok-team-b", "beta-bot")]);
    });
    expect(await screen.findByText("beta-bot")).toBeInTheDocument();
    expect(pageTeam()).toBe("Beta");
    expect(headerTeam()).toBe("Beta");
  });
});
