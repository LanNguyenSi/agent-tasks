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

  it("stay in the flow inside a .db-board--scroll board at 1280px and above", () => {
    // The board's overflow-x makes the board the sticky scrollport (overflow-y
    // computes to auto), so the sticky top would be measured from the board's
    // own top edge and push each head down into its column, over the first
    // card. Static keeps the heads in the flow, as in the 761-1279px band.
    const scrollHead = inMedia(media("(min-width: 1280px)"), ".db-board--scroll .db-col-head");
    expect(scrollHead).toMatch(/position:\s*static/);
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

describe("column count drives the grid", () => {
  it("takes the wide-desktop column count from the inline --db-cols, never from a hard-coded repeat(5, ...)", () => {
    const board = rule(".db-board");
    expect(board).toMatch(/grid-template-columns:\s*repeat\(var\(--db-cols,\s*5\),\s*minmax\(0,\s*1fr\)\)/);
    expect(board).not.toMatch(/repeat\(5,/);
  });

  it("keeps one scrollable row with a readable minimum column in the 761-1279px band", () => {
    const band = inMedia(media("(max-width: 1279px) and (min-width: 761px)"), ".db-board");
    expect(band).toMatch(/grid-auto-flow:\s*column/);
    expect(band).toMatch(/grid-auto-columns:\s*minmax\(240px,\s*1fr\)/);
    expect(band).toMatch(/overflow-x:\s*auto/);
    // The count-driven template must not survive into the band: with
    // grid-auto-flow the columns follow, never wrap 4+3.
    expect(band).toMatch(/grid-template-columns:\s*none/);
  });

  it("stacks every column full-width at the mobile width", () => {
    const mobile = inMedia(media("(max-width: 760px)"), ".db-board");
    expect(mobile).toMatch(/grid-template-columns:\s*1fr/);
  });

  it("gives a wider board the same readable minimum column and horizontal scroll at 1280px and above", () => {
    // The board writes .db-board--scroll once it has more columns than the
    // built-in five; the equal-column minmax(0, 1fr) would take a ten-column
    // board to 128px at 1440px.
    const wide = inMedia(media("(min-width: 1280px)"), ".db-board--scroll");
    expect(wide).toMatch(/grid-template-columns:\s*none/);
    expect(wide).toMatch(/grid-auto-flow:\s*column/);
    expect(wide).toMatch(/grid-auto-columns:\s*minmax\(240px,\s*1fr\)/);
    expect(wide).toMatch(/overflow-x:\s*auto/);
  });

  it("keeps the scrolled wide board on the class alone, never on the plain .db-board rule of that width", () => {
    // Five built-in columns at 1280px are 236px each and must stay exactly as
    // they are: no media rule may touch the plain .db-board at the wide width.
    const wideBody = media("(min-width: 1280px)");
    expect(wideBody).not.toMatch(/(?:^|\n)\s*\.db-board\s*\{/);
    expect(rule(".db-board")).toMatch(/grid-template-columns:\s*repeat\(var\(--db-cols,\s*5\),\s*minmax\(0,\s*1fr\)\)/);
  });
});

describe("custom column dot", () => {
  it("paints the neutral open colour, so a custom head never leaves an empty 8px gap", () => {
    expect(rule(".db-col--custom .db-col-dot")).toMatch(/background:\s*var\(--status-open\)/);
  });

  it("declares the built-in state colours after it, so an extra column of a built-in name keeps its own", () => {
    const neutral = css.indexOf(".db-col--custom .db-col-dot");
    const inProgress = css.indexOf(".db-col--in-progress .db-col-dot");
    expect(neutral).toBeGreaterThan(-1);
    expect(inProgress).toBeGreaterThan(neutral);
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
