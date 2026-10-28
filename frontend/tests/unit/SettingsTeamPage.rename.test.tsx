/** @vitest-environment jsdom */
/**
 * Team name card on /settings/team (rename a team after creation).
 *
 * Full-page render under the shell's team list, `src/lib/api` mocked
 * wholesale (same shape as SettingsPage.tokenRename.test.tsx). Covers:
 *   - the edit control exists for a team ADMIN and not for anyone else
 *     (non-admins see the name only);
 *   - a save sends the trimmed name, shows it, and reloads the shared team
 *     list (the page's token section and the header read that list);
 *   - a server error shows its message, keeps the old name and does not
 *     reload the list;
 *   - validation: empty, whitespace-only and unchanged names cannot be saved,
 *     even by submitting the form directly;
 *   - a rename that finishes after a team switch still reloads the list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { User, Team } from "../../src/lib/api";

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
  renameTeam: vi.fn(),
  getAvailableScopes: vi.fn(),
}));

import TeamSettingsPageRaw from "../../src/app/settings/team/page";
import { withTeamList } from "./helpers/withTeamList";
const TeamSettingsPage = withTeamList(TeamSettingsPageRaw);
import { nav } from "../setup/fakeNavigation";
import {
  getCurrentUser,
  getTeams,
  getAgentTokens,
  renameTeam,
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

const mockGetTeams = vi.mocked(getTeams);
const mockRenameTeam = vi.mocked(renameTeam);

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

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The API Tokens section's "API tokens for <strong>Team</strong>" name. */
function tokenSectionTeam(): string {
  return document.querySelector("#api-tokens strong")?.textContent ?? "";
}

async function renderPage(role: string, teams: Team[] = [makeTeam(role)]) {
  mockGetTeams.mockResolvedValue(teams);
  render(<TeamSettingsPage />);
  await screen.findByRole("heading", { name: "Team name" });
  await waitFor(() => expect(screen.queryByText("Loading tokens…")).not.toBeInTheDocument());
}

