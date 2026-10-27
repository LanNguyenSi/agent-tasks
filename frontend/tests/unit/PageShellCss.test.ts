/**
 * Page gutter, page column and header-nav tokens (globals.css): one
 * --page-gutter (24px, 12px under 600px) feeds every band that must share the
 * page's left edge, --page-column (per PageShell variant, on <main>) centres
 * the column and the bands' inner content on max(gutter, (width - column) / 2),
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

  it("takes the first project tab's own padding out of the subnav column edge", () => {
    expect(rule(".proj-subnav")).toMatch(
      /padding:\s*0 max\(calc\(var\(--page-gutter\) - var\(--space-3\)\), calc\(\(100% - var\(--page-column, 100%\)\) \/ 2 - var\(--space-3\)\)\)\s*;/,
    );
  });
});

describe("--page-column per PageShell variant", () => {
  it.each([
    [".pshell--default", "1200px"],
    [".pshell--wide", "100%"],
  ])("%s sets the column to %s on <main>", (selector, column) => {
    expect(rule(selector)).toMatch(new RegExp(`--page-column:\\s*${column}\\s*;`));
  });

  it("has no variant without a column", () => {
    expect(css).not.toMatch(/\.pshell-content--narrow|\.pshell-content--centered|\.pshell--narrow/);
  });
});

describe("bands align their inner content to the page column", () => {
  // Full-width background and border stay on the band; only the side padding
  // follows the column. 100% resolves against <main>, so the bands must be
  // direct children of it (the board and tasks toolbars sit in a wide slot,
  // where the column is the whole width and the formula collapses to the gutter).
  const formula = "max\\(var\\(--page-gutter\\), calc\\(\\(100% - var\\(--page-column, 100%\\)\\) \\/ 2\\)\\)";

  it.each([".page-header", ".tasks-skeleton-header"])("%s pads both sides with the column formula", (selector) => {
    expect(rule(selector)).toMatch(new RegExp(`padding:\\s*var\\(--space-\\d\\) ${formula}\\s*;`));
  });

  it(".proj-hub-header pads both sides with the column formula", () => {
    expect(rule(".proj-hub-header")).toMatch(new RegExp(`padding:\\s*var\\(--space-4\\) ${formula} 0\\s*;`));
  });

  it("no band caps its own width (the border must span the viewport)", () => {
    for (const selector of [".page-header", ".tasks-skeleton-header", ".proj-hub-header", ".proj-subnav"]) {
      expect(rule(selector), selector).not.toMatch(/max-width|margin-(?:left|right|inline)/);
    }
  });
});

describe("PageShell variants and frame", () => {
  it.each([
    [".pshell-content--default", /max-width:\s*calc\(1200px \+ 2 \* var\(--page-gutter\)\)/],
    [".pshell-content--wide", /max-width:\s*none\b/],
  ])("%s caps the content width as documented", (selector, cap) => {
    expect(rule(selector)).toMatch(cap);
  });

  it("centres the content slot with auto side margins; flush drops the slot padding", () => {
    expect(rule(".pshell-content")).toMatch(/margin-inline:\s*auto\s*;/);
    expect(rule(".pshell-content--flush")).toMatch(/padding:\s*0\s*;/);
    for (const v of ["default", "wide"]) {
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
  const padding = (selector: string) => rule(selector).match(/(?:^|[\s;])padding:\s*([^;]+);/)?.[1];

  it.each([".td-loading-wrap", ".td-error-wrap"])("%s uses the same frame as .td-page", (selector) => {
    expect(padding(".td-page")).toBeTruthy();
    expect(padding(selector)).toEqual(padding(".td-page"));
  });

  it.each([".td-page", ".td-loading-wrap", ".td-error-wrap"])(
    "%s neither caps nor positions itself (the shell's centred default column does)",
    (selector) => {
      expect(rule(selector)).not.toMatch(/max-width|margin/);
    },
  );

  it("the page frame takes its side padding from the page gutter and has no bottom padding", () => {
    expect(padding(".td-page")).toBe("var(--space-5) var(--page-gutter) 0");
  });

  it("the skeleton neither caps nor centres itself inside the wrapper", () => {
    const body = rule(".td-skeleton");
    expect(body).not.toMatch(/max-width/);
    expect(body).not.toMatch(/margin/);
  });
});

describe("offsets below the app header", () => {
  it("use the header height token, not a 48px literal", () => {
    expect(rule(".page-header")).toMatch(/top:\s*var\(--app-header-height\)/);
    expect(rule(".settings-side-nav")).toMatch(/top:\s*calc\(var\(--app-header-height\) \+ var\(--space-4\)\)/);
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

describe("SSO page column", () => {
  it("keeps the form and text at a 760px reading width inside the default column", () => {
    expect(rule(".sso-content > *")).toMatch(/max-width:\s*760px\s*;/);
  });
});
