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
  countSpans,
  createFileLineReader,
  extractBlocks,
  isAllowlisted,
  matchAllowlistEntry,
  parseFrontmatterSources,
  slugAnchor,
  stripFrontmatter,
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
const MAX_ALLOWLIST_ENTRIES = 10;

interface DocScan {
  doc: string;
  checked: number;
  bare: number;
  skippedBeyondWindow: number;
  allowlistedCount: number;
  unallowlistedFindings: {
    anchor: string;
    literal: string;
    citations: string[];
    reason: string;
  }[];
  exemptAsHistory: boolean;
  spansSeen: number;
  spansPresent: number;
}

function scanBundle(): {
  results: DocScan[];
  allowlistHits: Map<AllowlistEntry, number>;
} {
  const readLines = createFileLineReader(REPO_ROOT);
  const files = fs.readdirSync(OKF_DIR).filter((f) => f.endsWith(".md"));
  const results: DocScan[] = [];
  const allowlistHits = new Map<AllowlistEntry, number>(
    ALLOWLIST.map((e) => [e, 0]),
  );
  for (const doc of files) {
    const text = fs.readFileSync(path.join(OKF_DIR, doc), "utf8");
    const sources = parseFrontmatterSources(text);
    const blocks = extractBlocks(text);
    // Baseline for the spans-seen self-check (T-007 round 3, D-030 finding
    // 3): counted over the raw per-file body (stripFrontmatter only, no
    // extractBlocks), so a regression in extractBlocks' block-splitting
    // (e.g. dropping the file's last block) still leaves this baseline
    // unchanged and the comparison below fails loudly. This does not
    // insulate against a stripFrontmatter regression itself (both this
    // baseline and extractBlocks call it); none of the bundle's frontmatter
    // blocks currently contain a backtick span, so stripping the fence is
    // the right cut point rather than the first body line.
    const rawSpansPresent = countSpans(stripFrontmatter(text));
    // log.md narrates history (old, now-superseded values, e.g. the
    // pre-fix SERVER_VERSION and allowedNext); T-001 exempted it from the
    // bare-citation ratchet the same way. Its counts are gathered but
    // never asserted.
    const isLog = doc === "log.md";
    let checked = 0;
    let bare = 0;
    let skipped = 0;
    let allowlistedCount = 0;
    let spansSeen = 0;
    const spansPresent = rawSpansPresent;
    const unallowlistedFindings: DocScan["unallowlistedFindings"] = [];
    for (const block of blocks) {
      // Computed for EVERY block, cited or not, so the spans-seen self-check
      // covers the whole bundle (the round-1 bug dropped spans in blocks
      // with and without citations alike).
      const analysis = analyzeBlock(block, sources);
      spansSeen += analysis.spansSeen;
      if (analysis.citations.length === 0) continue;
      const result = checkBlock(analysis, readLines);
      checked += result.checkedCount;
      bare += result.bareCount;
      skipped += result.skippedBeyondWindowCount;
      if (isLog) continue;
      const anchor = slugAnchor(analysis.block);
      for (const finding of result.findings) {
        const entry = matchAllowlistEntry(
          ALLOWLIST,
          doc,
          anchor,
          finding.literal,
        );
        if (entry) {
          allowlistedCount++;
          allowlistHits.set(entry, (allowlistHits.get(entry) ?? 0) + 1);
        } else {
          unallowlistedFindings.push({
            anchor,
            literal: finding.literal,
            citations: finding.citations,
            reason: finding.reason,
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
      spansSeen,
      spansPresent,
    });
  }
  return { results, allowlistHits };
}

// Computed once at collection time (not hand-typed) so the test title and
// the assertion always agree with each other and with the checked tree.
const { results: BUNDLE_SCAN, allowlistHits: ALLOWLIST_HITS } = scanBundle();
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
const TOTAL_SPANS_SEEN = BUNDLE_SCAN.reduce((a, d) => a + d.spansSeen, 0);
const TOTAL_SPANS_PRESENT = BUNDLE_SCAN.reduce((a, d) => a + d.spansPresent, 0);

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

  it(`sees all ${TOTAL_SPANS_PRESENT} backtick span(s) present across the docs/okf bundle (matched ${TOTAL_SPANS_SEEN})`, () => {
    // Regression guard for the round-1 bug (61 of 1470 spans dropped
    // silently): if a future tokenizer change drops a span again, this
    // fails loudly instead of quietly under-counting.
    expect(TOTAL_SPANS_SEEN).toBe(TOTAL_SPANS_PRESENT);
  });
});

describe("docs/okf literal-guard allowlist (T-007)", () => {
  it(`has at most ${MAX_ALLOWLIST_ENTRIES} entries, each with a non-empty reason`, () => {
    expect(ALLOWLIST.length).toBeLessThanOrEqual(MAX_ALLOWLIST_ENTRIES);
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("has no orphaned entry (every entry matched at least one finding during the bundle scan)", () => {
    const orphans = ALLOWLIST.filter((e) => (ALLOWLIST_HITS.get(e) ?? 0) === 0);
    if (orphans.length > 0) {
      throw new Error(
        `Orphaned allowlist entry (matched nothing in the current scan): ${JSON.stringify(orphans)}`,
      );
    }
    expect(orphans).toHaveLength(0);
  });

  // Direct kill for the "allowlist predicate -> () => true" mutant: the
  // bundle-wide scan above is currently clean either way (0 unallowlisted
  // findings with or without the mutation), so it does not discriminate.
  // This asserts the predicate's actual return value on a tuple that is
  // known not to be in the allowlist.
  it("does not allowlist a literal/anchor/doc tuple that is not actually in the allowlist", () => {
    expect(
      isAllowlisted(ALLOWLIST, "not-a-real-doc.md", "nowhere", "9.9.9"),
    ).toBe(false);
    expect(
      matchAllowlistEntry(ALLOWLIST, "not-a-real-doc.md", "nowhere", "9.9.9"),
    ).toBeUndefined();
  });

  it("flags an allowlist entry as orphaned when a real finding's tuple does not match it", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      'export const VERSION = "1.2.3";\n',
    );
    const doc =
      'The constant is `VERSION = "1.2.4"` (`src/example.ts:1`), a wrong value.';
    const [{ analysis, result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(1);
    const anchor = slugAnchor(analysis.block);
    // A misconfigured allowlist entry citing the WRONG doc name for this
    // exact anchor/literal never matches the real finding's tuple, so a
    // scan carrying it treats it as orphaned (this is what the mutant
    // "isAllowlisted -> () => true" would hide).
    const wrongDocEntry: AllowlistEntry = {
      doc: "not-the-real-doc.md",
      anchor,
      literal: result.findings[0].literal,
      reason: "fixture: doc name does not match the real scan",
    };
    expect(
      matchAllowlistEntry(
        [wrongDocEntry],
        "the-real-doc.md",
        anchor,
        result.findings[0].literal,
      ),
    ).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
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
    expect(result.findings[0].reason).toBe("literal-mismatch");
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

  it("checks a mismatched literal sitting exactly WORD_WINDOW words from its only citation", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      'export const VERSION = "1.2.3";\n',
    );
    // Plain space-separated units only (no punctuation glued to either
    // span), so the distance between the two spans' word indices is
    // exactly (filler word count) + 1.
    const fillerCount = WORD_WINDOW - 1;
    const filler = Array.from(
      { length: fillerCount },
      (_, i) => `filler${i}`,
    ).join(" ");
    const doc = `The constant is \`VERSION = "9.9.9"\` ${filler} \`src/example.ts:1\``;
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.checkedCount).toBe(1);
    expect(result.skippedBeyondWindowCount).toBe(0);
    expect(result.findings).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not check a mismatched literal sitting WORD_WINDOW + 1 words from its only citation", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      'export const VERSION = "1.2.3";\n',
    );
    const fillerCount = WORD_WINDOW;
    const filler = Array.from(
      { length: fillerCount },
      (_, i) => `filler${i}`,
    ).join(" ");
    const doc = `The constant is \`VERSION = "9.9.9"\` ${filler} \`src/example.ts:1\``;
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.checkedCount).toBe(0);
    expect(result.skippedBeyondWindowCount).toBe(1);
    expect(result.findings).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds both literals in a token carrying two glued backtick spans, plus the following citation", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/a.ts"),
      'mode: "0.13.0"\nother: "9.9.9"\n',
    );
    const doc =
      'The keys are `mode: "0.13.0"`/`other: "9.9.9"` per (`src/a.ts:1-2`).';
    const [{ analysis, result }] = analyzeAndCheck(root, doc);
    expect(analysis.citations).toHaveLength(1);
    expect(analysis.literals.map((l) => l.text)).toEqual(
      expect.arrayContaining(['mode: "0.13.0"', 'other: "9.9.9"']),
    );
    expect(analysis.literals).toHaveLength(2);
    expect(result.findings).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a bare semver literal validated only as a substring of a prerelease value", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      'export const SERVER_VERSION = "0.14.0-rc1";\n',
    );
    const doc =
      "The server is at `0.14.0` (`src/example.ts:1`), a value the source does not actually carry.";
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].literal).toBe("0.14.0");
    expect(result.findings[0].reason).toBe("literal-mismatch");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports an unreadable citation (missing file) as unreadable-citation, not literal-mismatch", () => {
    const root = makeFixtureRoot();
    // No src/ directory or file created at all: the citation is unresolvable.
    const doc =
      'The constant is `VERSION = "1.2.3"` (`src/missing.ts:1`), citing a file that does not exist.';
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reason).toBe("unreadable-citation");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a citation with start < 1 as unreadable instead of reading the file's last line", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    // Last line of the file happens to contain the literal text, which
    // `lines.slice(-1, end)` would accidentally match if start < 1 were
    // not rejected before the read.
    fs.writeFileSync(
      path.join(root, "src/example.ts"),
      'export const A = 1;\nexport const VERSION = "9.9.9";\n',
    );
    const doc =
      'The constant is `VERSION = "9.9.9"` (`src/example.ts:0`), an invalid line number.';
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reason).toBe("unreadable-citation");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a `..`-escaping citation path as unreadable instead of reading outside the root", () => {
    const root = makeFixtureRoot();
    // A real, readable file that sits OUTSIDE root (root's own parent
    // directory), standing in for something like /etc/passwd: if the
    // reader ever resolved this path without a containment check it would
    // open and "check" it.
    const outside = path.join(
      path.dirname(root),
      `secret-${path.basename(root)}.txt`,
    );
    fs.writeFileSync(outside, 'export const VERSION = "1.2.3";\n');
    const relEscape = `../${path.basename(outside)}`;
    const doc = `The constant is \`VERSION = "1.2.3"\` (\`${relEscape}:1\`), a path escaping the root.`;
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reason).toBe("unreadable-citation");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });

  it("rejects a sibling directory sharing the root's path prefix (`<root>-other`) as unreadable", () => {
    // The only input that separates `startsWith(root + sep)` from a bare
    // `startsWith(root)`: a sibling whose path begins with the root's own
    // characters. Without the separator in the containment test this file
    // would be opened and "checked".
    const root = makeFixtureRoot();
    const sibling = `${root}-other`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(
      path.join(sibling, "x.ts"),
      'export const VERSION = "1.2.3";\n',
    );
    const relSibling = `../${path.basename(sibling)}/x.ts`;
    const doc = `The constant is \`VERSION = "1.2.3"\` (\`${relSibling}:1\`), a sibling-prefix path.`;
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reason).toBe("unreadable-citation");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  });

  // T-010 (agent-tasks tracker 5e95e4bd): a citation path can be lexically
  // inside root (passes the `..`-escape check above) while being an
  // in-root symlink whose REAL target sits outside root -- the escape the
  // pre-T-010 `path.resolve`-only containment test could not see.
  it("rejects an in-root symlink whose real target sits outside the root as unreadable", () => {
    const root = makeFixtureRoot();
    const outside = path.join(
      path.dirname(root),
      `secret-target-${path.basename(root)}.txt`,
    );
    fs.writeFileSync(outside, 'export const VERSION = "1.2.3";\n');
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const link = path.join(root, "src", "escape.ts");
    fs.symlinkSync(outside, link);
    const doc =
      'The constant is `VERSION = "1.2.3"` (`src/escape.ts:1`), read through an in-root symlink pointing outside the root.';
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].reason).toBe("unreadable-citation");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });

  // Negative control for the fix above: an in-root symlink whose real
  // target is ALSO in-root must still read normally -- the escape check
  // must compare realpaths against each other, not merely require the
  // lexical path to differ from a real one.
  it("still reads through an in-root symlink whose real target is also in-root", () => {
    const root = makeFixtureRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const target = path.join(root, "src", "real.ts");
    fs.writeFileSync(target, 'export const VERSION = "1.2.3";\n');
    const link = path.join(root, "src", "alias.ts");
    fs.symlinkSync(target, link);
    const doc =
      'The constant is `VERSION = "1.2.3"` (`src/alias.ts:1`), read through an in-root symlink pointing at another in-root file.';
    const [{ result }] = analyzeAndCheck(root, doc);
    expect(result.findings).toHaveLength(0);
    expect(result.checkedCount).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
