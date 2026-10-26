/**
 * Page gutter and header-nav tokens (globals.css): one --page-gutter (24px,
 * 12px under 600px) feeds every band that must share the page's left edge,
 * and the active top-nav link uses a theme token that exists in both themes
 * instead of a white-alpha mix (invisible on the light header).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");

/** The declaration blocks of every rule whose selector is exactly `selector`, joined. */
function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const blocks = [...css.matchAll(re)].map((m) => m[1]!);
  expect(blocks.length, `rule ${selector} must exist`).toBeGreaterThan(0);
  return blocks.join("\n");
}

describe("--page-gutter", () => {
  it("is 24px by default and 12px under 600px", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--page-gutter:\s*24px/);
    expect(css).toMatch(/@media \(max-width: 600px\)\s*\{\s*:root\s*\{\s*--page-gutter:\s*12px/);
  });

  it.each([".app-header-inner", ".page-header", ".proj-hub-header", ".db-board", ".tasks-content", ".td-page", ".pshell-content"])(
    "%s takes its side padding from the token",
    (selector) => {
      expect(rule(selector)).toMatch(/padding:[^;]*var\(--page-gutter\)/);
    },
  );

  it("takes the first project tab's own padding out of the subnav gutter", () => {
    expect(rule(".proj-subnav")).toMatch(/padding:\s*0 calc\(var\(--page-gutter\) - var\(--space-3\)\)/);
  });
});

describe("header nav states", () => {
  it("styles the active link with --surface-active, defined in both themes", () => {
    const active = rule('.app-nav-link[aria-current="page"]');
    expect(active).toMatch(/background:\s*var\(--surface-active\)/);
    expect(active).not.toMatch(/white/);
    expect(rule(".app-nav-link:hover")).not.toMatch(/white/);
    expect(rule(":root")).toMatch(/--surface-active:/);
    expect(rule('html[data-theme="light"]')).toMatch(/--surface-active:/);
  });
});
