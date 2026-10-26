/**
 * Narrow-screen layout rules (globals.css): the 420px overrides must come
 * after the base rules they override (an override placed earlier never
 * applies), the bands that share the page's left edge take their side padding
 * from --page-gutter, long unbroken text wraps instead of widening the page,
 * the scope tabs scroll inside their own strip, and the board column jump bar
 * exists only below 640px.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Declaration blocks of every top-level rule whose selector is exactly `selector`, with offsets. */
function topRules(selector: string): { body: string; at: number }[] {
  const re = new RegExp(`(?:^|\\n)${esc(selector)}\\s*\\{([^}]*)\\}`, "g");
  return [...css.matchAll(re)].map((m) => ({ body: m[1]!, at: m.index! }));
}

function rule(selector: string): string {
  const blocks = topRules(selector);
  expect(blocks.length, `rule ${selector} must exist`).toBeGreaterThan(0);
  return blocks.map((b) => b.body).join("\n");
}

/** Every media block that opens with `query`: joined bodies, and the offset of the last one. */
function media(query: string): { body: string; at: number } {
  const header = `@media ${query} {`;
  const parts: string[] = [];
  let at = -1;
  for (let start = css.indexOf(header); start >= 0; start = css.indexOf(header, start + 1)) {
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) {
        parts.push(css.slice(start, i + 1));
        break;
      }
    }
    at = start;
  }
  expect(parts.length, `@media ${query} must exist`).toBeGreaterThan(0);
  return { body: parts.join("\n"), at };
}

describe("max-width 420px overrides", () => {
  const block = media("(max-width: 420px)");

  it.each([".td-page", ".tasks-content", ".db-board", ".db-list-wrap", ".db-state-wrap", ".td-head-row", ".td-head-right"])(
    "%s override comes after its base rule",
    (selector) => {
      const bases = topRules(selector);
      expect(bases.length).toBeGreaterThan(0);
      for (const base of bases) expect(block.at).toBeGreaterThan(base.at);
      expect(block.body).toContain(`${selector} {`);
    },
  );

  it.each([".td-page", ".tasks-content", ".db-board", ".db-list-wrap", ".db-state-wrap"])(
    "%s keeps its side padding on the page gutter",
    (selector) => {
      const m = new RegExp(`${esc(selector)} \\{\\s*padding:([^;]*);`).exec(block.body);
      expect(m, `padding in override for ${selector}`).not.toBeNull();
      expect(m![1]).toMatch(/var\(--page-gutter\)/);
    },
  );
});

describe("bands that share the page's left edge", () => {
  it.each([".db-filter-bar", ".db-list-wrap", ".db-access-banner", ".db-status-summary", ".db-state-wrap"])(
    "%s takes its side padding from the gutter token",
    (selector) => {
      expect(rule(selector)).toMatch(/padding:[^;]*var\(--page-gutter\)/);
      expect(rule(selector)).not.toMatch(/padding:[^;]*var\(--space-5\)/);
    },
  );

  it("the header override under 520px keeps the gutter token", () => {
    expect(media("(max-width: 520px)").body).toMatch(/\.app-header-inner \{\s*padding:\s*0 var\(--page-gutter\)/);
  });
});

describe("no sideways scroll from long content", () => {
  it("markdown and comment bodies wrap anywhere", () => {
    expect(rule(".prose-markdown")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".td-comment-body")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("single-column grids use minmax(0, 1fr) so a child cannot widen the track", () => {
    expect(media("(max-width: 900px)").body).toMatch(/\.td-layout \{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(media("(max-width: 1100px)").body).toMatch(/\.task-detail-grid \{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it("scope tabs scroll inside their strip and keep each tab on one line", () => {
    expect(rule(".tasks-scope-tabs")).toMatch(/max-width:\s*100%/);
    expect(rule(".tasks-scope-tabs")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".tasks-scope-tabs .tabs-tab")).toMatch(/flex-shrink:\s*0/);
  });
});

describe("board column jump bar", () => {
  it("is hidden by default and shown only under 640px", () => {
    expect(rule(".db-jump")).toMatch(/display:\s*none/);
    const narrow = media("(max-width: 639px)");
    expect(narrow.body).toMatch(/\.db-jump \{[^}]*display:\s*flex/);
    expect(narrow.body).toMatch(/\.db-jump \{[^}]*position:\s*sticky/);
    // The sticky toolbar would cover the bar, so it scrolls away when stacked.
    expect(narrow.body).toMatch(/\.db-toolbar \{\s*position:\s*static/);
  });

  it("sticks right below the app header, and a jumped-to column lands below both bars", () => {
    const narrow = media("(max-width: 639px)");
    expect(narrow.body).toMatch(/\.db-jump \{[^}]*top:\s*var\(--app-header-height\)/);
    expect(narrow.body).toMatch(/\.db-col \{[^}]*scroll-margin-top:\s*calc\(var\(--app-header-height\) \+ \d+px\)/);
  });

  it("is declared after the base rules it relies on (page-header sticky)", () => {
    const sticky = topRules(".page-header")[0]!;
    expect(media("(max-width: 639px)").at).toBeGreaterThan(sticky.at);
  });
});
