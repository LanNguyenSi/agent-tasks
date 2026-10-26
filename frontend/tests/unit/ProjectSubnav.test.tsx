/** @vitest-environment jsdom */
/**
 * ProjectSubnav: the project hub tab row — Board, Members, Workflow,
 * Settings, the Overview tab having been dropped (the hub root redirects to
 * the board). Pins tab order, each tab's href, and which tab is marked
 * current for a given pathname.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const nav = vi.hoisted(() => ({ pathname: "/projects/p1/board" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}));

import ProjectSubnav from "../../src/components/projects/ProjectSubnav";

function renderAt(pathname: string) {
  nav.pathname = pathname;
  render(<ProjectSubnav projectId="p1" />);
  return within(screen.getByRole("navigation", { name: "Project sections" }));
}

function currentTabs(tabs: ReturnType<typeof renderAt>): string[] {
  return tabs
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent ?? "");
}

beforeEach(() => {
  nav.pathname = "/projects/p1/board";
});

describe("ProjectSubnav", () => {
  it("lists Board, Members, Workflow, Settings with their hub hrefs and no Overview", () => {
    const tabs = renderAt("/projects/p1/board");
    expect(
      tabs.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Board", "/projects/p1/board"],
      ["Members", "/projects/p1/members"],
      ["Workflow", "/projects/p1/workflow"],
      ["Settings", "/projects/p1/settings"],
    ]);
    expect(tabs.queryByText("Overview")).not.toBeInTheDocument();
  });

  it("marks only Board current on the board", () => {
    expect(currentTabs(renderAt("/projects/p1/board"))).toEqual(["Board"]);
  });

  it("marks no tab current on the hub root (it redirects to the board)", () => {
    expect(currentTabs(renderAt("/projects/p1"))).toEqual([]);
  });

  it("keeps a tab current on its nested routes", () => {
    expect(currentTabs(renderAt("/projects/p1/settings/advanced"))).toEqual(["Settings"]);
  });
});
