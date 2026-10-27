/** @vitest-environment jsdom */
/**
 * /settings/team: the one-time reveal of a created API token.
 *
 * The raw token exists only in the create response. The token section is
 * keyed by team and remounts on a team switch, so a create that is still in
 * flight when the team changes answers after its section is gone. The page
 * holds the reveal, tagged with the team it was created in, and shows it
 * naming that team. The header and the page are rendered together on one
 * in-memory history (tests/setup/fakeNavigation.ts), as in the header-sync
 * tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
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

import TeamSettingsPage from "../../src/app/settings/team/page";
import AppHeader from "../../src/components/AppHeader";
import { nav } from "../setup/fakeNavigation";
import {
  getCurrentUser,
  getTeams,
  getAgentTokens,
  createAgentToken,
  getAvailableScopes,
} from "../../src/lib/api";

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
const mockCreate = vi.mocked(createAgentToken);

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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CreateResult = { token: AgentToken; rawToken: string };

const SECRET_A = "at_SECRET_ALPHA_0123456789";
const SECRET_B = "at_SECRET_BETA_0123456789";

function renderBoth() {
  return render(
    <>
      <AppHeader user={{ login: "lan", avatarUrl: null }} teams={TEAMS} />
      <TeamSettingsPage />
    </>,
  );
}

function pick(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}
function pageTeam(): string {
  return document.querySelector("#api-tokens strong")?.textContent ?? "";
}

/** Open the create modal, name the token and submit (the request stays pending). */
function submitCreate(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Create custom token" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByPlaceholderText("e.g. ci-bot"), { target: { value: name } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
}

