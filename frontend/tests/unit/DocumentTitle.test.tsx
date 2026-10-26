/** @vitest-environment jsdom */
/**
 * Browser tab titles: one mechanism (components/DocumentTitle.tsx), the
 * format "<title> - agent-tasks", and the segment layouts that name the
 * static pages. A layout's title applies only on its exact path so a deeper
 * page keeps its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({ pathname: "/", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import DocumentTitle, { formatDocumentTitle } from "../../src/components/DocumentTitle";
import HomeLayout from "../../src/app/home/layout";
import TasksLayout from "../../src/app/tasks/layout";
import SettingsLayout from "../../src/app/settings/layout";
import TeamSettingsLayout from "../../src/app/settings/team/layout";
import ProjectsLayout from "../../src/app/projects/layout";
import { metadata as homeMeta } from "../../src/app/home/layout";
import { metadata as tasksMeta } from "../../src/app/tasks/layout";
import { metadata as settingsMeta } from "../../src/app/settings/layout";
import { metadata as teamMeta } from "../../src/app/settings/team/layout";
import { metadata as ssoMeta } from "../../src/app/settings/team/sso/layout";
import { metadata as projectsMeta } from "../../src/app/projects/layout";
import { metadata as workflowMeta } from "../../src/app/projects/workflow/layout";

beforeEach(() => {
  document.title = "stale";
  nav.pathname = "/";
  nav.search = "";
});
afterEach(cleanup);

describe("formatDocumentTitle", () => {
  it("appends the product name", () => {
    expect(formatDocumentTitle("Tasks")).toBe("Tasks - agent-tasks");
  });
  it("falls back to the bare product name for an empty title", () => {
    expect(formatDocumentTitle("")).toBe("agent-tasks");
    expect(formatDocumentTitle("  ")).toBe("agent-tasks");
    expect(formatDocumentTitle(null)).toBe("agent-tasks");
  });
});

describe("<DocumentTitle>", () => {
  it("sets and updates the tab title", () => {
    const { rerender } = render(<DocumentTitle title="Fix the bug" />);
    expect(document.title).toBe("Fix the bug - agent-tasks");
    rerender(<DocumentTitle title="Other" />);
    expect(document.title).toBe("Other - agent-tasks");
  });

  it("sets the title again after a navigation that only changes the query", () => {
    const { rerender } = render(<DocumentTitle title="Board" />);
    expect(document.title).toBe("Board - agent-tasks");
    // The router re-applies the server-rendered segment title on a
    // query-only replace; the props of <DocumentTitle> do not change.
    document.title = "Projects - agent-tasks";
    nav.search = "taskId=t1";
    rerender(<DocumentTitle title="Board" />);
    expect(document.title).toBe("Board - agent-tasks");
    document.title = "Projects - agent-tasks";
    nav.search = "";
    rerender(<DocumentTitle title="Board" />);
    expect(document.title).toBe("Board - agent-tasks");
  });

  it("undoes a framework title reset while mounted on its own route", async () => {
    nav.pathname = "/projects/p1/board";
    window.history.replaceState({}, "", "/projects/p1/board");
    render(<DocumentTitle title="Board" />);
    expect(document.title).toBe("Board - agent-tasks");
    document.title = "Projects - agent-tasks";
    await waitFor(() => expect(document.title).toBe("Board - agent-tasks"));
  });

  it("does not fight a title change once the page has left its route, or after unmount", async () => {
    nav.pathname = "/projects/p1/board";
    window.history.replaceState({}, "", "/projects/p1/board");
    const view = render(<DocumentTitle title="Board" />);
    window.history.replaceState({}, "", "/tasks/t1");
    document.title = "Tasks - agent-tasks";
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.title).toBe("Tasks - agent-tasks");

    window.history.replaceState({}, "", "/projects/p1/board");
    view.unmount();
    document.title = "after unmount";
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.title).toBe("after unmount");
  });

  it("sets the title again after a pathname change with the same props", () => {
    const { rerender } = render(<DocumentTitle title="Board" />);
    document.title = "elsewhere";
    nav.pathname = "/projects/p1/board";
    rerender(<DocumentTitle title="Board" />);
    expect(document.title).toBe("Board - agent-tasks");
  });
});

describe("segment layout titles", () => {
  it.each([
    [HomeLayout, "/home", "Home - agent-tasks"],
    [TasksLayout, "/tasks", "Tasks - agent-tasks"],
    [SettingsLayout, "/settings", "Settings - agent-tasks"],
    [TeamSettingsLayout, "/settings/team", "Team settings - agent-tasks"],
    [TeamSettingsLayout, "/settings/team/sso", "Single sign-on - agent-tasks"],
    [ProjectsLayout, "/projects", "Projects - agent-tasks"],
  ])("%o on %s sets %s", (Layout, pathname, expected) => {
    nav.pathname = pathname;
    render(<Layout>{null}</Layout>);
    expect(document.title).toBe(expected);
  });

  it.each([
    [TasksLayout, "/tasks/t1"],
    [SettingsLayout, "/settings/team"],
    [ProjectsLayout, "/projects/p1/board"],
    [HomeLayout, "/home/anything"],
  ])("%o leaves the title of a deeper page %s alone", (Layout, pathname) => {
    nav.pathname = pathname;
    render(<Layout>{null}</Layout>);
    expect(document.title).toBe("stale");
  });
});

describe("server-rendered titles (segment metadata; the root layout's template adds the product name for first-level routes, nested ones carry it in `absolute`)", () => {
  it.each([
    [homeMeta, "Home"],
    [tasksMeta, "Tasks"],
    [settingsMeta, "Settings"],
    [teamMeta, { absolute: "Team settings - agent-tasks" }],
    [ssoMeta, { absolute: "Single sign-on - agent-tasks" }],
    [projectsMeta, "Projects"],
    [workflowMeta, { absolute: "Workflow - agent-tasks" }],
  ])("%o names the page %s", (meta, title) => {
    expect(meta.title).toEqual(title);
  });
});
