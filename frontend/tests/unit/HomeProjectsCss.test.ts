/**
 * /home and /projects styling after the move onto PageShell: the legacy
 * `.page-shell` frame and the page-local title/header classes are gone, the
 * native sort select is hidden at desktop widths (the shared Select or the
 * table header sorts there), and the Home widget cards are top-aligned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const src = join(dir, "../../src");
const css = readFileSync(join(src, "app/globals.css"), "utf8");

/** The declaration blocks of every top-level rule whose selector is exactly `selector`, joined. */
function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const blocks = [...css.matchAll(re)].map((m) => m[1]!);
  expect(blocks.length, `rule ${selector} must exist`).toBeGreaterThan(0);
  return blocks.join("\n");
}

describe("legacy page frame", () => {
  it("has no .page-shell rule or page-local header/title classes left", () => {
    expect(css).not.toMatch(/\.page-shell\b/);
    expect(css).not.toMatch(/\.(teams-header-row|teams-actions|teams-page-title|teams-team-name|home-header)\b/);
  });

  it.each(["app/home/page.tsx", "app/projects/page.tsx", "components/ui/FullPageLoader.tsx"])(
    "%s does not render the legacy class",
    (file) => {
      expect(readFileSync(join(src, file), "utf8")).not.toMatch(/page-shell\b/);
    },
  );

  it("every H1 shares the PageHeader title weight of 600", () => {
    expect(rule(".page-header-title")).toMatch(/font-weight:\s*600/);
  });
});

describe("/projects sort control", () => {
  it("hides the compact native sort at desktop widths", () => {
    expect(rule(".table-compact-sort")).toMatch(/display:\s*none/);
  });

  it("the filter-bar sort modifier adds a column and is declared before the narrow-width stack", () => {
    expect(rule(".teams-filter-bar--sort")).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\) auto auto auto/,
    );
    const modifier = css.indexOf("\n.teams-filter-bar--sort {");
    const narrow = css.indexOf("  .teams-filter-bar {\n    grid-template-columns: 1fr;");
    expect(modifier).toBeGreaterThan(0);
    expect(narrow).toBeGreaterThan(modifier);
  });
});

describe("/home widgets", () => {
  it("top-aligns the widget cards instead of stretching them to the row height", () => {
    expect(rule(".home-widgets-grid")).toMatch(/align-items:\s*start/);
  });
});

describe("PageHeader summary truncation (opt-in)", () => {
  it("the opt-in lets the summary shrink with an ellipsis and keeps the title at full width", () => {
    const summary = rule(".page-header--summary-truncates .page-header-summary");
    expect(summary).toMatch(/flex-shrink:\s*1/);
    expect(summary).toMatch(/min-width:\s*0/);
    expect(summary).toMatch(/overflow:\s*hidden/);
    expect(summary).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".page-header--summary-truncates .page-header-title")).toMatch(/flex-shrink:\s*0/);
  });

  it("every other PageHeader keeps the one-line summary at its natural width", () => {
    const base = rule(".page-header-summary");
    expect(base).toMatch(/white-space:\s*nowrap/);
    expect(base).toMatch(/flex-shrink:\s*0/);
    expect(base).not.toMatch(/overflow|text-overflow/);
  });
});
