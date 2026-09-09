// T-010 round 2: asserts that .github/workflows/okf-literal-guard.yml's
// Detect step PATTERN actually covers every source path docs/okf's live
// citations name -- not just the guard's own files -- so a PR editing
// only a cited source file cannot silently skip the guard the way the
// original PATTERN (docs/okf/ plus the guard's own files) did. Reads the
// live PATTERN out of the committed workflow yaml (never a hand-copied
// string) so a future edit that narrows or drops a root fails this test
// instead of silently reopening the gap.
//
// `log.md` narrates history (old, now-superseded citations); it is
// exempted here the same way the literal-guard's own bundle scan exempts
// it from assertions (see docs-okf-literal-guard.test.ts).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeBlock,
  extractBlocks,
  parseFrontmatterSources,
} from "../helpers/okf-literal-guard.js";
import { extractPattern, loadWorkflow, stepRun } from "../helpers/workflow-yaml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const OKF_DIR = path.join(REPO_ROOT, "docs/okf");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/okf-literal-guard.yml",
);

function collectCitedPaths(): string[] {
  const cited = new Set<string>();
  const files = fs.readdirSync(OKF_DIR).filter((f) => f.endsWith(".md"));
  for (const doc of files) {
    if (doc === "log.md") continue;
    const text = fs.readFileSync(path.join(OKF_DIR, doc), "utf8");
    const sources = parseFrontmatterSources(text);
    for (const block of extractBlocks(text)) {
      const analysis = analyzeBlock(block, sources);
      for (const c of analysis.citations) cited.add(c.path);
    }
  }
  return [...cited].sort();
}

const CITED_PATHS = collectCitedPaths();
const PATTERN_TEXT = extractPattern(
  stepRun(loadWorkflow(WORKFLOW_PATH), "literal-guard", "filter"),
);
const PATTERN = new RegExp(PATTERN_TEXT);

describe("okf-literal-guard.yml PATTERN covers every cited source path (T-010 round 2)", () => {
  it(`matches all ${CITED_PATHS.length} distinct source path(s) currently cited by the docs/okf bundle (log.md excluded)`, () => {
    expect(CITED_PATHS.length).toBeGreaterThan(0);
    const unmatched = CITED_PATHS.filter((p) => !PATTERN.test(p));
    if (unmatched.length > 0) {
      throw new Error(
        `PATTERN (${PATTERN_TEXT}) does not cover: ${JSON.stringify(unmatched)}. ` +
          `Widen the Detect step's PATTERN in .github/workflows/okf-literal-guard.yml ` +
          `(and its explanation in docs/okf/index.md's Maintenance section) to include ` +
          `the source root(s) for the unmatched path(s) above.`,
      );
    }
    expect(unmatched).toHaveLength(0);
  });
});
