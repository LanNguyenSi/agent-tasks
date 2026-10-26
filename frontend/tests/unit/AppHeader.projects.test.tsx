/** @vitest-environment jsdom */
/**
 * AppHeader Projects nav item: it links to `/projects` and is current on the
 * list page (with or without ?teamId) and on every `/projects/<id>/...` hub
 * route (the board included), and on no other route. The rest of the header
 * (nav labels, switcher, avatar menu) is in AppHeader.test.tsx. Mock pattern
 * mirrors the other header-adjacent tests.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const navState = vi.hoisted(() => ({ pathname: "/", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navState.search),
}));

import AppHeader from "../../src/components/AppHeader";

const USER = { login: "lan", avatarUrl: null };

function navHref(name: string): string {
  const links = screen.getAllByRole("link", { name });
  return links[0].getAttribute("href") ?? "";
}

afterEach(() => {
  cleanup();
  navState.search = "";
});

describe("AppHeader Projects nav", () => {
  it("links to /projects and is current on the list page (query not part of pathname)", () => {
    // usePathname() reports `/projects` for `/projects` and for
    // `/projects?teamId=t1` alike; the query case needs no extra row.
    navState.pathname = "/projects";
    render(<AppHeader user={USER} />);
    const link = screen.getAllByRole("link", { name: "Projects" })[0];
    expect(link.getAttribute("href")).toBe("/projects");
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("is current on the /projects/<id>/... hub routes, the board included", () => {
    for (const pathname of ["/projects/p1/board", "/projects/p1/members", "/projects/p1/settings"]) {
      navState.pathname = pathname;
      const { unmount } = render(<AppHeader user={USER} />);
      const link = screen.getAllByRole("link", { name: "Projects" })[0];
      expect(link.getAttribute("aria-current"), pathname).toBe("page");
      unmount();
    }
  });

  it("is not current on other routes and does not point at legacy /teams", () => {
    navState.pathname = "/tasks";
    render(<AppHeader user={USER} />);
    const link = screen.getAllByRole("link", { name: "Projects" })[0];
    expect(link.hasAttribute("aria-current")).toBe(false);
    expect(navHref("Projects")).not.toBe("/teams");
  });
});

describe("AppHeader on /tasks/[id] opened from the board", () => {
  function current(name: string): boolean {
    return screen.getAllByRole("link", { name })[0].getAttribute("aria-current") === "page";
  }

  it("keeps Projects current and not Tasks for ?from=board", () => {
    navState.pathname = "/tasks/t1";
    navState.search = "from=board";
    render(<AppHeader user={USER} />);
    expect(current("Projects")).toBe(true);
    expect(current("Tasks")).toBe(false);
  });

  it("keeps Tasks current for a bare visit and for a list-URL from", () => {
    navState.pathname = "/tasks/t1";
    for (const search of ["", "from=%2Ftasks%3Fscope%3Dopen"]) {
      navState.search = search;
      const { unmount } = render(<AppHeader user={USER} />);
      expect(current("Tasks"), search).toBe(true);
      expect(current("Projects"), search).toBe(false);
      unmount();
    }
  });

  it("ignores from=board on the /tasks list itself and on a repeated from", () => {
    navState.pathname = "/tasks";
    navState.search = "from=board";
    const first = render(<AppHeader user={USER} />);
    expect(current("Tasks")).toBe(true);
    first.unmount();
    navState.pathname = "/tasks/t1";
    navState.search = "from=board&from=board";
    render(<AppHeader user={USER} />);
    expect(current("Tasks")).toBe(true);
  });
});
