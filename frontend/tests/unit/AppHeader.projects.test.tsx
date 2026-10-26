/** @vitest-environment jsdom */
/**
 * AppHeader nav active-state (T10): the Projects nav item is current
 * exactly on `/projects` (the list page, with or without ?teamId) and on
 * no other route -- notably not on the `/projects/<id>/...` hub tabs,
 * where nothing was current before the route move either (the old check
 * matched `/teams`). Mock pattern mirrors the other header-adjacent tests.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const navState = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import AppHeader from "../../src/components/AppHeader";

const USER = { login: "lan", avatarUrl: null };

function navHref(name: string): string {
  const links = screen.getAllByRole("link", { name });
  return links[0].getAttribute("href") ?? "";
}

afterEach(() => cleanup());

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

  it("is not current on the /projects/<id>/... hub tabs", () => {
    navState.pathname = "/projects/p1/board";
    render(<AppHeader user={USER} />);
    const link = screen.getAllByRole("link", { name: "Projects" })[0];
    expect(link.hasAttribute("aria-current")).toBe(false);
  });

  it("is not current on other routes and does not point at legacy /teams", () => {
    navState.pathname = "/tasks";
    render(<AppHeader user={USER} />);
    const link = screen.getAllByRole("link", { name: "Projects" })[0];
    expect(link.hasAttribute("aria-current")).toBe(false);
    expect(navHref("Projects")).not.toBe("/teams");
  });
});
