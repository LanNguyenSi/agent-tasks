/** @vitest-environment jsdom */
/**
 * /settings/team: the one-time secret of a token created through "Connect an
 * agent".
 *
 * The dialog shows the secret itself while it can. When it cannot (closed, or
 * unmounted with its section because the team changed, before the response
 * arrives; or unmounted while it still shows the secret) the secret goes to
 * the page's reveals, tagged with the team the request was made for, and is
 * shown naming that team and the token. The header and the page are rendered
 * together on one in-memory history (tests/setup/fakeNavigation.ts).
 */
import { StrictMode } from "react";
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

import TeamSettingsPageRaw from "../../src/app/settings/team/page";
import { withTeamList } from "./helpers/withTeamList";
const TeamSettingsPage = withTeamList(TeamSettingsPageRaw);
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


/** Open "Connect an agent" and press Generate (the request stays pending). */
function connectAndGenerate() {
  fireEvent.click(screen.getByRole("button", { name: "Connect an agent" }));
  fireEvent.click(screen.getByTestId("connect-generate-btn"));
}

const NAME_A = "Agent (Alpha) - connect";

describe("connect-agent secret: the dialog shows it", () => {
  it("shows the snippet in the dialog, lists the token and creates no page-level reveal", async () => {
    mockCreate.mockResolvedValue({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    renderBoth();
    await screen.findByText("alpha-bot");

    connectAndGenerate();

    const snippet = await screen.findByTestId("connect-snippet");
    expect(snippet.textContent).toContain(SECRET_A);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-a" }));
    expect(screen.getByText(NAME_A)).toBeInTheDocument();
    // The secret is in the dialog only: no second copy as a reveal banner.
    expect(screen.queryByText(/created \(shown once\)/)).not.toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(document.body.textContent?.split(SECRET_A).length).toBe(
      (dialog.textContent?.split(SECRET_A).length ?? 0),
    );
  });
});

describe("connect-agent secret: the team changes while the create is pending", () => {
  it("shows the secret once the response arrives, naming the token and the team it was created in", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    expect(await screen.findByText("beta-bot")).toBeInTheDocument();
    expect(pageTeam()).toBe("Beta");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    const banner = revealBanner(`Token "${NAME_A}" created for Alpha (shown once)`);
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(banner).toHaveTextContent("This token belongs to Alpha");
    // Beta's page is unchanged: Alpha's token is not in Beta's list.
    expect(pageTeam()).toBe("Beta");
    expect(screen.getByText("beta-bot")).toBeInTheDocument();
    expect(screen.queryByText(NAME_A, { selector: ".settings-token-name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-a" }));
  });

  it("Dismiss clears it", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    await screen.findByText("beta-bot");
    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    fireEvent.click(
      within(revealBanner(`Token "${NAME_A}" created for Alpha (shown once)`)).getByRole("button", {
        name: "Dismiss",
      }),
    );

    expect(screen.queryByText(SECRET_A)).not.toBeInTheDocument();
    expect(screen.queryByText(/created for/)).not.toBeInTheDocument();
  });

  it("switching back to the team shows the token in its list and the secret in its section", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    await screen.findByText("beta-bot");
    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });
    mockGetAgentTokens.mockImplementation(async (teamId: string) =>
      teamId === "team-a" ? [token("tok-team-a", "alpha-bot"), token("tok-c", NAME_A)] : [],
    );

    pick("Alpha");

    expect(await screen.findByText(NAME_A, { selector: ".settings-token-name" })).toBeInTheDocument();
    const banner = revealBanner(`Token "${NAME_A}" created (shown once)`);
    expect(banner.closest("#api-tokens")).not.toBeNull();
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(screen.queryByText(/created for/)).not.toBeInTheDocument();
  });

  it("A, B, A while pending: the secret is shown in A's section and the token is appended without reloading the list", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    await screen.findByText("beta-bot");
    pick("Alpha");
    await screen.findByText("alpha-bot");
    const loadsBefore = mockGetAgentTokens.mock.calls.length;

    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    expect(await screen.findByText(NAME_A, { selector: ".settings-token-name" })).toBeInTheDocument();
    expect(mockGetAgentTokens.mock.calls.length).toBe(loadsBefore);
    const banner = revealBanner(`Token "${NAME_A}" created (shown once)`);
    expect(banner.closest("#api-tokens")).not.toBeNull();
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
  });

  it("a create for a team that is not shown does not reload the shown team's list", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    await screen.findByText("beta-bot");
    const loadsBefore = mockGetAgentTokens.mock.calls.length;

    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    expect(mockGetAgentTokens.mock.calls.length).toBe(loadsBefore);
  });

  it("a secret created for Alpha and one created for Beta are each named with their own team", async () => {
    const pendingA = deferred<CreateResult>();
    const pendingB = deferred<CreateResult>();
    mockCreate.mockImplementation((body: { teamId: string }) =>
      body.teamId === "team-a" ? pendingA.promise : pendingB.promise,
    );
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    await screen.findByText("beta-bot");
    connectAndGenerate();
    pick("Alpha");
    await screen.findByText("alpha-bot");

    await act(async () => {
      pendingB.resolve({ token: token("tok-b", "Agent (Beta) - connect"), rawToken: SECRET_B });
      pendingA.resolve({ token: token("tok-a", NAME_A), rawToken: SECRET_A });
    });

    // Viewing Alpha: Alpha's secret in its section, Beta's as a foreign banner.
    const own = revealBanner(`Token "${NAME_A}" created (shown once)`);
    expect(within(own).getByText(SECRET_A)).toBeInTheDocument();
    const foreign = revealBanner('Token "Agent (Beta) - connect" created for Beta (shown once)');
    expect(within(foreign).getByText(SECRET_B)).toBeInTheDocument();
    expect(foreign).toHaveTextContent("This token belongs to Beta");
  });
});

