/**
 * Home widget footer links (`.home-widget-footer-link`) render as text on the
 * dark surfaces, so they use the secondary/muted text tokens at rest and the
 * accent *text* token on hover (never the raw `--primary` fill, which is
 * 4.05:1 on `--surface` and fails WCAG 1.4.3 AA), and each token must clear
 * 4.5:1 on every dark surface step. Settings inline links sit inside
 * `--muted` prose where their colour alone is 1.44:1 against the surrounding
 * text, so they must carry an underline (axe link-in-text-block) in every
 * theme; the underline lives on the base rule, not only on hover.
 * jsdom cannot compute any of this; the test parses globals.css.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");

/** Body of the first `:root { ... }` block (the dark theme). */
const rootBlock = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

/**
 * Body of the `html[data-theme="light"] { ... }` theme block (the light
 * theme). The same selector also has a one-line color-scheme stub at the top
 * of the file, so the block that declares the surfaces is the theme block.
 */
const lightBlock =
  [...css.matchAll(/(?:^|\n)html\[data-theme="light"\]\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((b) => b.includes("--bg:")) ?? "";

/** Declaration body of the non-pseudo rule for `selector`. */
function ruleBody(selector: string): string {
  const body = new RegExp(`(?:^|\\n)\\${selector}\\s*(?!:)\\{([^}]*)\\}`).exec(css)?.[1];
  expect(body, `globals.css must define a base "${selector}" rule`).not.toBeUndefined();
  return body!;
}

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(rootBlock);
  expect(m, `dark token --${name} must be a 6-digit hex in :root`).not.toBeNull();
  return m![1]!;
}

/** Raw value (hex or `var(...)`) of a custom property declared in `block`. */
function defineIn(block: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

/**
 * Resolve a custom property to its 6-digit hex the way the cascade does: the
 * declaration is looked up in `startBlock` first, then in the dark `:root`,
 * following `var(--x)` indirections from the same start point each time.
 */
function resolveHex(startBlock: string, name: string, depth = 0): string {
  expect(depth, `--${name} must not form a var() cycle`).toBeLessThan(6);
  const value = defineIn(startBlock, name) ?? defineIn(rootBlock, name);
  expect(value, `--${name} must be defined`).toBeDefined();
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value!);
  if (ref) return resolveHex(startBlock, ref[1]!, depth + 1);
  expect(value!, `--${name} must resolve to a 6-digit hex`).toMatch(/^#[0-9a-fA-F]{6}$/);
  return value!;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The rgba() form of a dark token (the hover fill). */
function rgbaToken(name: string): [number, number, number, number] {
  const m = new RegExp(`--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)\\s*;`).exec(rootBlock);
  expect(m, `dark token --${name} must be an rgba() colour in :root`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])] as [number, number, number, number];
}

/** --primary-muted composited over hex surface `base`, as the browser paints it. */
function fillOver(base: string): string {
  const [r, g, b, a] = rgbaToken("primary-muted");
  const [br, bg, bb] = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16)) as [number, number, number];
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(a * r + (1 - a) * br)}${hex(a * g + (1 - a) * bg)}${hex(a * b + (1 - a) * bb)}`;
}

const SURFACES = ["bg", "surface", "surface-raised", "surface-hover", "surface-active"];

describe("home .home-widget-footer-link text colour", () => {
  it("at rest uses the secondary text token, not the raw --primary fill", () => {
    const color = /(?:^|;)\s*color:\s*([^;]+);/.exec(ruleBody(".home-widget-footer-link"))?.[1]?.trim();
    expect(color, "rest colour must be --text-secondary").toBe("var(--text-secondary)");
  });

  it("on hover uses the accent text token, not the raw --primary fill", () => {
    const hover = /\.home-widget-footer-link:hover\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const color = /color:\s*([^;]+);/.exec(hover)?.[1]?.trim();
    expect(color, "hover colour must be --primary-text").toBe("var(--primary-text)");
  });

  it("the quieter variant uses the muted token", () => {
    const color = /(?:^|;)\s*color:\s*([^;]+);/.exec(ruleBody(".home-widget-footer-link--quiet"))?.[1]?.trim();
    expect(color, "quiet colour must be --muted").toBe("var(--muted)");
  });

  it.each(["surface", "surface-raised"])(
    "the hover pairing (--primary-text on --primary-muted) composites to >= 4.5:1 over dark --%s",
    (surface) => {
      // The hover rule paints --primary-muted (a translucent fill) over the
      // surface, so the effective background is the composite, not the raw
      // surface or the fill colour alone (7.04:1 over --surface, 6.56:1 over
      // --surface-raised).
      const painted = fillOver(token(surface));
      expect(contrast(token("primary-text"), painted), `--primary-text on the hover fill over --${surface}`).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(SURFACES)("the rest, quiet and hover tokens resolve to >= 4.5:1 on dark --%s", (surface) => {
    for (const name of ["text-secondary", "muted", "primary-text"]) {
      expect(contrast(token(name), token(surface)), `--${name} on --${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("settings .settings-inline-link", () => {
  it("is underlined in its base rule (both themes; axe link-in-text-block)", () => {
    expect(ruleBody(".settings-inline-link")).toMatch(/text-decoration:\s*underline\s*;/);
  });
});

/**
 * Nine text rules painted in the accent hue use `--primary-fg`: in dark it
 * resolves to the text-safe `--primary-text` (raw `--primary` is 4.05:1 on
 * `--surface` and fails AA), in light it resolves to `--primary`, so light
 * mode keeps exactly the colour it had before the token existed.
 */
const TEXT_RULES = [
  "a",
  ".auth-tab-active",
  ".prose-markdown a",
  ".db-col-expander",
  ".td-result-toggle",
  ".ta-artifact-link",
  ".tas-doc-download",
  ".wf-link-btn:hover",
  ".idlg-preview-td--ref",
];

/** The `color` declaration of `selector` (base rule, or the pseudo rule as-is). */
function ruleColor(selector: string): string {
  const body = selector.includes(":")
    ? new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1]
    : ruleBody(selector);
  expect(body, `globals.css must define the "${selector}" rule`).not.toBeUndefined();
  const color = /(?:^|;)\s*color:\s*([^;]+);/.exec(body!)?.[1]?.trim();
  expect(color, `"${selector}" must declare a colour`).toBeDefined();
  return color!;
}

