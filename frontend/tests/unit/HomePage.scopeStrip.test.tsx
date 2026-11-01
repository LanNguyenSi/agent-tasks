/** @vitest-environment jsdom */
/**
 * /home scope strip: one <nav aria-label="Task scopes"> with two groups
 * (filters: Mine, Priority; stages: Backlog, Active, In Review, Done) and
 * decorative chevrons between the stages. Pins group membership, link order,
 * hrefs, accessible names, separator semantics and the layout-deciding CSS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { User, Team, TeamTasksCounts } from "../../src/lib/api";

const routerMocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => routerMocks,
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("../../src/lib/api", () => ({
  getCurrentUser: vi.fn(),
  getTeams: vi.fn(),
  getTeamTasks: vi.fn(),
}));

import HomeDashboardPageRaw from "../../src/app/home/page";
import { withTeamList } from "./helpers/withTeamList";
const HomeDashboardPage = withTeamList(HomeDashboardPageRaw);
import { getCurrentUser, getTeams, getTeamTasks } from "../../src/lib/api";

const user: User = {
  id: "u-1",
  login: "lan",
  name: "Lan",
  avatarUrl: null,
  email: "lan@example.com",
  githubConnected: false,
  allowAgentPrCreate: false,
  allowAgentPrMerge: false,
  allowAgentPrComment: false,
};
const team: Team = {
  id: "team-1",
  name: "Pandora",
  slug: "pandora",
  role: "ADMIN",
  createdAt: "2026-01-01T00:00:00Z",
};
const counts: TeamTasksCounts = {
  open: 6,
  review: 5,
  done: 4,
  doneRecent: 4,
  priority: 8,
  mine: 2,
  backlog: 7,
  total: 30,
};

async function renderStrip(): Promise<HTMLElement> {
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  vi.mocked(getTeams).mockResolvedValue([team]);
  vi.mocked(getTeamTasks).mockResolvedValue({ tasks: [], projects: [], counts });
  render(<HomeDashboardPage />);
  return vi.waitFor(() => {
    const nav = screen.getByRole("navigation", { name: "Task scopes" });
    expect(nav.querySelector('a[href*="scope=done"]')).not.toBeNull();
    return nav;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

const names = (root: Element) =>
  Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("aria-label"));

describe("home scope strip", () => {
  it("is one nav with exactly six links in D1 order and the same hrefs", async () => {
    const nav = await renderStrip();
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/tasks?teamId=team-1&scope=mine",
      "/tasks?teamId=team-1&scope=priority",
      "/tasks?teamId=team-1&status=backlog",
      // The Active link carries the explicit status list (the workflow-derived
      // active names; the built-in pair while no custom workflow is loaded).
      "/tasks?teamId=team-1&scope=open&status=open,in_progress",
      "/tasks?teamId=team-1&scope=review",
      "/tasks?teamId=team-1&scope=done",
    ]);
  });

  it("names every link '<n> <label>' (Active = open + in progress)", async () => {
    const nav = await renderStrip();
    expect(names(nav)).toEqual([
      "2 Mine",
      "8 Priority",
      "7 Backlog",
      "6 Active",
      "5 In Review",
      "4 Done · 14 days",
    ]);
  });

  it("puts Mine and Priority in the filters group and the four stages in the stages group", async () => {
    const nav = await renderStrip();
    const filters = nav.querySelector(".home-scopes-group--filters")!;
    const stages = nav.querySelector(".home-scopes-group--stages")!;
    expect(names(filters)).toEqual(["2 Mine", "8 Priority"]);
    expect(names(stages)).toEqual(["7 Backlog", "6 Active", "5 In Review", "4 Done · 14 days"]);
    // Group order in the DOM: filters first, then stages.
    expect(filters.compareDocumentPosition(stages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("joins the stages with three aria-hidden chevrons that are not links and none in the filters group", async () => {
    const nav = await renderStrip();
    const seps = Array.from(nav.querySelectorAll(".home-scopes-sep"));
    expect(seps).toHaveLength(3);
    for (const sep of seps) {
      expect(sep.getAttribute("aria-hidden")).toBe("true");
      expect(sep.closest("a")).toBeNull();
      expect(sep.textContent).toBe("›");
      expect(sep.closest(".home-scopes-group--stages")).not.toBeNull();
    }
    expect(nav.querySelectorAll(".home-scopes-group--filters .home-scopes-sep")).toHaveLength(0);
  });

  it("alternates link and chevron in the stage group, so a chevron never leads or trails", async () => {
    const nav = await renderStrip();
    const kids = Array.from(nav.querySelector(".home-scopes-group--stages")!.children).map((el) =>
      el.tagName === "A" ? "link" : "sep",
    );
    expect(kids).toEqual(["link", "sep", "link", "sep", "link", "sep", "link"]);
  });

  it("renders the number before the label inside each link", async () => {
    const nav = await renderStrip();
    for (const a of Array.from(nav.querySelectorAll("a"))) {
      const [first, second] = Array.from(a.children);
      expect(first!.className).toContain("home-scope-num");
      expect(second!.className).toContain("home-scope-label");
    }
  });
});

describe("home scope strip styles", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/app/globals.css"),
    "utf8",
  );
  const rule = (selector: string): string => {
    const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
    const blocks = [...css.matchAll(re)].map((m) => m[1]!);
    expect(blocks.length, `rule ${selector} must exist`).toBeGreaterThan(0);
    return blocks.join("\n");
  };

  it("the old tile and strip classes are gone", () => {
    expect(css).not.toMatch(/\.home-stat-(tile|strip)\b/);
  });

  it("the number is 16px/600 and the link keeps a 28px target", () => {
    expect(rule(".home-scope-num")).toMatch(/font-size:\s*var\(--text-lg\)/);
    expect(rule(".home-scope-num")).toMatch(/font-weight:\s*600/);
    expect(rule(".home-scope-link")).toMatch(/min-height:\s*28px/);
  });

  it("a vertical hairline separates the stage group; no box, border or background on the link", () => {
    expect(rule(".home-scopes-group--stages")).toMatch(/border-left:\s*1px solid/);
    const link = rule(".home-scope-link");
    expect(link).not.toMatch(/background|border:|box-shadow/);
  });

  it("below 560px the groups stack and the stage line spreads over the width", () => {
    const start = css.indexOf("@media (max-width: 559px) {\n  .home-scopes {");
    expect(start).toBeGreaterThan(0);
    const block = css.slice(start, css.indexOf("\n}\n\n", css.indexOf(".home-scopes-group--stages", start)));
    expect(block).toMatch(/\.home-scopes \{[^}]*flex-direction:\s*column/);
    expect(block).toMatch(/\.home-scopes-group--stages \{[^}]*justify-content:\s*space-between/);
    expect(block).toMatch(/\.home-scopes-group--stages \{[^}]*flex-wrap:\s*wrap/);
    expect(block).toMatch(/border-left:\s*0/);
    expect(block).toMatch(/border-top:\s*1px solid/);
  });
});
