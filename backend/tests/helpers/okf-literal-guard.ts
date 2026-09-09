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

const CITATION_RE =
  /^([\w./-]+):(\d+)(?:-(\d+))?(?:#"(?:[^"\\]|\\.)*")?$/;
const KEYVAL_RE = /^([A-Za-z_]\w*)\s*:\s*(\S.*)$/;
const QUOTED_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const SEMVER_RE = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?\b/g;
const SPAN_IN_TOKEN_RE = /`([^`]+)`/;
// Tokenizer for word-distance counting (decision D-011: "code spans count as
// one word each"). A backtick span may contain internal spaces
// (`` `allowedNext: ["a", "b"]` ``) and still must be ONE token; it may also
// be glued to surrounding punctuation with no space ("(`github.ts:352`,").
// First alternative: optional non-space/non-backtick prefix, a backtick
// span (content may contain spaces, just no nested backtick), optional
// non-space suffix -- all one token. Second alternative: any other run of
// non-space characters.
const WORD_TOKEN_RE = /[^\s`]*`[^`]*`[^\s]*|\S+/g;

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
  tokenIndex: number;
}

export interface BlockAnalysis {
  block: string;
  citations: Citation[];
  literals: LiteralToken[];
  bareCount: number;
}

export interface Finding {
  literal: string;
  citations: string[];
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
export function extractLiteralsFromSpan(spanContent: string): string[] {
  const kv = spanContent.match(KEYVAL_RE);
  if (kv) return [spanContent];
  const quoted = [...spanContent.matchAll(QUOTED_RE)];
  if (quoted.length) return quoted.map((m) => m[0]);
  if (tryJsonLiteral(spanContent.trim())) return [spanContent.trim()];
  const semver = [...spanContent.matchAll(SEMVER_RE)];
  if (semver.length) return semver.map((m) => m[0]);
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
 * Splits a normalized (whitespace-collapsed) block on whitespace, then, for
 * each token, looks for an EMBEDDED backtick span rather than requiring the
 * whole token to be one -- a citation glued to surrounding punctuation
 * ("(`github.ts:352`," has no whitespace to split it from the paren/comma)
 * still resolves correctly this way. Every whitespace-delimited token,
 * backtick-bearing or not, advances the word index by one.
 */
export function analyzeBlock(block: string, sources: string[]): BlockAnalysis {
  const normalized = block.replace(/\s+/g, " ").trim();
  const tokens = normalized.match(WORD_TOKEN_RE) ?? [];
  const citations: Citation[] = [];
  const literals: LiteralToken[] = [];
  let bareCount = 0;

  tokens.forEach((tok, tokenIndex) => {
    const m = tok.match(SPAN_IN_TOKEN_RE);
    if (!m) return;
    const spanContent = m[1];
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
      for (const text of lits) literals.push({ text, tokenIndex });
    } else {
      bareCount++;
    }
  });

  return { block: normalized, citations, literals, bareCount };
}

function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export type LineReader = (
  relPath: string,
  start: number,
  end: number,
) => string | null;

/** A line reader rooted at `root`, caching each file's lines once. */
export function createFileLineReader(root: string): LineReader {
  const cache = new Map<string, string[]>();
  return (relPath, start, end) => {
    let lines = cache.get(relPath);
    if (!lines) {
      const abs = path.join(root, relPath);
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
    const ok = inWindow.some((c) => {
      const snippet = readLines(c.path, c.start, c.end);
      return snippet !== null && normalizeForCompare(snippet).includes(litN);
    });
    if (!ok) {
      findings.push({
        literal: lit.text,
        citations: inWindow.map((c) => `${c.rawPath}:${c.start}-${c.end}`),
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

export function isAllowlisted(
  allowlist: AllowlistEntry[],
  doc: string,
  anchor: string,
  literal: string,
): boolean {
  return allowlist.some(
    (e) => e.doc === doc && e.anchor === anchor && e.literal === literal,
  );
}
