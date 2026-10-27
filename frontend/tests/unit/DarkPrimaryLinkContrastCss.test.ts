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