describe("connect-agent secret: the dialog is closed while the create is pending", () => {
  async function closedWhilePending() {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    return pending;
  }

  it("the secret is not lost: it is shown in the team's section, named, and the token is listed", async () => {
    const pending = await closedWhilePending();

    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    const banner = revealBanner(`Token "${NAME_A}" created (shown once)`);
    expect(banner.closest("#api-tokens")).not.toBeNull();
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(screen.getByText(NAME_A, { selector: ".settings-token-name" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/created for/)).not.toBeInTheDocument();
  });

  it("reopening the dialog starts clean: no second copy of the secret", async () => {
    const pending = await closedWhilePending();
    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect an agent" }));

    expect(screen.getByTestId("connect-generate-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-snippet")).not.toBeInTheDocument();
    expect(document.body.textContent?.split(SECRET_A).length).toBe(2);
  });

  it("Dismiss clears it", async () => {
    const pending = await closedWhilePending();
    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    fireEvent.click(
      within(revealBanner(`Token "${NAME_A}" created (shown once)`)).getByRole("button", { name: "Dismiss" }),
    );

    expect(screen.queryByText(SECRET_A)).not.toBeInTheDocument();
  });

  it("closed, then the team changes: the secret is shown as a foreign reveal", async () => {
    const pending = await closedWhilePending();
    pick("Beta");
    await screen.findByText("beta-bot");

    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    const banner = revealBanner(`Token "${NAME_A}" created for Alpha (shown once)`);
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(screen.queryByText(NAME_A, { selector: ".settings-token-name" })).not.toBeInTheDocument();
  });

  it("a failure after the close is shown naming the team, not as an unnamed error of the page", async () => {
    const pending = await closedWhilePending();

    await act(async () => {
      pending.reject(new Error("Token service unavailable"));
    });

    const alert = screen
      .getAllByRole("alert")
      .find((n) => n.textContent?.includes("Failed to create token for Alpha"));
    expect(alert).toHaveTextContent("Token service unavailable");
    expect(screen.queryByText(/created \(shown once\)/)).not.toBeInTheDocument();
    expect(screen.queryByText("Action failed")).not.toBeInTheDocument();
  });
});

describe("connect-agent secret: the dialog is unmounted while it shows the secret", () => {
  it("a team change after the response keeps the secret as a foreign reveal, and does not list it twice", async () => {
    mockCreate.mockResolvedValue({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    await screen.findByTestId("connect-snippet");

    pick("Beta");
    expect(await screen.findByText("beta-bot")).toBeInTheDocument();

    const banner = revealBanner(`Token "${NAME_A}" created for Alpha (shown once)`);
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(NAME_A, { selector: ".settings-token-name" })).not.toBeInTheDocument();
    // One copy of the secret on screen.
    expect(document.body.textContent?.split(SECRET_A).length).toBe(2);
  });

  it("closing the dialog by hand discards the secret: nothing is left on the page", async () => {
    mockCreate.mockResolvedValue({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    await screen.findByTestId("connect-snippet");

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));

    expect(screen.queryByText(/created \(shown once\)/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET_A);
  });
});

describe("connect-agent secret: a create that fails after the team changed", () => {
  it("names the team it was for, shows no reveal and leaves the shown team's page alone", async () => {
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    await screen.findByText("beta-bot");

    await act(async () => {
      pending.reject(new Error("Token service unavailable"));
    });

    const alert = screen
      .getAllByRole("alert")
      .find((n) => n.textContent?.includes("Failed to create token for Alpha"));
    expect(alert).toHaveTextContent("Token service unavailable");
    expect(screen.queryByText(/created \(shown once\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/created for/)).not.toBeInTheDocument();
    // Not an unnamed error inside Beta's section.
    expect(screen.queryByText("Action failed")).not.toBeInTheDocument();
    expect(screen.getAllByText("Token service unavailable")).toHaveLength(1);
    expect(pageTeam()).toBe("Beta");
    expect(screen.getByText("beta-bot")).toBeInTheDocument();
  });

  it("a failure while the dialog is open stays in the dialog", async () => {
    mockCreate.mockRejectedValue(new Error("Token service unavailable"));
    renderBoth();
    await screen.findByText("alpha-bot");

    connectAndGenerate();

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Token service unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to create token for/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Token service unavailable")).toHaveLength(1);
  });
});

describe("connect-agent secret: it stays in React state", () => {
  it("is written to no storage and not into the URL, and is gone once the page unmounts", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    const view = renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    await screen.findByText("beta-bot");
    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
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
    connectAndGenerate();

    view.unmount();
    const timersAfterUnmount = vi.getTimerCount();
    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });

    expect(document.body.textContent).not.toContain(SECRET_A);
    expect(vi.getTimerCount()).toBe(timersAfterUnmount);
  });

  it("a handed-over secret is masked after the delay and Reveal shows it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = deferred<CreateResult>();
    mockCreate.mockReturnValue(pending.promise);
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    pick("Beta");
    await screen.findByText("beta-bot");
    await act(async () => {
      pending.resolve({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    });
    expect(screen.getByText(SECRET_A)).toBeInTheDocument();

    await act(async () => void vi.advanceTimersByTime(31_000));
    expect(screen.queryByText(SECRET_A)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByText(SECRET_A)).toBeInTheDocument();
  });
});

describe("connect-agent secret: a secret the dialog had masked", () => {
  function stubClipboard() {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  }

  it("is handed over masked: the page reveal does not show it in clear until Reveal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubClipboard();
    mockCreate.mockResolvedValue({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    await screen.findByTestId("connect-snippet");
    fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    await act(async () => void vi.advanceTimersByTime(31_000));
    expect(screen.getByTestId("connect-snippet")).toHaveAttribute("data-token-masked", "true");

    pick("Beta");
    await screen.findByText("beta-bot");

    const banner = revealBanner(`Token "${NAME_A}" created for Alpha (shown once)`);
    expect(within(banner).queryByText(SECRET_A)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET_A);
    fireEvent.click(within(banner).getByRole("button", { name: "Reveal" }));
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
  });

  it("a secret that was never masked is handed over in clear, with no Reveal button", async () => {
    mockCreate.mockResolvedValue({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    renderBoth();
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    await screen.findByTestId("connect-snippet");

    pick("Beta");
    await screen.findByText("beta-bot");

    const banner = revealBanner(`Token "${NAME_A}" created for Alpha (shown once)`);
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(within(banner).queryByRole("button", { name: "Reveal" })).not.toBeInTheDocument();
  });
});

describe("connect-agent secret under React StrictMode", () => {
  it("a team change after the response keeps the secret as one foreign reveal", async () => {
    mockCreate.mockResolvedValue({ token: token("tok-c", NAME_A), rawToken: SECRET_A });
    render(
      <StrictMode>
        <AppHeader user={{ login: "lan", avatarUrl: null }} teams={TEAMS} />
        <TeamSettingsPage />
      </StrictMode>,
    );
    await screen.findByText("alpha-bot");
    connectAndGenerate();
    expect((await screen.findByTestId("connect-snippet")).textContent).toContain(SECRET_A);

    pick("Beta");
    expect(await screen.findByText("beta-bot")).toBeInTheDocument();

    const banner = revealBanner(`Token "${NAME_A}" created for Alpha (shown once)`);
    expect(within(banner).getByText(SECRET_A)).toBeInTheDocument();
    expect(document.body.textContent?.split(SECRET_A).length).toBe(2);
  });
});
