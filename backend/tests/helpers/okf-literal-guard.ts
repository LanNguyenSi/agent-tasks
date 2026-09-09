// Guard for T-007 (agent-tasks tracker 3feb590f, batch45 D-011): quoted VALUE
// literals that sit next to a docs/okf line citation must be verifiable
// against the actual cited source line(s), so a re-stamp that only touches
// timestamps (okf-kit's sources-fresh check) cannot leave a wrong literal
// behind the way batch-43's SERVER_VERSION 0.13.0-vs-0.14.0 and the
// backlog_not_promoted allowedNext array did.
//
// Scope, per orchestrator decision D-011 (docs/okf/index.md Maintenance):
// a value literal is checked only when a `path:N`/`path:N-M` line citation
// (with or without a `#"anchor"`) sits within WORD_WINDOW words of it, on
// either side, inside the same blank-line-delimited markdown block. Bare
// identifiers (`fooBar`, `foo()`, `Foo.bar`, bare filenames) are never
// checked -- that class false-positives on every "x calls y (path:12)"
// sentence. `log.md` narrates history (old, now-superseded values); its
// counts are reported but never asserted, the same way T-001 exempted it
// from the bare-citation ratchet.

import fs from "node:fs";
import path from "node:path";

/** Word-proximity window (decision D-011): tunable, named here and in docs/okf/index.md. */
export const WORD_WINDOW = 30;

