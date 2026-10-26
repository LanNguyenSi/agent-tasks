/** @vitest-environment jsdom */
/**
 * AppHeader: nav items and active states, the team switcher (hidden / static
 * label / dropdown per team count), the avatar menu entries, and what a team
 * switch does (remember, navigate to the section root, keep focus).
 * Mock pattern mirrors the other header-adjacent tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { Team } from "../../src/lib/api";

const navState = vi.hoisted(() => ({ pathname: "/", search: "" }));
const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(navState.search),
}));

vi.mock("../../src/lib/api", () => ({
  logout: vi.fn(() => Promise.resolve()),
}));

import AppHeader from "../../src/components/AppHeader";

const USER = { login: "lan", avatarUrl: null };

function team(id: string, name: string): Team {
  return { id, name, slug: id, role: "ADMIN", createdAt: "2026-01-01T00:00:00Z" };
}
const T1 = team("t1", "Team One");
const T2 = team("t2", "Team Two");

function nav() {
  return screen.getByRole("navigation", { name: "Main" });
}
function navLink(name: string): HTMLElement {
  return within(nav()).getByRole("link", { name });
}

beforeEach(() => {
  vi.clearAllMocks();
  navState.pathname = "/home";
  navState.search = "";
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("AppHeader nav", () => {
  it("shows exactly Home, Projects, Tasks, in that order, with their targets", () => {
    render(<AppHeader user={USER} teams={[T1]} />);
    const links = within(nav()).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Home", "Projects", "Tasks"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/home?teamId=t1",
      "/projects?teamId=t1",
      "/tasks?teamId=t1",
    ]);
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    // Settings left the nav bar for the avatar menu (menu is closed here).
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
  });

  it.each([
    ["/home", "Home"],
    ["/projects", "Projects"],
    ["/projects/p1/board", "Projects"],
    ["/projects/p1/members", "Projects"],
    ["/projects/workflow", "Projects"],
    ["/tasks", "Tasks"],
    ["/tasks/t-1", "Tasks"],
  ])("%s marks only %s current", (pathname, current) => {
    navState.pathname = pathname;
    render(<AppHeader user={USER} teams={[T1]} />);
    for (const name of ["Home", "Projects", "Tasks"]) {
      if (name === current) {
        expect(navLink(name).getAttribute("aria-current")).toBe("page");
      } else {
        expect(navLink(name).hasAttribute("aria-current")).toBe(false);
      }
    }
  });

  it.each(["/settings", "/settings/team", "/dashboard"])(
    "%s marks no nav item current",
    (pathname) => {
      navState.pathname = pathname;
      render(<AppHeader user={USER} teams={[T1]} />);
      expect(within(nav()).queryByRole("link", { current: "page" })).not.toBeInTheDocument();
    },
  );

  it("keeps all three nav links in the DOM without any position-based hiding hook", () => {
    // The <=520px rule must not hide links by :first-child/:last-child, so
    // the three links are plain siblings of one nav that CSS never targets by
    // position (see the mobile block in globals.css).
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(nav().children).toHaveLength(3);
    for (const a of Array.from(nav().children)) {
      expect(a.classList.contains("app-nav-link")).toBe(true);
    }
  });
});

describe("AppHeader nav and brand links carry the team the header shows", () => {
  /** [brand, Home, Projects, Tasks] hrefs. */
  function hrefs(): (string | null)[] {
    const brand = screen.getByRole("link", { name: "agent-tasks" });
    return [brand, ...within(nav()).getAllByRole("link")].map((a) => a.getAttribute("href"));
  }
  const withTeam = (id: string) => [
    `/home?teamId=${id}`,
    `/home?teamId=${id}`,
    `/projects?teamId=${id}`,
    `/tasks?teamId=${id}`,
  ];
  const BARE = ["/home", "/home", "/projects", "/tasks"];

  it("with one team: its id", () => {
    render(<AppHeader user={USER} teams={[T1]} />);
    expect(hrefs()).toEqual(withTeam("t1"));
  });

  it("with two teams: the team ?teamId names", () => {
    navState.search = "teamId=t2";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(hrefs()).toEqual(withTeam("t2"));
  });

  it("with two teams and no ?teamId (a direct entry): the remembered team the header shows", () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(screen.getByRole("button", { name: /current team Team Two/ })).toBeInTheDocument();
    expect(hrefs()).toEqual(withTeam("t2"));
  });

  it("with two teams, ?teamId naming none of them: the first team the header falls back to", () => {
    navState.search = "teamId=ghost";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(hrefs()).toEqual(withTeam("t1"));
  });

  it("on a route outside the sections (a project board): the team the header shows", () => {
    navState.pathname = "/projects/p1/board";
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(hrefs()).toEqual(withTeam("t2"));
  });

  it("follow a pick at once, while ?teamId still names the old team", () => {
    navState.pathname = "/settings";
    navState.search = "teamId=t1";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Team Two" }));
    expect(hrefs()).toEqual(withTeam("t2"));
  });

  it("stay bare with 0 teams", () => {
    render(<AppHeader user={USER} teams={[]} />);
    expect(hrefs()).toEqual(BARE);
  });

  it("stay bare while the team list is unknown (not loaded, or failed)", () => {
    const { rerender } = render(<AppHeader user={USER} />);
    expect(hrefs()).toEqual(BARE);
    rerender(<AppHeader user={USER} teams={null} />);
    expect(hrefs()).toEqual(BARE);
  });

  it("stay bare while the team list is unknown even when ?teamId names a team", () => {
    navState.search = "teamId=t1";
    render(<AppHeader user={USER} teams={null} />);
    expect(hrefs()).toEqual(BARE);
  });
});

