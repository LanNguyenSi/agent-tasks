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

describe("section count in light", () => {
  it("uses the opaque --surface-active fill so axe can resolve its text contrast", () => {
    const m = /(?:^|\n)html\[data-theme="light"\] \.td-section-count\s*\{([^}]*)\}/.exec(css);
    expect(m, "light override for .td-section-count").not.toBeNull();
    expect(m![1]).toMatch(/background:\s*var\(--surface-active\)\s*;/);
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

/* ── Text on the light wash ─────────────────────────────────────────────── */

type Rgb = [number, number, number];

function hexRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function lum([r, g, b]: Rgb): number {
  const [x, y, z] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * x + 0.7152 * y + 0.0722 * z;
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` painted at `alpha` over `bg`, as the browser composites it. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((v, i) => alpha * v + (1 - alpha) * bg[i]!) as Rgb;
}

function lightHex(name: string): Rgb {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(lightBlock);
  expect(m, `light --${name} must be a 6-digit hex`).not.toBeNull();
  return hexRgb(m![1]!);
}

/** Light text colour token of `selector`: the light override rule first, then the base rule, else the inherited default. */
function lightTextToken(selector: string, inherited: string): string {
  const esc = selector.replace(/[.]/g, "\\$&");
  const light = new RegExp(`html\\[data-theme="light"\\] ${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  const base = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  const color = (b?: string) => /(?:^|;|\n)\s*color:\s*var\(--([a-z-]+)\)\s*;/.exec(b ?? "")?.[1];
  return color(light) ?? color(base) ?? inherited;
}

/** Wash alpha of the rule (percentage times light --wash-k). */
function washAlpha(selector: string): number {
  const esc = selector.replace(/[.]/g, "\\$&");
  const pct = new RegExp(`(?:^|\\n)${esc}\\s*\\{[^}]*calc\\((\\d+)% \\* var\\(--wash-k\\)\\)`).exec(css)?.[1];
  expect(pct, `${selector} must mix the wash`).toBeDefined();
  return (Number(pct) / 100) * Number(defineIn(lightBlock, "wash-k"));
}

const PLAIN = ["surface", "bg", "surface-hover", "surface-active"];
const TINTED = ["warning", "danger"];

describe("muted text on the light wash stays >= 4.5:1", () => {
  const containers: Record<string, Rgb> = Object.fromEntries([
    ...PLAIN.map((n) => [n, lightHex(n)] as const),
    // .ip-root--warning / --danger: 10% accent over --surface
    ...TINTED.map((n) => [`ip-root--${n}`, over(lightHex(n), 0.1, lightHex("surface"))] as const),
  ]);

  // .ta-empty-code inherits --muted from .ta-empty, which sits on --surface only.
  const cases: [string, string, string[]][] = [
    [".ip-findings-code", "muted", [...PLAIN, ...TINTED.map((n) => `ip-root--${n}`)]],
    [".ta-empty-code", "muted", ["surface"]],
  ];

  for (const [selector, inherited, names] of cases) {
    it.each(names)(`${selector} text over the wash on %s`, (name) => {
      const text = lightHex(lightTextToken(selector, inherited));
      const bg = over(hexRgb("#000000"), washAlpha(selector), containers[name]!);
      expect(ratio(text, bg), `${selector} on ${name}`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
