/**
 * Header nav at <=520px (globals.css). The three nav links Home, Projects and
 * Tasks must stay visible at 390 px; room is made by hiding the brand text
 * and the username (both reachable another way), never a nav link. The old
 * rule hid `.app-nav-link:first-child` and `:last-child`, which with the
 * three-link nav would hide Home and Tasks: pin that no rule selects nav
 * links by position or hides them in the mobile block.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

function mobileHeaderBlock(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");
  const start = css.indexOf("Header nav: 390px responsive");
  expect(start, "mobile header comment must exist").toBeGreaterThan(-1);
  const open = css.indexOf("@media (max-width: 520px) {", start);
  expect(open, "520px header block must follow the comment").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", open); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  throw new Error("unterminated 520px header block");
}

describe("header mobile rule (<=520px)", () => {
  it("selects no nav link by position and never hides one", () => {
    const block = mobileHeaderBlock();
    expect(block).not.toMatch(/:first-child|:last-child|:nth-child|:nth-of-type/);
    // `.app-nav-link` / `.app-nav-links` may be restyled, never display:none.
    const rules = block.match(/[^{}]+\{[^}]*\}/g) ?? [];
    for (const rule of rules) {
      const selector = rule.slice(0, rule.indexOf("{"));
      const body = rule.slice(rule.indexOf("{"));
      if (/\.app-nav-link/.test(selector)) {
        expect(body, `${selector.trim()} must stay visible`).not.toMatch(/display:\s*none/);
      }
    }
  });

  it("makes room by hiding the brand text and the username instead", () => {
    const block = mobileHeaderBlock();
    expect(block).toMatch(/\.app-brand-text\s*\{[^}]*display:\s*none/);
    expect(block).toMatch(/\.app-user-name\s*\{[^}]*display:\s*none/);
  });

  it("truncates the team switcher to a short width", () => {
    const block = mobileHeaderBlock();
    expect(block).toMatch(/\.app-team-trigger\s*\{[^}]*max-width:\s*\d+px/);
  });
});
