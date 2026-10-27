/**
 * One section-heading scale (globals.css): Home widgets, settings sections,
 * hub tabs and task detail sections take their size and weight from the
 * --heading-section-* tokens, and the task-detail breadcrumb matches the
 * project breadcrumb. The project settings measure and the retired redirect
 * box are pinned too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");

function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const blocks = [...css.matchAll(re)].map((m) => m[1]!);
  expect(blocks.length, `rule ${selector} must exist`).toBeGreaterThan(0);
  return blocks.join("\n");
}

describe("section heading tokens", () => {
  it("are defined on :root as 14px / 600", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--heading-section-size:\s*var\(--text-md\)/);
    expect(css).toMatch(/:root\s*\{[^}]*--heading-section-weight:\s*600/);
  });

  it.each([
    ".home-widget-title",
    ".home-projects-title",
    ".settings-section-heading",
    ".mem-section-heading",
    ".proj-section-head",
    ".wf-table-title",
    ".wf-gate-ref-title",
    ".td-section-title",
  ])("%s uses the tokens, no literal size or weight", (selector) => {
    const body = rule(selector);
    expect(body).toMatch(/font-size:\s*var\(--heading-section-size\)/);
    expect(body).toMatch(/font-weight:\s*var\(--heading-section-weight\)/);
  });
});

describe("breadcrumbs", () => {
  it("the task-detail breadcrumb has the project breadcrumb's size and gap", () => {
    const hub = rule(".proj-hub-breadcrumb");
    const td = rule(".td-breadcrumb");
    const size = (b: string) => /font-size:\s*([^;]+);/.exec(b)![1];
    const gap = (b: string) => /gap:\s*([^;]+);/.exec(b)![1];
    expect(size(td)).toBe(size(hub));
    expect(gap(td)).toBe(gap(hub));
  });
});

describe("leftover frame rules", () => {
  it("project settings measure is 760px", () => {
    expect(rule(".proj-settings-measure")).toMatch(/max-width:\s*760px/);
  });

  it("the centred redirect box is gone", () => {
    expect(css).not.toMatch(/\.wf-redirect-shell/);
  });
});
