/**
 * Hover fills, chips, bars and code backgrounds were painted with a hard-coded
 * `color-mix(in srgb, white N%, ...)`, which is white on white (invisible) in
 * light mode. They now mix the theme's `--wash` token (white in dark, black in
 * light) scaled by `--wash-k`. jsdom cannot compute colours; the test parses
 * globals.css.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");

const rootBlock = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
const lightBlock =
  [...css.matchAll(/(?:^|\n)html\[data-theme="light"\]\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((b) => b.includes("--bg:")) ?? "";

function defineIn(block: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

const SELECTORS = [
  ".app-team-trigger:hover",
  ".app-user-trigger:hover",
  ".db-proj-switch:hover:not(:disabled)",
  ".db-col-add:hover",
  ".db-card:hover",
  ".db-card-pr-chip",
  ".td-btn-edit:hover",
  ".td-btn-icon:hover",
  ".td-section-count",
  ".td-branch-chip",
  ".td-conf-bar",
  ".ip-findings-code",
  ".ip-rewrite-text",
  ".td-checklist-bar",
  ".ta-empty-code",
];

function body(selector: string): string {
  const esc = selector.replace(/[.:()]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n|,\\s*)${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`).exec(css);
  expect(m, `globals.css must define a rule for ${selector}`).not.toBeNull();
  return m![1]!;
}

describe("no hard-coded white wash in light mode", () => {
  it("globals.css has no `white N%` colour mix left", () => {
    expect(css.match(/color-mix\([^)]*\bwhite\s+\d+%/g) ?? []).toEqual([]);
  });

  it.each(SELECTORS)("%s paints with the theme --wash token", (selector) => {
    const b = body(selector);
    const uses = /var\(--wash\)/.test(b) || /var\(--border-hover\)/.test(b);
    expect(uses, `${selector} must use --wash or --border-hover`).toBe(true);
    expect(b).not.toMatch(/color-mix\([^)]*\bwhite\b|:\s*white\b/);
  });
});

describe("--wash token per theme", () => {
  it("dark washes white at k=1, so the dark mix percentages are unchanged", () => {
    expect(defineIn(rootBlock, "wash")).toBe("#ffffff");
    expect(defineIn(rootBlock, "wash-k")).toBe("1");
  });

  it("light washes black at k>=2, so the mix is visible over white surfaces", () => {
    expect(defineIn(lightBlock, "wash")).toBe("#000000");
    expect(Number(defineIn(lightBlock, "wash-k"))).toBeGreaterThanOrEqual(2);
  });

  it("the card hover border is the theme's border-hover token (white 15% in dark)", () => {
    expect(defineIn(rootBlock, "border-hover")).toBe("#ffffff26");
    expect(body(".db-card:hover")).toMatch(/border-color:\s*var\(--border-hover\)/);
  });
});
