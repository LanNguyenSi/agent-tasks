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

describe("PageShell variants and frame", () => {
  it.each([
    [".pshell-content--default", /max-width:\s*calc\(1200px \+ 2 \* var\(--page-gutter\)\)/],
    [".pshell-content--narrow", /max-width:\s*calc\(760px \+ 2 \* var\(--page-gutter\)\)/],
    [".pshell-content--wide", /max-width:\s*none\b/],
  ])("%s caps the content width as documented", (selector, cap) => {
    expect(rule(selector)).toMatch(cap);
  });

  it("flush drops the slot padding, centered only adds auto side margins", () => {
    expect(rule(".pshell-content--flush")).toMatch(/padding:\s*0\s*;/);
    expect(rule(".pshell-content--centered")).toMatch(/margin-left:\s*auto/);
    expect(rule(".pshell-content--centered")).toMatch(/margin-right:\s*auto/);
    for (const v of ["default", "narrow", "wide"]) {
      expect(rule(`.pshell-content--${v}`)).not.toMatch(/margin/);
    }
  });

  it("fills the viewport below the sticky app header, not the whole viewport", () => {
    expect(rule(":root")).toMatch(/--app-header-height:\s*48px/);
    expect(rule(".app-header")).toMatch(/height:\s*var\(--app-header-height\)/);
    const min = rule(".pshell").match(/min-height:\s*([^;]+);/)?.[1];
    expect(min).toBe("calc(100vh - var(--app-header-height))");
  });
});

describe("task detail loading and error frames", () => {
  const frame = (selector: string) => {
    const body = rule(selector);
    return ["max-width", "margin", "padding"].map((prop) => body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+);`))?.[1]);
  };

  it.each([".td-loading-wrap", ".td-error-wrap"])("%s uses the same frame as .td-page", (selector) => {
    const page = frame(".td-page");
    expect(page.every(Boolean)).toBe(true);
    expect(frame(selector)).toEqual(page);
  });

  it("the page frame is left-aligned with the page gutter", () => {
    const [maxWidth, margin, padding] = frame(".td-page");
    expect(maxWidth).toBe("calc(1200px + 2 * var(--page-gutter))");
    expect(margin).toBe("0");
    expect(padding).toMatch(/var\(--page-gutter\)/);
  });

  it("the skeleton neither caps nor centres itself inside the wrapper", () => {
    const body = rule(".td-skeleton");
    expect(body).not.toMatch(/max-width/);
    expect(body).not.toMatch(/margin/);
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
