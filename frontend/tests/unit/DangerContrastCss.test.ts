/**
 * Text painted on a solid `--danger` fill, and the muted consumed-invite
 * badge, must clear WCAG 1.4.3 AA in both themes. jsdom cannot composite
 * translucent fills, so the test parses globals.css and composites the
 * colour-mix fills itself, the same way DarkPrimaryLinkContrastCss does.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, "../../src/app/globals.css"), "utf8");

/** Body of the first `:root { ... }` block (the dark theme). */
const rootBlock = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

/** Body of the light-theme token block (the one that re-declares --bg). */
const lightBlock =
  [...css.matchAll(/(?:^|\n)html\[data-theme="light"\]\s*\{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((b) => b.includes("--bg:")) ?? "";

/** Declaration body of the non-pseudo rule for `selector`. */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`(?:^|\\n)${esc}\\s*(?!:)\\{([^}]*)\\}`).exec(css)?.[1];
  expect(body, `globals.css must define a base "${selector}" rule`).not.toBeUndefined();
  return body!;
}

/** Raw value (hex or `var(...)`) of a custom property declared in `block`. */
function defineIn(block: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

/** Resolve a custom property to its 6-digit hex the way the cascade does. */
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

/** `color-mix(in srgb, var(--token) <p>%, transparent)` over `base`, as painted. */
function mixOver(block: string, token: string, percent: number, base: string): string {
  const rgb = [1, 3, 5].map((i) => parseInt(resolveHex(block, token).slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
  const bg = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16)) as [number, number, number];
  const a = percent / 100;
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(rgb.map((v, i) => a * v + (1 - a) * bg[i])[0])}${hex(
    rgb.map((v, i) => a * v + (1 - a) * bg[i])[1],
  )}${hex(rgb.map((v, i) => a * v + (1 - a) * bg[i])[2])}`;
}

const THEMES = { dark: rootBlock, light: lightBlock } as const;

describe(".btn-danger text on the solid --danger fill", () => {
  it("paints the text with the --danger-contrast token in both themes", () => {
    const color = /(?:^|;)\s*color:\s*([^;]+);/.exec(ruleBody(".btn-danger"))?.[1]?.trim();
    expect(color, ".btn-danger colour").toBe("var(--danger-contrast)");
  });

  it("defines --danger-contrast as var(--bg) in dark and white in light", () => {
    expect(defineIn(rootBlock, "danger-contrast"), "dark --danger-contrast").toBe("var(--bg)");
    expect(resolveHex(lightBlock, "danger-contrast"), "light --danger-contrast").toBe("#ffffff");
  });

  for (const [theme, block] of Object.entries(THEMES)) {
    it(`clears 4.5:1 on --danger in ${theme}`, () => {
      expect(
        contrast(resolveHex(block, "danger-contrast"), resolveHex(block, "danger")),
        `--danger-contrast on --danger (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('consumed invite badge (.mem-invite-badge[data-status="consumed"])', () => {
  const body = ruleBody('.mem-invite-badge[data-status="consumed"]');

  it("paints the text with --muted and a weak --muted fill", () => {
    const color = /(?:^|;)\s*color:\s*([^;]+);/.exec(body)?.[1]?.trim();
    expect(color, "badge text colour").toBe("var(--muted)");
    const mix =
      /background:\s*color-mix\(in srgb,\s*var\(--muted\)\s+(\d+)%,\s*transparent\)/.exec(body);
    expect(mix, "badge fill must be a percentage muted mix over transparent").not.toBeNull();
  });

  for (const [theme, block] of Object.entries(THEMES)) {
    it(`keeps >= 4.5:1 over the raised card in ${theme}`, () => {
      const percent = Number(
        /color-mix\(in srgb,\s*var\(--muted\)\s+(\d+)%/.exec(body)?.[1],
      );
      const painted = mixOver(block, "muted", percent, resolveHex(block, "surface-raised"));
      expect(
        contrast(resolveHex(block, "muted"), painted),
        `--muted on the ${percent}% fill over --surface-raised (${theme})`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
