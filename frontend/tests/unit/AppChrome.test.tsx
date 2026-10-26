/** @vitest-environment jsdom */
/**
 * AppChrome feeds the header: one user lookup and one team lookup per shell
 * mount (not per navigation), a failed team lookup leaves the header without
 * switcher or team entries, and the shell stays suppressed on the public
 * routes without fetching anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { Team } from "../../src/lib/api";

const navState = vi.hoisted(() => ({ pathname: "/home" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  logout: vi.fn(),
}));

import AppChrome from "../../src/components/AppChrome";
import { getCurrentUser, getTeams } from "../../src/lib/api";

const TEAMS = [
  { id: "t1", name: "Team One", slug: "one", role: "ADMIN", createdAt: "x" },
  { id: "t2", name: "Team Two", slug: "two", role: "ADMIN", createdAt: "x" },
] as Team[];

beforeEach(() => {
  vi.clearAllMocks();
  navState.pathname = "/home";
  window.localStorage.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: "u", login: "lan", avatarUrl: null } as never);
  vi.mocked(getTeams).mockResolvedValue(TEAMS);
});
afterEach(cleanup);

describe("AppChrome", () => {
  it("loads the teams once and gives the header its switcher", async () => {
    const { rerender } = render(<AppChrome><p>page</p></AppChrome>);
    expect(await screen.findByRole("button", { name: /Switch team/ })).toBeInTheDocument();

    navState.pathname = "/tasks";
    rerender(<AppChrome><p>page</p></AppChrome>);
    navState.pathname = "/projects";
    rerender(<AppChrome><p>page</p></AppChrome>);

    expect(getTeams).toHaveBeenCalledTimes(1);
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("a failed team lookup leaves the header without switcher and team entries", async () => {
    vi.mocked(getTeams).mockRejectedValue(new Error("boom"));
    render(<AppChrome><p>page</p></AppChrome>);
    const trigger = await screen.findByRole("button", { name: "Account menu for lan" });
    await waitFor(() => expect(getTeams).toHaveBeenCalled());

    expect(document.querySelector(".app-team-label, .app-team-trigger")).toBeNull();
    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitem").map((e) => e.textContent);
    expect(items).toEqual(["Settings", "Logout"]);
  });

  it("drops the user and teams when the shell is suppressed, and shows the next login's own", async () => {
    const { rerender } = render(<AppChrome><p>page</p></AppChrome>);
    expect(await screen.findByRole("button", { name: /Switch team/ })).toBeInTheDocument();

    // Logout lands on / (shell suppressed).
    navState.pathname = "/";
    rerender(<AppChrome><p>page</p></AppChrome>);
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();

    // The next login is a different account with one team; its lookups are
    // still in flight when the shell comes back.
    let releaseUser: (u: never) => void = () => {};
    let releaseTeams: (t: Team[]) => void = () => {};
    vi.mocked(getCurrentUser).mockReturnValue(new Promise((r) => { releaseUser = r; }));
    vi.mocked(getTeams).mockReturnValue(new Promise((r) => { releaseTeams = r; }));
    navState.pathname = "/home";
    rerender(<AppChrome><p>page</p></AppChrome>);

    // Nothing of the previous account is on screen meanwhile.
    expect(screen.queryByRole("button", { name: /Account menu for lan/ })).not.toBeInTheDocument();
    expect(document.querySelector(".app-team-label, .app-team-trigger")).toBeNull();

    await act(async () => {
      releaseUser({ id: "u2", login: "kim", avatarUrl: null } as never);
      releaseTeams([TEAMS[1]!]);
    });
    expect(await screen.findByRole("button", { name: "Account menu for kim" })).toBeInTheDocument();
    expect(document.querySelector(".app-team-label")?.textContent).toContain("Team Two");
    expect(document.querySelector(".app-team-trigger")).toBeNull();
  });

  it("ignores a team lookup that answers after the shell was suppressed again", async () => {
    let releaseTeams: (t: Team[]) => void = () => {};
    vi.mocked(getTeams).mockReturnValue(new Promise((r) => { releaseTeams = r; }));
    const { rerender } = render(<AppChrome><p>page</p></AppChrome>);
    await screen.findByRole("button", { name: "Account menu for lan" });

    navState.pathname = "/";
    rerender(<AppChrome><p>page</p></AppChrome>);
    // The late answer of the first shell must not leak into the next one: its
    // own lookup never answers here, so the header must show no switcher.
    vi.mocked(getTeams).mockReturnValue(new Promise(() => {}));
    await act(async () => {
      releaseTeams(TEAMS);
    });
    navState.pathname = "/home";
    rerender(<AppChrome><p>page</p></AppChrome>);

    expect(await screen.findByRole("button", { name: "Account menu for lan" })).toBeInTheDocument();
    expect(document.querySelector(".app-team-label, .app-team-trigger")).toBeNull();
  });

  it("ignores a user lookup that answers after the shell was suppressed and shown again", async () => {
    let releaseFirst: (u: never) => void = () => {};
    vi.mocked(getCurrentUser).mockReturnValueOnce(new Promise((r) => { releaseFirst = r; }));
    const { rerender } = render(<AppChrome><p>page</p></AppChrome>);
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalledTimes(1));

    navState.pathname = "/";
    rerender(<AppChrome><p>page</p></AppChrome>);
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u2", login: "kim", avatarUrl: null } as never);
    navState.pathname = "/home";
    rerender(<AppChrome><p>page</p></AppChrome>);
    expect(await screen.findByRole("button", { name: "Account menu for kim" })).toBeInTheDocument();

    // The first shell's slow answer arrives last and must not replace kim.
    await act(async () => {
      releaseFirst({ id: "u1", login: "lan", avatarUrl: null } as never);
    });
    expect(screen.getByRole("button", { name: "Account menu for kim" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Account menu for lan" })).not.toBeInTheDocument();
  });

  it("ignores lookups of an earlier shell that fail after the next shell loaded", async () => {
    let failUser: (e: unknown) => void = () => {};
    let failTeams: (e: unknown) => void = () => {};
    vi.mocked(getCurrentUser).mockReturnValueOnce(new Promise((_, rej) => { failUser = rej; }));
    vi.mocked(getTeams).mockReturnValueOnce(new Promise((_, rej) => { failTeams = rej; }));
    const { rerender } = render(<AppChrome><p>page</p></AppChrome>);
    await waitFor(() => expect(getTeams).toHaveBeenCalledTimes(1));

    navState.pathname = "/";
    rerender(<AppChrome><p>page</p></AppChrome>);
    navState.pathname = "/home";
    rerender(<AppChrome><p>page</p></AppChrome>);
    expect(await screen.findByRole("button", { name: /Switch team/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Account menu for lan" })).toBeInTheDocument();

    await act(async () => {
      failUser(new Error("late user failure"));
      failTeams(new Error("late teams failure"));
    });

    expect(screen.getByRole("button", { name: /Switch team/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account menu for lan" })).toBeInTheDocument();
  });

  it.each(["/", "/auth", "/auth/error", "/onboarding", "/invite/abc", "/dev"])(
    "renders no header and fetches nothing on %s",
    (pathname) => {
      navState.pathname = pathname;
      render(<AppChrome><p>page</p></AppChrome>);
      expect(screen.queryByRole("banner")).not.toBeInTheDocument();
      expect(screen.getByText("page")).toBeInTheDocument();
      expect(getTeams).not.toHaveBeenCalled();
      expect(getCurrentUser).not.toHaveBeenCalled();
    },
  );
});