function nameInput() {
  return screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
}
function saveButton() {
  // While saving the button's name gains a screen-reader "Loading".
  return screen.getByRole("button", { name: /^Save name/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  nav.reset("/settings/team");
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", login: "lan" } as User);
  vi.mocked(getAgentTokens).mockResolvedValue([]);
  vi.mocked(getAvailableScopes).mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("team name card: who can edit", () => {
  it("gives a team ADMIN an input holding the current name and a Save button", async () => {
    await renderPage("ADMIN");
    expect(nameInput().value).toBe("Pandora");
    expect(saveButton()).toBeDisabled();
  });

  it.each(["HUMAN_MEMBER", "REVIEWER"])("shows the name only to a %s", async (role) => {
    await renderPage(role);
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save name" })).not.toBeInTheDocument();
    const section = document.querySelector("#team-name");
    expect(section?.textContent).toContain("Pandora");
    expect(section?.textContent).toContain("Only team admins can rename the team.");
  });

  it("lists the section in the side-nav", async () => {
    await renderPage("ADMIN");
    expect(screen.getByRole("link", { name: "Team name" })).toHaveAttribute("href", "#team-name");
  });
});

describe("team name card: saving", () => {
  it("sends the trimmed name, shows it and reloads the shared team list", async () => {
    const user = userEvent.setup();
    await renderPage("ADMIN");
    expect(mockGetTeams).toHaveBeenCalledTimes(1);
    expect(tokenSectionTeam()).toBe("Pandora");

    mockRenameTeam.mockResolvedValue(makeTeam("ADMIN", { name: "Pandora Labs" }));
    // The reloaded list carries the new name.
    mockGetTeams.mockResolvedValue([makeTeam("ADMIN", { name: "Pandora Labs" })]);

    await user.clear(nameInput());
    await user.type(nameInput(), "  Pandora Labs  ");
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());

    await waitFor(() => expect(mockRenameTeam).toHaveBeenCalledWith("team-1", "Pandora Labs"));
    expect(await screen.findByText("Team name saved.")).toBeInTheDocument();
    expect(nameInput().value).toBe("Pandora Labs");
    // The shared list was reloaded once more, and the page reads it.
    await waitFor(() => expect(mockGetTeams).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(tokenSectionTeam()).toBe("Pandora Labs"));
    // Nothing to save any more.
    expect(saveButton()).toBeDisabled();
  });

  it("clears the saved notice as soon as the name is edited again", async () => {
    const user = userEvent.setup();
    await renderPage("ADMIN");
    mockRenameTeam.mockResolvedValue(makeTeam("ADMIN", { name: "Pandora Labs" }));
    await user.clear(nameInput());
    await user.type(nameInput(), "Pandora Labs");
    await user.click(saveButton());
    await screen.findByText("Team name saved.");

    await user.type(nameInput(), "!");
    expect(screen.queryByText("Team name saved.")).not.toBeInTheDocument();
  });

  it("shows the server's message on failure, keeps the old name and does not reload the list", async () => {
    const user = userEvent.setup();
    await renderPage("ADMIN");
    mockRenameTeam.mockRejectedValue(new Error("Only team admins can rename the team"));

    await user.clear(nameInput());
    await user.type(nameInput(), "Pandora Labs");
    await user.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to rename team");
    expect(alert).toHaveTextContent("Only team admins can rename the team");
    // The page still shows the old name; what was typed stays editable.
    expect(tokenSectionTeam()).toBe("Pandora");
    expect(nameInput().value).toBe("Pandora Labs");
    expect(screen.queryByText("Team name saved.")).not.toBeInTheDocument();
    expect(mockGetTeams).toHaveBeenCalledTimes(1);
    // Save is available again for a retry.
    expect(saveButton()).toBeEnabled();
  });

  it("falls back to a generic message for a rejection that is not an Error", async () => {
    const user = userEvent.setup();
    await renderPage("ADMIN");
    mockRenameTeam.mockRejectedValue("boom");
    await user.clear(nameInput());
    await user.type(nameInput(), "Pandora Labs");
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to rename the team.");
  });

  it("a retry after a failure clears the old error", async () => {
    const user = userEvent.setup();
    await renderPage("ADMIN");
    mockRenameTeam.mockRejectedValueOnce(new Error("Server exploded"));
    await user.clear(nameInput());
    await user.type(nameInput(), "Pandora Labs");
    await user.click(saveButton());
    await screen.findByRole("alert");

    mockRenameTeam.mockResolvedValue(makeTeam("ADMIN", { name: "Pandora Labs" }));
    await user.click(saveButton());
    await screen.findByText("Team name saved.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables Save while the request is in flight and ignores a second submit", async () => {
    const user = userEvent.setup();
    await renderPage("ADMIN");
    const pending = deferred<Team>();
    mockRenameTeam.mockReturnValue(pending.promise);
    await user.clear(nameInput());
    await user.type(nameInput(), "Pandora Labs");
    await user.click(saveButton());

    await waitFor(() => expect(saveButton()).toBeDisabled());
    fireEvent.submit(nameInput().closest("form")!);
    expect(mockRenameTeam).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(makeTeam("ADMIN", { name: "Pandora Labs" }));
    });
    await screen.findByText("Team name saved.");
  });
});

describe("team name card: validation", () => {
  it.each([
    ["empty", ""],
    ["whitespace-only", "    "],
    ["zero-width-space-only", "\u200b"],
    ["NBSP-only", "\u00a0\u00a0"],
    ["format-characters-and-whitespace-only", " \u200b \ufeff "],
  ])("cannot save an %s name, not even by submitting the form", async (_label, text) => {
    const user = userEvent.setup();
    await renderPage("ADMIN");
    await user.clear(nameInput());
    if (text) await user.type(nameInput(), text);
    expect(saveButton()).toBeDisabled();
    fireEvent.submit(nameInput().closest("form")!);
    expect(mockRenameTeam).not.toHaveBeenCalled();
  });

  it("cannot save a name that is unchanged after trimming", async () => {
    const user = userEvent.setup();
    await renderPage("ADMIN");
    await user.type(nameInput(), "   ");
    expect(nameInput().value).toBe("Pandora   ");
    expect(saveButton()).toBeDisabled();
    fireEvent.submit(nameInput().closest("form")!);
    expect(mockRenameTeam).not.toHaveBeenCalled();
  });

  it("limits the input to the server's 100 characters", async () => {
    await renderPage("ADMIN");
    expect(nameInput()).toHaveAttribute("maxlength", "100");
  });
});

describe("team name card: team switch during a save", () => {
  it("still reloads the shared list when the rename finishes after the team changed", async () => {
    const user = userEvent.setup();
    await renderPage("ADMIN", [
      makeTeam("ADMIN"),
      makeTeam("ADMIN", { id: "team-2", name: "Beta", slug: "beta" }),
    ]);
    expect(mockGetTeams).toHaveBeenCalledTimes(1);
    const pending = deferred<Team>();
    mockRenameTeam.mockReturnValue(pending.promise);
    await user.clear(nameInput());
    await user.type(nameInput(), "Pandora Labs");
    await user.click(saveButton());
    await waitFor(() => expect(mockRenameTeam).toHaveBeenCalled());

    // The user switches to Beta while the request is out.
    act(() => nav.push("/settings/team?teamId=team-2"));
    await waitFor(() => expect(nameInput().value).toBe("Beta"));

    await act(async () => {
      pending.resolve(makeTeam("ADMIN", { name: "Pandora Labs" }));
    });
    await waitFor(() => expect(mockGetTeams).toHaveBeenCalledTimes(2));
    // The card now on screen is Beta's and was not touched by the result.
    expect(nameInput().value).toBe("Beta");
    expect(screen.queryByText("Team name saved.")).not.toBeInTheDocument();
  });
});