/** The success banner (role=status) whose title contains `title`. */
function revealBanner(title: string): HTMLElement {
  const el = screen
    .getAllByRole("status")
    .find((n) => n.querySelector(".alert-title")?.textContent === title);
  if (!el) throw new Error(`no reveal banner titled "${title}"`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  nav.reset("/settings/team?teamId=team-a");
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
  vi.mocked(getAvailableScopes).mockResolvedValue([]);
  mockGetAgentTokens.mockImplementation(async (teamId: string) => [
    token(`tok-${teamId}`, teamId === "team-b" ? "beta-bot" : "alpha-bot"),
  ]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("token reveal: normal path (no team switch)", () => {
  it("shows the secret once in the section, adds the token to the list and closes the modal", async () => {
    mockCreate.mockResolvedValue({ token: token("tok-new", "ci-new"), rawToken: SECRET_A });
    renderBoth();
    await screen.findByText("alpha-bot");

    submitCreate("ci-new");

    expect(await screen.findByText(SECRET_A)).toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-a", name: "ci-new" }));
    // Inside the API Tokens section, with the plain title (the section names its team).
    const banner = revealBanner("Token created (shown once)");
    expect(banner.closest("#api-tokens")).not.toBeNull();
    expect(screen.getByText("ci-new")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/This token belongs to/)).not.toBeInTheDocument();
  });

  it("Dismiss clears the secret", async () => {
    mockCreate.mockResolvedValue({ token: token("tok-new", "ci-new"), rawToken: SECRET_A });
    renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("ci-new");
    await screen.findByText(SECRET_A);

    fireEvent.click(within(revealBanner("Token created (shown once)")).getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(SECRET_A)).not.toBeInTheDocument();
    expect(screen.getByText("ci-new")).toBeInTheDocument();
  });

  it("a failed create keeps the error in the modal and shows no page-level banner", async () => {
    mockCreate.mockRejectedValue(new Error("Token service unavailable"));
    renderBoth();
    await screen.findByText("alpha-bot");

    submitCreate("ci-new");

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Token service unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to create token for/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Token service unavailable")).toHaveLength(1);
  });

  describe("mask timer", () => {
    async function revealed() {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockCreate.mockResolvedValue({ token: token("tok-new", "ci-new"), rawToken: SECRET_A });
      renderBoth();
      await screen.findByText("alpha-bot");
      submitCreate("ci-new");
      await screen.findByText(SECRET_A);
    }
    const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

    it("masks after 30 seconds and Reveal shows it again without a new timer", async () => {
      await revealed();

      await advance(29_000);
      expect(screen.getByText(SECRET_A)).toBeInTheDocument();
      await advance(2_000);
      expect(screen.queryByText(SECRET_A)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
      expect(screen.getByText(SECRET_A)).toBeInTheDocument();
      await advance(120_000);
      expect(screen.getByText(SECRET_A)).toBeInTheDocument();
    });

    it("copying restarts the timer", async () => {
      await revealed();
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      await advance(25_000);
      fireEvent.click(screen.getByRole("button", { name: /^Copy/ }));
      await act(async () => {});
      // 25s + 25s: past the first deadline, inside the restarted one.
      await advance(25_000);
      expect(screen.getByText(SECRET_A)).toBeInTheDocument();
      await advance(10_000);
      expect(screen.queryByText(SECRET_A)).not.toBeInTheDocument();
    });

    it("Dismiss cancels the timer", async () => {
      await revealed();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("token reveal: the team changes while the create is pending", () => {
  it("shows the secret once the response arrives, naming the team it was created in", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");

    submitCreate("late-bot");
    pick("Beta");
    expect(await screen.findByText("beta-bot")).toBeInTheDocument();
    expect(pageTeam()).toBe("Beta");

    await act(async () => {
      pending.resolve({ token: token("tok-late", "late-bot"), rawToken: SECRET_A });
    });

    const banner = revealBanner("Token created for Alpha (shown once)");
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(banner).toHaveTextContent("This token belongs to Alpha");
    // The page still shows Beta, and never lists Alpha's new token under it.
    expect(pageTeam()).toBe("Beta");
    expect(screen.getByText("beta-bot")).toBeInTheDocument();
    expect(screen.queryByText("late-bot")).not.toBeInTheDocument();
    // The request was for the team the form was submitted in.
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-a" }));
  });

  it("Dismiss clears it", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("late-bot");
    pick("Beta");
    await screen.findByText("beta-bot");
    await act(async () => {
      pending.resolve({ token: token("tok-late", "late-bot"), rawToken: SECRET_A });
    });

    fireEvent.click(
      within(revealBanner("Token created for Alpha (shown once)")).getByRole("button", { name: "Dismiss" }),
    );

    expect(screen.queryByText(SECRET_A)).not.toBeInTheDocument();
    expect(screen.queryByText(/Token created for/)).not.toBeInTheDocument();
  });

  it("the held secret moves into its own team's section, with the plain title, when that team is shown again", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("late-bot");
    pick("Beta");
    await screen.findByText("beta-bot");
    await act(async () => {
      pending.resolve({ token: token("tok-late", "late-bot"), rawToken: SECRET_A });
    });
    expect(screen.getByText(SECRET_A)).toBeInTheDocument();

    mockGetAgentTokens.mockImplementation(async (teamId: string) =>
      teamId === "team-a" ? [token("tok-team-a", "alpha-bot"), token("tok-late", "late-bot")] : [],
    );
    pick("Alpha");

    expect(await screen.findByText("late-bot")).toBeInTheDocument();
    const banner = revealBanner("Token created (shown once)");
    expect(banner.closest("#api-tokens")).not.toBeNull();
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(screen.queryByText(/Token created for/)).not.toBeInTheDocument();
  });

  it("two creates in different teams: each secret is shown with its own team, neither replaces the other", async () => {
    const pendingA = deferred<CreateResult>();
    const pendingB = deferred<CreateResult>();
    mockCreate.mockImplementation((body: { teamId: string }) =>
      body.teamId === "team-a" ? pendingA.promise : pendingB.promise,
    );
    renderBoth();
    await screen.findByText("alpha-bot");

    submitCreate("late-a");
    pick("Beta");
    await screen.findByText("beta-bot");
    submitCreate("late-b");

    // B answers first, in its own (still mounted) section; then A's late answer.
    await act(async () => {
      pendingB.resolve({ token: token("tok-b", "late-b"), rawToken: SECRET_B });
    });
    await act(async () => {
      pendingA.resolve({ token: token("tok-a", "late-a"), rawToken: SECRET_A });
    });

    const own = revealBanner("Token created (shown once)");
    expect(own.closest("#api-tokens")).not.toBeNull();
    expect(within(own).getByText(SECRET_B)).toBeInTheDocument();
    const foreign = revealBanner("Token created for Alpha (shown once)");
    expect(within(foreign).getByText(SECRET_A)).toBeInTheDocument();
    expect(foreign.closest("#api-tokens")).toBeNull();
    // Beta's list holds Beta's token only.
    expect(screen.getByText("late-b")).toBeInTheDocument();
    expect(screen.queryByText("late-a")).not.toBeInTheDocument();

    // Dismissing one leaves the other.
    fireEvent.click(within(foreign).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(SECRET_A)).not.toBeInTheDocument();
    expect(screen.getByText(SECRET_B)).toBeInTheDocument();
  });

  it("a second create for the same team replaces its reveal, as before", async () => {
    mockCreate
      .mockResolvedValueOnce({ token: token("tok-1", "first"), rawToken: "at_FIRST_0123456789" })
      .mockResolvedValueOnce({ token: token("tok-2", "second"), rawToken: "at_SECOND_0123456789" });
    renderBoth();
    await screen.findByText("alpha-bot");

    submitCreate("first");
    await screen.findByText("at_FIRST_0123456789");
    submitCreate("second");

    expect(await screen.findByText("at_SECOND_0123456789")).toBeInTheDocument();
    expect(screen.queryByText("at_FIRST_0123456789")).not.toBeInTheDocument();
  });

  it("a create that fails after the switch shows its error naming the original team", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("late-bot");
    pick("Beta");
    await screen.findByText("beta-bot");

    await act(async () => {
      pending.reject(new Error("Token service unavailable"));
    });

    const alert = screen
      .getAllByRole("alert")
      .find((n) => n.textContent?.includes("Failed to create token for Alpha"));
    expect(alert).toBeDefined();
    expect(alert).toHaveTextContent("Token service unavailable");
    expect(pageTeam()).toBe("Beta");
    expect(screen.queryByText(/Token created/)).not.toBeInTheDocument();

    fireEvent.click(within(alert as HTMLElement).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Failed to create token for/)).not.toBeInTheDocument();
  });

  it("two failed creates each name their team, and dismissing one leaves the other", async () => {
    const pendingA = deferred<CreateResult>();
    const pendingB = deferred<CreateResult>();
    mockCreate.mockImplementation((body: { teamId: string }) =>
      body.teamId === "team-a" ? pendingA.promise : pendingB.promise,
    );
    renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("late-a");
    pick("Beta");
    await screen.findByText("beta-bot");
    submitCreate("late-b");
    pick("Alpha");
    await screen.findByText("alpha-bot");

    await act(async () => {
      pendingA.reject(new Error("Alpha failed"));
      pendingB.reject(new Error("Beta failed"));
    });

    const failure = (name: string) =>
      screen.getAllByRole("alert").find((n) => n.textContent?.includes(`Failed to create token for ${name}`));
    expect(failure("Alpha")).toHaveTextContent("Alpha failed");
    expect(failure("Beta")).toHaveTextContent("Beta failed");

    fireEvent.click(within(failure("Alpha") as HTMLElement).getByRole("button", { name: "Dismiss" }));
    expect(failure("Alpha")).toBeUndefined();
    expect(failure("Beta")).toBeDefined();
  });

  it("A, B, A while pending: the secret is shown in A's section and A's list is loaded again", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("late-bot");
    pick("Beta");
    await screen.findByText("beta-bot");
    pick("Alpha");
    await screen.findByText("alpha-bot");
    const loadsBefore = mockGetAgentTokens.mock.calls.filter(([id]) => id === "team-a").length;
    mockGetAgentTokens.mockImplementation(async () => [
      token("tok-team-a", "alpha-bot"),
      token("tok-late", "late-bot"),
    ]);

    await act(async () => {
      pending.resolve({ token: token("tok-late", "late-bot"), rawToken: SECRET_A });
    });

    expect(await screen.findByText("late-bot")).toBeInTheDocument();
    expect(mockGetAgentTokens.mock.calls.filter(([id]) => id === "team-a").length).toBe(loadsBefore + 1);
    const banner = revealBanner("Token created (shown once)");
    expect(banner.closest("#api-tokens")).not.toBeNull();
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
  });

  it("a create for a team that is not shown does not reload the shown team's list", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("late-bot");
    pick("Beta");
    await screen.findByText("beta-bot");
    const loadsBefore = mockGetAgentTokens.mock.calls.length;

    await act(async () => {
      pending.resolve({ token: token("tok-late", "late-bot"), rawToken: SECRET_A });
    });

    expect(mockGetAgentTokens.mock.calls.length).toBe(loadsBefore);
  });
});

describe("token reveal: the secret stays in React state", () => {
  it("is written to no storage and not into the URL, and is gone once the page unmounts", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    const view = renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("late-bot");
    pick("Beta");
    await screen.findByText("beta-bot");
    await act(async () => {
      pending.resolve({ token: token("tok-late", "late-bot"), rawToken: SECRET_A });
    });
    expect(screen.getByText(SECRET_A)).toBeInTheDocument();

    for (const [, value] of setItem.mock.calls) expect(String(value)).not.toContain(SECRET_A);
    expect(JSON.stringify(window.localStorage)).not.toContain(SECRET_A);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(SECRET_A);
    expect(nav.entries.join(" ")).not.toContain("SECRET");

    view.unmount();
    expect(document.body.textContent).not.toContain(SECRET_A);
    setItem.mockRestore();
  });

  it("a create that answers after the page is gone keeps no secret and starts no timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    const view = renderBoth();
    await screen.findByText("alpha-bot");
    submitCreate("late-bot");

    view.unmount();
    const timersAfterUnmount = vi.getTimerCount();
    await act(async () => {
      pending.resolve({ token: token("tok-late", "late-bot"), rawToken: SECRET_A });
    });

    expect(document.body.textContent).not.toContain(SECRET_A);
    // No 30-second mask timer was started for the secret.
    expect(vi.getTimerCount()).toBe(timersAfterUnmount);
  });
});
