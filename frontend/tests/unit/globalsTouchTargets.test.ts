/**
 * Text-level assertions on src/app/globals.css for the mobile touch
 * targets and the /tasks scope-tab overflow cue (see the
 * `@media (max-width: 760px)` block next to the `.tabs` rules).
 *
 * Guards three things a style refactor could silently undo:
 *  - every listed selector gets `min-height: 40px` (and the icon-only
 *    row-actions trigger also `min-width: 40px`) inside the 760px block;
 *  - the scope strip keeps `overflow-x: auto` and both mask-image
 *    spellings (the right-edge fade is the only overflow cue);
 *  - the base (desktop) rules are untouched: their fixed heights stay,
 *    and the 40px sizes exist only inside the media block.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rawCss = readFileSync(
  fileURLToPath(new URL("../../src/app/globals.css", import.meta.url)),
  "utf8",
);

// Comments (also the ones sitting between a block's prelude and its brace)
// carry no selectors or declarations, so parsing is done without them.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

interface Block {
  /** Selector, or the full at-rule condition for nested blocks. */
  prelude: string;
  body: string;
}

/**
 * Walk the stylesheet one nesting level at a time, skipping comments and
 * strings so braces inside them cannot skew the depth count.
 */
function childBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = -1;
  let prelude = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        prelude = source.slice(preludeStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        blocks.push({ prelude, body: source.slice(bodyStart, i) });
        preludeStart = i + 1;
      }
    }
  }
  return blocks;
}

function rulesInside(body: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (const block of childBlocks(body)) {
    rules.set(block.prelude.replace(/\s+/g, " "), block.body);
  }
  return rules;
}

const media760Blocks = childBlocks(css).filter(
  (block) =>
    /^@media\s*\(max-width:\s*760px\)$/.test(block.prelude.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")")),
);

const touchBlock = media760Blocks.find((block) =>
  rulesInside(block.body).has(".tasks-scope-tabs"),
);

const touchRules = rulesInside(touchBlock?.body ?? "");

/** Bodies of every top-level (outside @media) rule listing `selector`. */
function baseRulesFor(selector: string): string[] {
  return childBlocks(css)
    .filter((block) =>
      block.prelude
        .split(",")
        .some((part) => part.replace(/\s+/g, " ").trim() === selector),
    )
    .map((block) => block.body);
}

const MIN_HEIGHT_40 = /min-height:\s*40px/;

describe("globals.css mobile touch targets (<= 760px)", () => {
  it("has exactly one 760px block holding the touch-target rules", () => {
    expect(touchBlock).toBeDefined();
    expect(touchRules.size).toBeGreaterThan(0);
  });

  it.each([
    ".tabs-tab",
    ".filter-chip",
    ".tasks-row-actions-btn",
    ".app-nav-link",
    ".page-header-actions .btn--sm",
  ])("gives %s a 40px min-height in the 760px block", (selector) => {
    const body = touchRules.get(selector);
    expect(body, `${selector} missing from the 760px block`).toBeDefined();
    expect(body).toMatch(MIN_HEIGHT_40);
  });

  it("gives the icon-only row-actions trigger a 40px min-width too", () => {
    expect(touchRules.get(".tasks-row-actions-btn")).toMatch(/min-width:\s*40px/);
  });

  it("keeps the scope strip scrollable with a right-edge fade cue", () => {
    const body = touchRules.get(".tasks-scope-tabs");
    expect(body).toBeDefined();
    expect(body).toMatch(/overflow-x:\s*auto/);
    expect(body).toMatch(/-webkit-mask-image:\s*linear-gradient\(/);
    expect(body).toMatch(/(^|\s)mask-image:\s*linear-gradient\(/);
  });

  it("leaves the desktop geometry on the base rules", () => {
    const tabsTab = baseRulesFor(".tabs-tab").join("\n");
    expect(tabsTab).toMatch(/height:\s*24px/);
    expect(baseRulesFor(".filter-chip").join("\n")).not.toMatch(MIN_HEIGHT_40);
    expect(baseRulesFor(".tasks-row-actions-btn").join("\n")).toMatch(/width:\s*28px/);
    expect(baseRulesFor(".app-nav-link").join("\n")).toMatch(/height:\s*26px/);
    // The 40px sizes live only in the media block, never on the base rules.
    for (const selector of [".tabs-tab", ".filter-chip", ".app-nav-link"]) {
      for (const body of baseRulesFor(selector)) {
        expect(body).not.toMatch(MIN_HEIGHT_40);
      }
    }
  });
});