describe("AppHeader team switcher", () => {
  it("is absent with 0 teams", () => {
    render(<AppHeader user={USER} teams={[]} />);
    expect(screen.queryByRole("button", { name: /Switch team/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Team One")).not.toBeInTheDocument();
    expect(document.querySelector(".app-team-label, .app-team-trigger")).toBeNull();
  });

  it("is absent while the team list is unknown (not loaded or failed)", () => {
    const { rerender } = render(<AppHeader user={USER} />);
    expect(document.querySelector(".app-team-label, .app-team-trigger")).toBeNull();
    rerender(<AppHeader user={USER} teams={null} />);
    expect(document.querySelector(".app-team-label, .app-team-trigger")).toBeNull();
  });

  it("is a static label, not a button, with 1 team", () => {
    render(<AppHeader user={USER} teams={[T1]} />);
    const label = document.querySelector(".app-team-label");
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain("Team One");
    expect(label?.tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: /Switch team/ })).not.toBeInTheDocument();
  });

  it("is a menu button with 2+ teams, listing every team with the current one checked", () => {
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(document.querySelector(".app-team-label")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Switch team, current team Team One" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Team One", "Team Two"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("ends the team menu with a + New team link to the create form", () => {
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch team, current team Team One" }));
    const link = within(screen.getByRole("menu", { name: "Teams" })).getByRole("menuitem", {
      name: "+ New team",
    });
    expect(link.getAttribute("href")).toBe("/onboarding?create=team");
  });

  it("follows the current-team rule: ?teamId, then the remembered team, then the first", () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    const { unmount } = render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(screen.getByRole("button", { name: /current team Team Two/ })).toBeInTheDocument();
    unmount();

    navState.search = "teamId=t1";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(screen.getByRole("button", { name: /current team Team One/ })).toBeInTheDocument();
  });

  it("Escape closes the menu", () => {
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
    const menu = screen.getByRole("menu", { name: "Teams" });
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Teams" })).not.toBeInTheDocument();
  });
});

describe("AppHeader team switch", () => {
  function pick(name: string) {
    fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name }));
  }

  it("remembers the team and updates the label", () => {
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    pick("Team Two");
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
    expect(screen.getByRole("button", { name: /current team Team Two/ })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Teams" })).not.toBeInTheDocument();
  });

  it("shows the picked team at once even while ?teamId still names the old one", () => {
    // router.push is mocked, so the URL keeps `teamId=t1` after the pick: the
    // label must follow the click, not wait for the URL.
    navState.search = "teamId=t1";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    pick("Team Two");
    expect(screen.getByRole("button", { name: /current team Team Two/ })).toBeInTheDocument();
  });

  it.each([
    ["/home", "/home?teamId=t2"],
    ["/tasks", "/tasks?teamId=t2"],
    ["/tasks/t-9", "/tasks?teamId=t2"],
    ["/projects", "/projects?teamId=t2"],
    ["/projects/p1/board", "/projects?teamId=t2"],
    ["/projects/p1/settings", "/projects?teamId=t2"],
    ["/settings/team", "/settings/team?teamId=t2"],
    ["/settings/team/sso", "/settings/team?teamId=t2"],
  ])("from %s navigates to %s", (pathname, target) => {
    navState.pathname = pathname;
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    pick("Team Two");
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith(target);
  });

  it("on personal settings it remembers the team but stays put", () => {
    navState.pathname = "/settings";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    pick("Team Two");
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBe("t2");
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /current team Team Two/ })).toBeInTheDocument();
  });

  it("picking the team the URL names does nothing", () => {
    navState.search = "teamId=t1";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    pick("Team One");
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("agent-tasks:lastTeamId")).toBeNull();
  });

  it("picking the team shown only through the fallback (no ?teamId) writes it to the URL", () => {
    // No ?teamId: the label shows the remembered team, but the URL names none,
    // so a pick of that team is a real switch, not a no-op.
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(screen.getByRole("button", { name: /current team Team Two/ })).toBeInTheDocument();
    pick("Team Two");
    expect(routerMocks.push).toHaveBeenCalledWith("/home?teamId=t2");
  });

  it("reads the remembered team once per URL, not on every render", () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t1");
    const teams = [T1, T2];
    const { rerender } = render(<AppHeader user={USER} teams={teams} />);
    expect(screen.getByRole("button", { name: /current team Team One/ })).toBeInTheDocument();
    // Another tab remembers t2; a re-render with the same URL and team list
    // keeps the label.
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    rerender(<AppHeader user={{ ...USER }} teams={teams} />);
    expect(screen.getByRole("button", { name: /current team Team One/ })).toBeInTheDocument();
  });

  it("returns focus to the switcher after a pick that stays on the page", () => {
    navState.pathname = "/settings";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    pick("Team Two");
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Switch team, current team Team Two/ }),
    );
  });

  it("returns focus to the switcher after a pick that navigates", () => {
    navState.pathname = "/home";
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    pick("Team Two");
    expect(routerMocks.push).toHaveBeenCalledWith("/home?teamId=t2");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Switch team/ }),
    );
  });

  it("opens with focus on the checked team, not the first item", async () => {
    window.localStorage.setItem("agent-tasks:lastTeamId", "t2");
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "Team Two" })),
    );
  });
});

