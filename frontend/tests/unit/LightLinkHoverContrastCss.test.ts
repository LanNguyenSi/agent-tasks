/**
 * In light mode a hovered link must be darker than the resting link and clear
 * 4.5:1 on the page and card surfaces. The dark `--primary-hover` is a lighter
 * step (3.85:1 on the light `--bg`), so the global `a:hover` rule reads the
 * light-only `--link-hover` token first. Dark keeps `--primary-hover`.
 * jsdom cannot compute colours; the test parses globals.css.
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

/** Resolve a custom property to a 6-digit hex: `startBlock` first, then dark `:root`. */
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

/** The `color` value of the global `a:hover` rule. */
const hoverColor = /(?:^|\n)a:hover\s*\{([^}]*)\}/.exec(css)?.[1]?.match(/color:\s*([^;]+);/)?.[1]?.trim();

/** The var() chain of the hover colour: `var(--a, var(--b))` gives ["a", "b"]. */
function hoverTokens(): string[] {
  expect(hoverColor, "globals.css must define a:hover with a colour").toBeDefined();
  return [...hoverColor!.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]!);
}

/** First token of the chain that the theme block defines (the cascade's pick). */
function resolveHover(block: string): string {
  const name = hoverTokens().find((t) => defineIn(block, t) !== undefined);
  expect(name, "a:hover must read a token the theme defines").toBeDefined();
  return resolveHex(block, name!);
}

describe("a:hover colour", () => {
  it("reads the light-only --link-hover token before the dark --primary-hover", () => {
    expect(hoverTokens()).toEqual(["link-hover", "primary-hover"]);
  });

  it("light defines --link-hover and dark does not (dark keeps --primary-hover)", () => {
    expect(defineIn(lightBlock, "link-hover")).toBeDefined();
    expect(defineIn(rootBlock, "link-hover")).toBeUndefined();
  });

  it("dark hover resolves to --primary-hover, unchanged", () => {
    expect(resolveHover(rootBlock).toLowerCase()).toBe("#6974dc");
  });

  it.each(["bg", "surface", "surface-raised", "surface-hover", "surface-active"])(
    "light hover colour is >= 4.5:1 on light --%s",
    (surface) => {
      expect(contrast(resolveHover(lightBlock), resolveHex(lightBlock, surface))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("light hover colour is darker than the resting link", () => {
    const rest = resolveHex(lightBlock, "link");
    expect(luminance(resolveHover(lightBlock))).toBeLessThan(luminance(rest));
  });
});
