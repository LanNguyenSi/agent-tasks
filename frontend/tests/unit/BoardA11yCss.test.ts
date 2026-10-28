/**
 * Board rules in globals.css that jsdom cannot compute: the column heads stick
 * below the sticky bars at the widths where the page scrolls past them (and
 * only there), the small controls are at least 24px square (WCAG 2.5.8), the
 * card title button resets its chrome, and the skip link is off screen until
 * it has focus.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Declaration block of the top-level rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${esc(selector)}\\s*\\{([^}]*)\\}`, "g");
  const blocks = [...css.matchAll(re)].map((m) => m[1]!);
  expect(blocks.length, `rule ${selector} must exist`).toBeGreaterThan(0);
  return blocks.join("\n");
}

describe("secondary text tokens", () => {
  it("the disabled-menu-item reason and the page header summary use the secondary text colour, not the muted one", () => {
    expect(rule(".page-header-summary")).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(rule(".app-dropdown-item-reason")).toMatch(/color:\s*var\(--text-secondary\)/);
  });
});

/** Joined bodies of every media block that opens with `query`. */
function media(query: string): string {
  const header = `@media ${query} {`;
  const parts: string[] = [];
  for (let start = css.indexOf(header); start >= 0; start = css.indexOf(header, start + 1)) {
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) {
        parts.push(css.slice(start, i + 1));
        break;
      }
    }
  }
  expect(parts.length, `@media ${query} must exist`).toBeGreaterThan(0);
  return parts.join("\n");
}

/** The declaration block of `selector` inside a media body. */
function inMedia(body: string, selector: string): string {
  const m = new RegExp(`${esc(selector)}\\s*\\{([^}]*)\\}`).exec(body);
  expect(m, `${selector} inside the media block`).not.toBeNull();
  return m![1]!;
}

describe("sticky column heads", () => {
  it("stick below the sticky toolbar from 1280px", () => {
    const head = inMedia(media("(min-width: 1280px)"), ".db-col-head");
    expect(head).toMatch(/position:\s*sticky/);
    expect(head).toMatch(/top:\s*calc\(var\(--app-header-height\) \+ var\(--board-toolbar-height\)\)/);
  });

  it("stick below the sticky jump bar at the stacked widths (to 760px)", () => {
    const head = inMedia(media("(max-width: 760px)"), ".db-col-head");
    expect(head).toMatch(/position:\s*sticky/);
    expect(head).toMatch(/top:\s*calc\(var\(--app-header-height\) \+ var\(--board-jump-height\)\)/);
  });

  it("are not sticky in the base rule, so the widths between stay in the flow", () => {
    expect(rule(".db-col-head")).not.toMatch(/position:\s*sticky/);
  });

  it("paint over the cards that scroll under them", () => {
    expect(rule(".db-col-head")).toMatch(/background:\s*var\(--surface\)/);
    const head = inMedia(media("(min-width: 1280px)"), ".db-col-head");
    expect(head).toMatch(/z-index:\s*\d+/);
  });

  it("sit below the toolbar that sticks at the same widths (toolbar is the higher layer)", () => {
    const toolbarZ = Number(/z-index:\s*(\d+)/.exec(rule(".page-header"))![1]);
    const headZ = Number(/z-index:\s*(\d+)/.exec(inMedia(media("(min-width: 1280px)"), ".db-col-head"))![1]);
    expect(headZ).toBeLessThan(toolbarZ);
  });

  it("use toolbar and jump-bar heights that match the real bars", () => {
    expect(css).toMatch(/--board-toolbar-height:\s*52px/);
    // .page-header is min-height 52px, border-box; the jump bar is 32px chips
    // in two space-2 paddings plus a 1px border.
    expect(rule(".page-header")).toMatch(/min-height:\s*52px/);
    expect(css).toMatch(/--board-jump-height:\s*49px/);
  });
});

describe("equal column heads", () => {
  it("reserve a 24px slot for the + so heads with and without it are equally tall", () => {
    const add = rule(".db-col-add");
    expect(add).toMatch(/width:\s*24px/);
    expect(add).toMatch(/height:\s*24px/);
    expect(rule(".db-col-head")).toMatch(/min-height:\s*24px/);
  });
});

describe("24px targets (WCAG 2.5.8)", () => {
  it.each([
    [".db-card-avatar", /width:\s*24px[^}]*height:\s*24px|height:\s*24px[^}]*width:\s*24px/],
    [".td-label-remove", /width:\s*24px[^}]*height:\s*24px|height:\s*24px[^}]*width:\s*24px/],
    [".td-comment-actions .btn-link", /min-width:\s*24px[^}]*min-height:\s*24px|min-height:\s*24px[^}]*min-width:\s*24px/],
  ])("%s is at least 24px square", (selector, size) => {
    expect(rule(selector)).toMatch(size);
  });
});

describe("card title button", () => {
  it("drops the button chrome and keeps the two-line clamp", () => {
    const open = rule(".db-card-open");
    expect(open).toMatch(/border:\s*none/);
    expect(open).toMatch(/background:\s*transparent/);
    expect(open).toMatch(/-webkit-line-clamp:\s*2/);
  });

  it("shows a focus ring on the button and on its card", () => {
    expect(rule(".db-card-open:focus-visible")).toMatch(/outline:\s*2px solid var\(--primary\)/);
    expect(rule(".db-card:has(.db-card-open:focus-visible)")).toMatch(/border-color:\s*var\(--primary\)/);
  });
});

describe("skip target", () => {
  it("lands clear of the sticky bars and shows no ring for the programmatic focus", () => {
    expect(rule(".db-board-region")).toMatch(/scroll-margin-top:\s*calc\(/);
    expect(rule(".db-board-region:focus")).toMatch(/outline:\s*none/);
  });
});

describe("label chip rows", () => {
  it("keeps 8px between wrapped rows of 24px remove targets, and the 4px column gap", () => {
    const list = rule(".td-labels-list");
    expect(list).toMatch(/row-gap:\s*8px/);
    expect(list).toMatch(/(^|[\s;])gap:\s*var\(--space-1\)/);
  });
});

describe("skip link", () => {
  it("is off screen until focused, then fixed above the sticky bars", () => {
    expect(rule(".skip-link")).toMatch(/left:\s*-9999px/);
    const focused = rule(".skip-link:focus");
    expect(focused).toMatch(/position:\s*fixed/);
    expect(Number(/z-index:\s*(\d+)/.exec(focused)![1])).toBeGreaterThan(40);
  });
});