describe("AppHeader team follows the URL", () => {
  it("a changed ?teamId (browser back/forward) replaces a switch held from an earlier pick", () => {
    navState.search = "teamId=t1";
    const { rerender } = render(<AppHeader user={USER} teams={[T1, T2]} />);
    fireEvent.click(screen.getByRole("button", { name: /Switch team/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Team Two" }));
    expect(screen.getByRole("button", { name: /current team Team Two/ })).toBeInTheDocument();

    // The URL moves back to t1 (the mocked router never moved it to t2).
    navState.search = "teamId=t2";
    rerender(<AppHeader user={USER} teams={[T1, T2]} />);
    navState.search = "teamId=t1";
    rerender(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(screen.getByRole("button", { name: /current team Team One/ })).toBeInTheDocument();
  });
});

describe("AppHeader avatar menu", () => {
  function openMenu() {
    fireEvent.click(screen.getByRole("button", { name: "Account menu for lan" }));
    return screen.getByRole("menu");
  }
  function entries(menu: HTMLElement) {
    return within(menu)
      .getAllByRole("menuitem")
      .map((el) => [el.textContent, el.getAttribute("href")]);
  }

  it("with a team: Settings, Team settings, New team, Logout (no Create a team)", () => {
    render(<AppHeader user={USER} teams={[T1]} />);
    const menu = openMenu();
    expect(entries(menu)).toEqual([
      ["Settings", "/settings"],
      ["Team settings", "/settings/team?teamId=t1"],
      ["New team", "/onboarding?create=team"],
      ["Logout", null],
    ]);
  });

  it("with 2 teams: same entries as with one", () => {
    render(<AppHeader user={USER} teams={[T1, T2]} />);
    expect(entries(openMenu()).map((e) => e[0])).toEqual(["Settings", "Team settings", "New team", "Logout"]);
  });

  it("with no team: Settings, Create a team (to /onboarding), Logout; no Team settings", () => {
    render(<AppHeader user={USER} teams={[]} />);
    const menu = openMenu();
    expect(entries(menu)).toEqual([
      ["Settings", "/settings"],
      ["Create a team", "/onboarding"],
      ["Logout", null],
    ]);
    expect(within(menu).queryByText("Team settings")).not.toBeInTheDocument();
  });

  it("with an unknown team list: neither Team settings nor Create a team", () => {
    render(<AppHeader user={USER} teams={null} />);
    expect(entries(openMenu()).map((e) => e[0])).toEqual(["Settings", "Logout"]);
  });

  it("opens with focus on the first item and Escape returns focus to the trigger", async () => {
    render(<AppHeader user={USER} teams={[T1]} />);
    const trigger = screen.getByRole("button", { name: "Account menu for lan" });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Settings"));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Team settings");

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