function lightToken(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(lightBlock);
  expect(m, `light token --${name} must be a 6-digit hex in the light block`).not.toBeNull();
  return m![1]!;
}

describe("accent-hue text rules (nine rules on --primary-fg)", () => {
  const darkFg = resolveHex(rootBlock, "primary-fg");
  const lightFg = resolveHex(lightBlock, "primary-fg");

  it.each(TEXT_RULES)('the "%s" rule paints text with var(--primary-fg)', (selector) => {
    expect(ruleColor(selector), `${selector} colour`).toBe("var(--primary-fg)");
  });

  it("the token is defined as var(--primary-text) in dark and var(--primary) in light", () => {
    expect(defineIn(rootBlock, "primary-fg"), "dark --primary-fg").toBe("var(--primary-text)");
    expect(defineIn(lightBlock, "primary-fg"), "light --primary-fg").toBe("var(--primary)");
  });

  it.each(SURFACES)("dark --primary-fg resolves to >= 4.5:1 on --%s", (surface) => {
    expect(contrast(darkFg, token(surface)), `--primary-fg on --${surface}`).toBeGreaterThanOrEqual(4.5);
  });

  it("light --primary-fg resolves to exactly the pre-token colour #5e6ad2", () => {
    // The light block must not override --primary, and --primary-fg must point
    // at it, so the nine rules keep the colour they had before the token.
    expect(lightBlock.match(/--primary:/), "light block must not override --primary").toBeNull();
    expect(lightFg).toBe("#5e6ad2");
  });

  it.each(SURFACES)("light --primary-text stays >= 4.5:1 on light --%s", (surface) => {
    expect(
      contrast(lightToken("primary-text"), lightToken(surface)),
      `--primary-text on light --${surface}`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
