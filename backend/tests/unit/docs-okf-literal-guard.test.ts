// T-007 (agent-tasks tracker 3feb590f, batch45 D-011): guard for quoted VALUE
// literals that sit next to a docs/okf line citation. See
// backend/tests/helpers/okf-literal-guard.ts for the extraction/window
// design and docs/okf/index.md's Maintenance section for the decision.
//
// Run: npm run test --workspace=backend (also `npx vitest run
// tests/unit/docs-okf-literal-guard.test.ts` from backend/).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AllowlistEntry,
  WORD_WINDOW,
  analyzeBlock,
  checkBlock,
  createFileLineReader,
  extractBlocks,
  isAllowlisted,
  parseFrontmatterSources,
  slugAnchor,
} from "../helpers/okf-literal-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const OKF_DIR = path.join(REPO_ROOT, "docs/okf");
const ALLOWLIST_PATH = path.join(
  __dirname,
  "../fixtures/okf-literal-guard/allowlist.json",
);
const ALLOWLIST: AllowlistEntry[] = JSON.parse(
  fs.readFileSync(ALLOWLIST_PATH, "utf8"),
);

interface DocScan {
  doc: string;
  checked: number;
  bare: number;
  skippedBeyondWindow: number;
  allowlistedCount: number;
  unallowlistedFindings: { anchor: string; literal: string; citations: string[] }[];
  exemptAsHistory: boolean;
}

function scanBundle(): DocScan[] {
  const readLines = createFileLineReader(REPO_ROOT);
  const files = fs.readdirSync(OKF_DIR).filter((f) => f.endsWith(".md"));
  const results: DocScan[] = [];
  for (const doc of files) {
    const text = fs.readFileSync(path.join(OKF_DIR, doc), "utf8");
    const sources = parseFrontmatterSources(text);
    const blocks = extractBlocks(text);
    // log.md narrates history (old, now-superseded values, e.g. the
    // pre-fix SERVER_VERSION and allowedNext); T-001 exempted it from the
    // bare-citation ratchet the same way. Its counts are gathered but
    // never asserted.
    const isLog = doc === "log.md";
    let checked = 0;
    let bare = 0;
    let skipped = 0;
    let allowlistedCount = 0;
    const unallowlistedFindings: DocScan["unallowlistedFindings"] = [];
    for (const block of blocks) {
      const analysis = analyzeBlock(block, sources);
      if (analysis.citations.length === 0) continue;
      const result = checkBlock(analysis, readLines);
      checked += result.checkedCount;
      bare += result.bareCount;
      skipped += result.skippedBeyondWindowCount;
      if (isLog) continue;
      const anchor = slugAnchor(analysis.block);
      for (const finding of result.findings) {
        if (isAllowlisted(ALLOWLIST, doc, anchor, finding.literal)) {
          allowlistedCount++;
        } else {
          unallowlistedFindings.push({
            anchor,
            literal: finding.literal,
            citations: finding.citations,
          });
        }
      }
    }
    results.push({
      doc,
      checked,
      bare,
      skippedBeyondWindow: skipped,
      allowlistedCount,
      unallowlistedFindings,
      exemptAsHistory: isLog,
    });
  }
  return results;
}

// Computed once at collection time (not hand-typed) so the test title and
// the assertion always agree with each other and with the checked tree.
const BUNDLE_SCAN = scanBundle();
const TOTAL_CHECKED = BUNDLE_SCAN.filter((d) => !d.exemptAsHistory).reduce(
  (a, d) => a + d.checked,
  0,
);
const TOTAL_ALLOWLISTED = BUNDLE_SCAN.reduce(
  (a, d) => a + d.allowlistedCount,
  0,
);
const TOTAL_UNALLOWLISTED = BUNDLE_SCAN.reduce(
  (a, d) => a + d.unallowlistedFindings.length,
  0,
);
const TOTAL_BARE = BUNDLE_SCAN.reduce((a, d) => a + d.bare, 0);
const LOG_SCAN = BUNDLE_SCAN.find((d) => d.exemptAsHistory);
const LOG_CHECKED_HISTORICAL = LOG_SCAN ? LOG_SCAN.checked : 0;

describe("docs/okf quoted-literal guard (T-007)", () => {
  it(
    `checks ${TOTAL_CHECKED} value literal(s) within a ${WORD_WINDOW}-word citation window across the current docs/okf bundle ` +
      `(${TOTAL_ALLOWLISTED} allowlisted, ${TOTAL_BARE} bare identifier(s) correctly left unchecked, ` +
      `log.md's ${LOG_CHECKED_HISTORICAL} historical literal(s) counted but not asserted)`,
    () => {
      if (TOTAL_UNALLOWLISTED > 0) {
        const detail = BUNDLE_SCAN.filter(
          (d) => d.unallowlistedFindings.length > 0,
        )
          .map((d) => `${d.doc}: ${JSON.stringify(d.unallowlistedFindings)}`)
          .join("\n");
        throw new Error(
          `Unverified value literal(s) next to a docs/okf line citation (not allowlisted):\n${detail}`,
        );
      }
      expect(TOTAL_UNALLOWLISTED).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Fixture pair: exercised against real temp-dir files (a doc + a fake source
// tree), not in-memory strings only, so the file-reading path is real.
// ---------------------------------------------------------------------------

import os from "node:os";

function makeFixtureRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "okf-literal-guard-"));
}

function analyzeAndCheck(root: string, docText: string) {
  const sources = parseFrontmatterSources(docText);
  const readLines = createFileLineReader(root);
  const blocks = extractBlocks(docText);
  const perBlock = blocks
    .map((block) => analyzeBlock(block, sources))
    .filter((a) => a.citations.length > 0)
    .map((analysis) => ({ analysis, result: checkBlock(analysis, readLines) }));
  return perBlock;
}

describe("okf-literal-guard fixtures", () => {
  it("fails when a doc quotes a literal the cited line does not carry", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      'export const VERSION = "1.2.3";\n',
    );
    const doc =
      'The constant is `VERSION = "1.2.4"` (`src/example.ts:1`), a wrong value.';
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].literal).toContain("1.2.4");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes once the doc's literal matches the cited line", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      'export const VERSION = "1.2.3";\n',
    );
    const doc =
      'The constant is `VERSION = "1.2.3"` (`src/example.ts:1`), the correct value.';
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(0);
    expect(result.checkedCount).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not check a bare identifier even when it mismatches the cited line", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      "export function otherName() {}\n",
    );
    const doc = "The helper `fooBar` is defined (`src/example.ts:1`).";
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(0);
    expect(result.checkedCount).toBe(0);
    expect(result.bareCount).toBeGreaterThan(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not check a mismatched literal sitting beyond the word window from its only citation", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      'export const VERSION = "1.2.3";\n',
    );
    const filler = Array.from(
      { length: WORD_WINDOW + 5 },
      (_, i) => `filler${i}`,
    ).join(" ");
    const doc = `The constant is \`VERSION = "9.9.9"\` ${filler} (\`src/example.ts:1\`).`;
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(0);
    expect(result.checkedCount).toBe(0);
    expect(result.skippedBeyondWindowCount).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
