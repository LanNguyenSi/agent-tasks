/**
 * The dark `--muted` text token is used for small secondary text on every
 * dark surface step, so it must clear WCAG 1.4.3 AA (4.5:1) on all of them.
 * jsdom cannot compute this; the test parses the token values out of the
 * `:root` block of globals.css and computes the contrast ratio.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");

/** Body of the first `:root { ... }` block (the dark theme). */
const rootBlock = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

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

describe("dark --muted text token", () => {
  it.each(SURFACES)("reaches 4.5:1 on --%s", (surface) => {
    expect(contrast(token("muted"), token(surface))).toBeGreaterThanOrEqual(4.5);
  });

  it("stays dimmer than --text-secondary on the page background", () => {
    expect(contrast(token("muted"), token("bg"))).toBeLessThan(contrast(token("text-secondary"), token("bg")));
  });
});
