/** @vitest-environment jsdom */
/**
 * AppChrome feeds the header: one user lookup and one team lookup per shell
 * mount (not per navigation), a failed team lookup leaves the header without
 * switcher or team entries, and the shell stays suppressed on the public
 * routes without fetching anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