const CITATION_RE = /^([\w./-]+):(\d+)(?:-(\d+))?(?:#"(?:[^"\\]|\\.)*")?$/;
const KEYVAL_RE = /^([A-Za-z_]\w*)\s*:\s*(\S.*)$/;
const QUOTED_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const SEMVER_RE = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?\b/g;

// Backtick-span-or-plain-word unit scanner (T-007 round 2, D-018): a single
// global pass over the normalized block. Each match is EITHER a complete
// backtick span (`` `[^`]+` ``, tried first at every position) OR a maximal
// run of characters that are neither whitespace nor a backtick. Putting the
// span alternative first, and excluding backtick from the plain-word
// alternative, is what makes two spans glued together with no whitespace
// between them (`` `mode: "0.13.0"`/`other: "9.9.9"` ``) resolve as THREE
// units (span, "/", span) instead of one corrupted token that swallows the
// second span's opening backtick -- the round-1 bug that silently dropped
// 61 of 1470 backtick spans bundle-wide and, when the dropped span carried
// a citation, the citation with it. Every unit advances the word index by
// one; a backtick span counts as one word regardless of any internal
// whitespace, since `[^`]+` matches straight through it.
const UNIT_RE = /`[^`]+`|[^\s`]+/g;
const SPAN_RE = /`[^`]+`/g;

export type LiteralKind = "keyval" | "quoted" | "json" | "semver";

export interface Citation {
  /** citation text as written in the doc, e.g. "ci.yml" or "mcp-server/src/server.ts" */
  rawPath: string;
  /** path resolved against the doc's frontmatter `sources:` list, relative to repo root */
  path: string;
  start: number;
  end: number;
  tokenIndex: number;
}

export interface LiteralToken {
  text: string;
  kind: LiteralKind;
  tokenIndex: number;
}

export interface BlockAnalysis {
  block: string;
  citations: Citation[];
  literals: LiteralToken[];
  bareCount: number;
  /** Backtick spans the unit scanner actually classified (span/word/bare/literal); the caller compares the per-file sum against countSpans over the raw file body as a parser self-check. */
  spansSeen: number;
}

export interface Finding {
  literal: string;
  citations: string[];
  /** "unreadable-citation": every in-window citation was start<1 or an unresolvable file/line. "literal-mismatch": at least one citation read cleanly but none matched. */
  reason: "unreadable-citation" | "literal-mismatch";
}

export interface BlockCheckResult {
  findings: Finding[];
  checkedCount: number;
  skippedBeyondWindowCount: number;
  bareCount: number;
}

export function stripFrontmatter(text: string): string {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) return text.slice(end + 5);
  }
  return text;
}

export function parseFrontmatterSources(text: string): string[] {
  if (!text.startsWith("---\n")) return [];
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return [];
  const fm = text.slice(4, end);
  const m = fm.match(/sources:\n((?:\s+-\s+.+\n?)+)/);
  if (!m) return [];
  return [...m[1].matchAll(/-\s+(\S+)/g)].map((x) => x[1]);
}

/** Blank-line-delimited markdown blocks (headings, list runs, prose paragraphs alike). */
export function extractBlocks(text: string): string[] {
  return stripFrontmatter(text)
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Independent count of complete backtick spans in a (normalized) block, used as the spansSeen self-check baseline. */
export function countSpans(block: string): number {
  return (block.match(SPAN_RE) ?? []).length;
}

function tryJsonLiteral(s: string): boolean {
  try {
    const v = JSON.parse(s);
    return (
      Array.isArray(v) ||
      (typeof v === "object" && v !== null) ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      typeof v === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Extracts VALUE literals from a non-citation backtick-span's content:
 * a `key: value` pair, a quoted string, a JSON-literal array/object, or a
 * semver. Returns [] for a bare identifier (`fooBar`, `foo()`, `Foo.bar`,
 * a bare filename) -- that class is never checked.
 */
export function extractLiteralsFromSpan(
  spanContent: string,
): { text: string; kind: LiteralKind }[] {
  const kv = spanContent.match(KEYVAL_RE);
  if (kv) return [{ text: spanContent, kind: "keyval" }];
  const quoted = [...spanContent.matchAll(QUOTED_RE)];
  if (quoted.length)
    return quoted.map((m) => ({ text: m[0], kind: "quoted" as const }));
  if (tryJsonLiteral(spanContent.trim()))
    return [{ text: spanContent.trim(), kind: "json" }];
  const semver = [...spanContent.matchAll(SEMVER_RE)];
  if (semver.length)
    return semver.map((m) => ({ text: m[0], kind: "semver" as const }));
  return [];
}

export function resolveCitationPath(
  citationPath: string,
  sources: string[],
): string {
  if (citationPath.includes("/")) return citationPath;
  const matches = sources.filter((s) => path.basename(s) === citationPath);
  if (matches.length === 1) return matches[0];
  return citationPath;
}

/**
 * Single global scan of the normalized block for backtick-span-or-word
 * units (see UNIT_RE above). Every unit advances the word index; a
 * classified backtick span (citation or literal) increments spansSeen so
 * the caller can assert the per-file sum against countSpans over the raw
 * file body (frontmatter stripped, no block extraction, so a block-level
 * drop fails too; the baseline assumes no fenced code blocks in the
 * bundle): any future parser gap that drops a span fails that assertion
 * loudly instead of silently undercounting.
 */
export function analyzeBlock(block: string, sources: string[]): BlockAnalysis {
  const normalized = block.replace(/\s+/g, " ").trim();
  const units = normalized.match(UNIT_RE) ?? [];
  const citations: Citation[] = [];
  const literals: LiteralToken[] = [];
  let bareCount = 0;
  let spansSeen = 0;

  units.forEach((unit, tokenIndex) => {
    const isSpan =
      unit.length >= 2 && unit[0] === "`" && unit[unit.length - 1] === "`";
    if (!isSpan) return;
    spansSeen++;
    const spanContent = unit.slice(1, -1);
    const cm = spanContent.match(CITATION_RE);
    if (cm) {
      citations.push({
        rawPath: cm[1],
        path: resolveCitationPath(cm[1], sources),
        start: Number(cm[2]),
        end: cm[3] ? Number(cm[3]) : Number(cm[2]),
        tokenIndex,
      });
      return;
    }
    const lits = extractLiteralsFromSpan(spanContent);
    if (lits.length) {
      for (const { text, kind } of lits)
        literals.push({ text, kind, tokenIndex });
    } else {
      bareCount++;
    }
  });

  return { block: normalized, citations, literals, bareCount, spansSeen };
}

function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a normalized literal occurs in a normalized haystack. Plain
 * substring `includes()` for everything except semver: a bare semver needs
 * a non-word boundary on both sides so a doc claiming `0.14.0` is not
 * silently validated by a cited line that actually says `0.14.0-rc1` (a
 * strict superset string). Every other literal kind (quoted string,
 * key: value, JSON) keeps the substring check and its documented
 * false-negative direction (docs/okf/index.md Maintenance).
 */
function literalMatches(litN: string, kind: LiteralKind, hay: string): boolean {
  if (kind !== "semver") return hay.includes(litN);
  const re = new RegExp(`(?<![\\w.-])${escapeRegExp(litN)}(?![\\w.-])`);
  return re.test(hay);
}

export type LineReader = (
  relPath: string,
  start: number,
  end: number,
) => string | null;

/** A line reader rooted at `root`, caching each file's lines once. */
export function createFileLineReader(root: string): LineReader {
  const cache = new Map<string, string[]>();
  const resolvedRoot = path.resolve(root);
  return (relPath, start, end) => {
    let lines = cache.get(relPath);
    if (!lines) {
      const abs = path.resolve(resolvedRoot, relPath);
      // Reject a citation path that escapes the repo root via `..`
      // segments (e.g. `../../../../etc/passwd:1`) before it is ever
      // opened: `CITATION_RE` permits `.`/`-`/`/` in the path component,
      // so a `..` segment is syntactically a valid citation and must be
      // rejected here instead, reported as "unreadable-citation".
      if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
        cache.set(relPath, []);
        return null;
      }
      if (!fs.existsSync(abs)) {
        cache.set(relPath, []);
        return null;
      }
      lines = fs.readFileSync(abs, "utf8").split("\n");
      cache.set(relPath, lines);
    }
    if (lines.length === 0) return null;
    return lines.slice(start - 1, end).join("\n");
  };
}

/**
 * Checks one block's literals against its own citations, scoped to
 * WORD_WINDOW words on either side. A literal with no citation in-window is
 * not checked at all (skippedBeyondWindowCount); a literal with a citation
 * in-window whose cited lines do not contain the literal text is a finding.
 * A citation with start < 1 is rejected before it ever reaches the line
 * reader: createFileLineReader's `lines.slice(start - 1, end)` would wrap
 * negatively for start === 0 and can accidentally "verify" against the
 * file's last line. A finding whose in-window citations were ALL
 * unreadable (start < 1, or the file/line does not resolve) is reported
 * with reason "unreadable-citation" rather than "literal-mismatch" -- a
 * missing file is not the same defect as a wrong value.
 */
export function checkBlock(
  analysis: BlockAnalysis,
  readLines: LineReader,
): BlockCheckResult {
  const findings: Finding[] = [];
  let checkedCount = 0;
  let skippedBeyondWindowCount = 0;

  for (const lit of analysis.literals) {
    const inWindow = analysis.citations.filter(
      (c) => Math.abs(c.tokenIndex - lit.tokenIndex) <= WORD_WINDOW,
    );
    if (inWindow.length === 0) {
      skippedBeyondWindowCount++;
      continue;
    }
    checkedCount++;
    const litN = normalizeForCompare(lit.text);
    let readableCount = 0;
    let matched = false;
    for (const c of inWindow) {
      if (c.start < 1) continue;
      const snippet = readLines(c.path, c.start, c.end);
      if (snippet === null) continue;
      readableCount++;
      if (literalMatches(litN, lit.kind, normalizeForCompare(snippet))) {
        matched = true;
      }
    }
    if (!matched) {
      findings.push({
        literal: lit.text,
        citations: inWindow.map((c) => `${c.rawPath}:${c.start}-${c.end}`),
        reason:
          readableCount === 0 ? "unreadable-citation" : "literal-mismatch",
      });
    }
  }

  return {
    findings,
    checkedCount,
    skippedBeyondWindowCount,
    bareCount: analysis.bareCount,
  };
}

/** Short human-readable anchor for allowlist keys: first ~8 words of the block, slugified. */
export function slugAnchor(block: string): string {
  const words = block
    .replace(/[`*_#]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return words || "block";
}

export interface AllowlistEntry {
  doc: string;
  anchor: string;
  literal: string;
  reason: string;
}

/** The single allowlist-match predicate: returns the matching entry, or undefined. */
export function matchAllowlistEntry(
  allowlist: AllowlistEntry[],
  doc: string,
  anchor: string,
  literal: string,
): AllowlistEntry | undefined {
  return allowlist.find(
    (e) => e.doc === doc && e.anchor === anchor && e.literal === literal,
  );
}

export function isAllowlisted(
  allowlist: AllowlistEntry[],
  doc: string,
  anchor: string,
  literal: string,
): boolean {
  return matchAllowlistEntry(allowlist, doc, anchor, literal) !== undefined;
}
