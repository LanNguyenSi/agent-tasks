/** @vitest-environment jsdom */
/**
 * The "New team" dialog opened from the header (team switcher and account
 * menu) for a user with at least one team: role/name, header stays, close
 * paths and focus return, error and success of the shared create form, and
 * the zero-team entry that stays a link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { Team } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("../../src/lib/api", () => ({
  logout: vi.fn(() => Promise.resolve()),
  createTeam: vi.fn(),
}));

import AppHeader from "../../src/components/AppHeader";
import { createTeam } from "../../src/lib/api";

const USER = { login: "lan", avatarUrl: null };
function team(id: string, name: string): Team {
  return { id, name, slug: id, role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };
}
const T1 = team("t1", "Team One");
const T2 = team("t2", "Team Two");

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(() => cleanup());

function accountTrigger() {
  return screen.getByRole("button", { name: "Account menu for lan" });
}
function switcherTrigger() {
  return screen.getByRole("button", { name: /Switch team, current team/ });
}
function openFromAccount() {
  fireEvent.click(accountTrigger());
  fireEvent.click(screen.getByRole("menuitem", { name: "New team" }));
}
function openFromSwitcher() {
  fireEvent.click(switcherTrigger());
  fireEvent.click(screen.getByRole("menuitem", { name: "+ New team" }));
}

describe("New team dialog", () => {
  it.each([
    ["account menu", openFromAccount, [T1]],
    ["team switcher", openFromSwitcher, [T1, T2]],
  ] as const)("opens from the %s as a modal dialog named New team", (_n, open, teams) => {
    render(<AppHeader user={USER} teams={[...teams]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    const dialog = screen.getByRole("dialog", { name: "New team" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The app header stays behind the dialog; no sign-out, no onboarding chrome.
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /sign out/i })).toBeNull();
    expect(within(dialog).getByLabelText("Team name")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create team" })).toBeInTheDocument();
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it("Escape closes it without navigating and returns focus to the account menu button", async () => {
    render(<AppHeader user={USER} teams={[T1]} />);
    openFromAccount();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(accountTrigger());
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("Cancel closes it and returns focus to the team switcher button", async () => {
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    openFromSwitcher();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(switcherTrigger());
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("generates the slug from the name until the slug is edited", () => {
    render(<AppHeader user={USER} teams={[T1]} />);
    openFromAccount();
    const name = screen.getByLabelText("Team name");
    const slug = screen.getByLabelText("Slug") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Second Team!" } });
    expect(slug.value).toBe("second-team");
    fireEvent.change(slug, { target: { value: "custom" } });
    fireEvent.change(name, { target: { value: "Another" } });
    expect(slug.value).toBe("custom");
  });

  it("a failed create shows the error inline, keeps the dialog open with the values", async () => {
    vi.mocked(createTeam).mockRejectedValue(new Error("slug taken"));
    render(<AppHeader user={USER} teams={[T1]} />);
    openFromAccount();
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await screen.findByText("slug taken");
    const dialog = screen.getByRole("dialog", { name: "New team" });
    expect((within(dialog).getByLabelText("Team name") as HTMLInputElement).value).toBe("Second");
    expect((within(dialog).getByLabelText("Slug") as HTMLInputElement).value).toBe("second");
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("success remembers the new team, opens its Home and closes the dialog", async () => {
    vi.mocked(createTeam).mockResolvedValue(team("t9", "Second"));
    render(<AppHeader user={USER} teams={[T1]} />);
    openFromAccount();
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/home?teamId=t9"));
    expect(createTeam).toHaveBeenCalledWith({ name: "Second", slug: "second" });
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t9");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("with no team the account entry stays a link to /onboarding and opens no dialog", () => {
    render(<AppHeader user={USER} teams={[]} />);
    fireEvent.click(accountTrigger());
    const link = screen.getByRole("menuitem", { name: "Create a team" });
    expect(link.getAttribute("href")).toBe("/onboarding");
    expect(screen.queryByRole("menuitem", { name: "New team" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
