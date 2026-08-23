/**
 * Late-stack table variant (`.table-wrapper--late-stack`, used by the
 * workflow StatesTable/TransitionsTable) media-query boundaries.
 *
 * Contract:
 *   - globals.css defines a `@media (max-width: 720px)` block that puts
 *     late-stack tables into stacked card mode (display: block on
 *     .table-wrapper--late-stack .table, etc.).
 *   - A later "undo" block reverts late-stack tables back to table mode
 *     for the 721px-900px band, where the default (non-late-stack) 900px
 *     stacked mode would otherwise also apply to them. That undo block
 *     MUST be scoped to `min-width: 721px` so it does not also win, by
 *     source order, at widths <=720px -- which is the bug this pins:
 *     without the min-width guard the undo block (later in source, same
 *     specificity) always overrides the 720px block, so late-stack
 *     tables never actually stacked at any width.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

function readGlobalsCss(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return readFileSync(join(__dirname, "../../src/app/globals.css"), "utf8");
}

describe("late-stack table CSS media-query boundaries (globals.css)", () => {
  it("defines the 720px late-stack stacked-mode block", () => {
    const css = readGlobalsCss();
    // The block that puts late-stack tables into stacked (card) mode.
    const stackedModeBlockRe =
      /@media\s*\(max-width:\s*720px\)\s*\{[^]*?\.table-wrapper--late-stack \.table \{\s*display:\s*block;/;
    expect(css, "720px block must switch .table-wrapper--late-stack .table to display: block").toMatch(
      stackedModeBlockRe,
    );
  });

  it("scopes the 900px undo block with a min-width: 721px guard, so it does not win below 720px", () => {
    const css = readGlobalsCss();
    // Find the "undo" media query that precedes the late-stack revert-to-table rules.
    const undoBlockHeaderIdx = css.indexOf(
      "Also undo the global 900px stacked mode for late-stack tables",
    );
    expect(undoBlockHeaderIdx, "undo-block comment must exist").toBeGreaterThan(-1);

    const afterComment = css.slice(undoBlockHeaderIdx);
    // Capture the full media condition (which may itself contain
    // parenthesized sub-conditions like "and (min-width: 721px)"), up to
    // the block's opening brace.
    const mediaMatch = afterComment.match(/@media\s*([^{]*)\{/);
    expect(mediaMatch, "undo block must open with an @media rule").not.toBeNull();

    const mediaCondition = mediaMatch![1]!;
    expect(mediaCondition, "undo block must cap at max-width: 900px").toMatch(/max-width:\s*900px/);
    expect(
      mediaCondition,
      "undo block must be guarded with min-width: 721px so the 720px late-stack block still wins below 720px",
    ).toMatch(/min-width:\s*721px/);

    // And it must still contain the revert-to-table-mode rule for late-stack tables.
    const undoRuleRe = /\.table-wrapper--late-stack \.table \{\s*display:\s*table;/;
    expect(afterComment, "undo block must revert .table-wrapper--late-stack .table to display: table").toMatch(
      undoRuleRe,
    );
  });
});
