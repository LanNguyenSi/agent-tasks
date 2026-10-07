#!/usr/bin/env node
// npm-audit gate classifier with an ID-scoped, dated allowlist.
//
// Used by .github/workflows/audit.yml. Dependency-free Node 20 (the audit job
// runs no `npm ci`), so it can be copied verbatim into any tree that carries
// the same workflow.
//
// Input: the captured output of `npm audit --audit-level=high --json` (stdout
// and stderr in separate files) plus npm's exit status, and the allowlist
// file. Exit codes keep the four outcomes the workflow header documents:
//   0  CLEAN         the endpoint answered; no HIGH/CRITICAL advisory remains
//                    after the allowlist (allowlisted-only counts as clean and
//                    the entries used are printed).
//   1  FINDINGS      HIGH/CRITICAL advisories that are not allowlisted, or an
//                    allowlist entry whose reviewBy date is before today (UTC),
//                    even when the advisory is gone.
//   2  OUTAGE        the registry did not answer (npm error text, DNS or
//                    connection failure, or the local timeout, status 124).
//                    NOT an advisory finding; retry later.
//   3  UNCLASSIFIED  anything else: a report whose metadata HIGH plus CRITICAL
//                    count disagrees with its vulnerabilities map (or has no
//                    metadata tally), a malformed or unreadable allowlist (an
//                    entry whose reviewBy lies more than 90 days after today
//                    (UTC) counts as malformed), a report that cannot be
//                    parsed, an npm failure without an outage marker (missing
//                    lockfile, wrong directory).
//
// Matching is by exact GHSA id taken from `vulnerabilities.<pkg>.via[].url`;
// never by severity or package name. A package whose via chain (string
// entries name other vulnerable packages, followed recursively with a cycle
// guard) resolves only to allowlisted advisories counts as excepted; any other
// HIGH/CRITICAL advisory in its chain keeps it a finding.
//
// The CLEAN outcome prints the line `npm audit gate: CLEAN: ...`; the workflow
// step fails an exit 0 that is not accompanied by it. A path to a missing
// script exits 1 (MODULE_NOT_FOUND) on its own; only a path to a different
// existing file, or an `--import`-style invocation that never reaches this
// entry point, exits 0 without classifying, and the CLEAN-line check catches
// that. npm's stderr is printed by this script, sanitised, not by the
// workflow.
//
// Usage:
//   node scripts/audit-gate.mjs --allowlist <file> --status <npm exit code> \
//     --stdout <file> [--stderr <file>]

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_OUTAGE = 2;
export const EXIT_UNCLASSIFIED = 3;

// Transient registry-side and network failures only. HTTP 4xx codes other than
// 429 (credentials, scope, wrong registry URL) are deliberately NOT here; they
// fall through to UNCLASSIFIED because "retry later" is wrong advice for a
// configuration error.
const OUTAGE_MARKER =
  /audit endpoint returned an error|Invalid package tree|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|ERR_SOCKET_TIMEOUT|network|E5[0-9]{2}|E429/;

const GHSA_ID = /^GHSA(?:-[2-9cfghjmpqrvwx]{4}){3}$/;
const GHSA_URL = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[2-9cfghjmpqrvwx]{4}){3})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEYS = ['id', 'reason', 'reviewBy'];
// An entry may postpone its review by at most this many days from today (UTC),
// so a renewal cannot quietly park an exception for years.
export const MAX_REVIEW_HORIZON_DAYS = 90;
const NON_GATING_SEVERITIES = new Set(['info', 'low', 'moderate']);

export class AllowlistError extends Error {}

// Names and ids from npm's report or the allowlist are printed into workflow
// log lines; strip everything that could forge a workflow command or break a
// line.
function clean(text) {
  return String(text).replace(/[^A-Za-z0-9@/._ ,;:()=+-]/g, '?');
}

// npm's stderr is registry- and proxy-influenced text. Every line is printed
// behind a fixed prefix (a workflow command only counts at the start of a
// line), reduced to the same safe character set as the script's own output,
// with "::" broken up for good measure, and bounded in count and length.
const STDERR_MAX_LINES = 40;
const STDERR_MAX_LINE_LENGTH = 300;

export function sanitizeStderr(stderr) {
  const raw = String(stderr)
    .split(/\r\n|\n|\r|\u2028|\u2029/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const lines = raw.slice(0, STDERR_MAX_LINES).map((line) => {
    const text = clean(line.slice(0, STDERR_MAX_LINE_LENGTH)).replace(/:{2,}/g, ': :');
    return `npm stderr| ${text}`;
  });
  if (raw.length > STDERR_MAX_LINES) {
    lines.push(`npm stderr| (${raw.length - STDERR_MAX_LINES} more line(s) omitted)`);
  }
  return lines;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRealDate(text) {
  if (!DATE_ONLY.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

// Parses the allowlist file text. Throws AllowlistError (message names the
// file) for anything other than { "entries": [ { id, reason, reviewBy } ] }.
// With `today` (YYYY-MM-DD, UTC) a reviewBy more than MAX_REVIEW_HORIZON_DAYS
// after it is rejected as well.
export function parseAllowlist(text, file, today) {
  const fail = (why) => {
    throw new AllowlistError(`allowlist ${clean(file)}: ${why}`);
  };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return fail(`not valid JSON (${clean(err.message)})`);
  }
  if (!isRecord(data)) return fail('top level must be an object with an "entries" array');
  for (const key of Object.keys(data)) {
    if (key !== 'entries') fail(`unknown top-level key "${clean(key)}"`);
  }
  if (!Array.isArray(data.entries)) return fail('"entries" must be an array');
  const seen = new Set();
  const entries = data.entries.map((entry, index) => {
    const where = `entry ${index}`;
    if (!isRecord(entry)) return fail(`${where} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) fail(`${where} has unknown key "${clean(key)}"`);
    }
    for (const key of ENTRY_KEYS) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
        fail(`${where} is missing a non-empty string "${key}"`);
      }
    }
    if (!GHSA_ID.test(entry.id)) fail(`${where} id "${clean(entry.id)}" is not a GHSA id`);
    if (!isRealDate(entry.reviewBy)) {
      fail(`${where} reviewBy "${clean(entry.reviewBy)}" is not a YYYY-MM-DD date`);
    }
    if (today !== undefined) {
      const latest = addDays(today, MAX_REVIEW_HORIZON_DAYS);
      if (entry.reviewBy > latest) {
        fail(
          `${where} id ${entry.id} reviewBy ${entry.reviewBy} is more than ${MAX_REVIEW_HORIZON_DAYS} days after today (${today} UTC); the latest accepted date is ${latest}`,
        );
      }
    }
    if (seen.has(entry.id)) fail(`duplicate id ${entry.id}`);
    seen.add(entry.id);
    return { id: entry.id, reason: entry.reason, reviewBy: entry.reviewBy };
  });
  return entries;
}

// The GHSA id of an npm audit advisory object, or null when the url is not
// exactly a GitHub advisory url.
export function advisoryId(via) {
  if (!isRecord(via) || typeof via.url !== 'string') return null;
  const match = GHSA_URL.exec(via.url);
  return match ? match[1] : null;
}

function isGating(severity) {
  return !NON_GATING_SEVERITIES.has(severity);
}

// Walks the via chain of one vulnerable package. Advisory objects are matched
// by GHSA id; string entries name another vulnerable package and are followed
// recursively. Returns whether the whole chain is excepted, plus what the walk
// saw.
function chainIsExcepted(name, vulns, allowIds, state) {
  if (state.visited.has(name)) return true; // cycle guard: already being walked
  state.visited.add(name);
  const node = vulns[name];
  if (!isRecord(node) || !Array.isArray(node.via)) {
    state.blocking.add(`unresolvable:${name}`);
    return false;
  }
  let ok = true;
  for (const via of node.via) {
    if (typeof via === 'string') {
      if (!chainIsExcepted(via, vulns, allowIds, state)) ok = false;
    } else if (isRecord(via)) {
      if (!isGating(via.severity)) continue;
      const id = advisoryId(via);
      if (id !== null && allowIds.has(id)) {
        state.used.add(id);
      } else {
        state.blocking.add(id === null ? `no-ghsa-id:${name}` : id);
        ok = false;
      }
    } else {
      state.blocking.add(`unresolvable:${name}`);
      ok = false;
    }
  }
  return ok;
}

// Allowlist ids that appear as an advisory anywhere in the report's via
// chains, whatever the package's severity or whether it ends up a finding.
function matchedIds(vulns, allowIds) {
  const matched = new Set();
  for (const node of Object.values(vulns)) {
    if (!isRecord(node) || !Array.isArray(node.via)) continue;
    for (const via of node.via) {
      const id = advisoryId(via);
      if (id !== null && allowIds.has(id)) matched.add(id);
    }
  }
  return matched;
}

// Classifies a parsed audit report against allowlisted ids. Returns the
// findings (non-excepted HIGH/CRITICAL packages), the allowlist ids used and
// the packages they excepted, and the ids matched at all (an id can be
// matched yet unused when its package is still a finding for another reason).
export function evaluateReport(report, allowIds) {
  const vulns = report.vulnerabilities;
  const findings = [];
  const used = new Map(); // id -> Set of package names
  for (const name of Object.keys(vulns).sort()) {
    const node = vulns[name];
    if (!isRecord(node)) {
      findings.push({ name, severity: 'unknown', blocking: ['unresolvable'] });
      continue;
    }
    const direct = Array.isArray(node.via)
      ? node.via.some((via) => isRecord(via) && isGating(via.severity))
      : false;
    if (!isGating(node.severity) && !direct) continue;
    const state = { visited: new Set(), used: new Set(), blocking: new Set() };
    const ok = chainIsExcepted(name, vulns, allowIds, state);
    if (ok && state.used.size > 0) {
      for (const id of state.used) {
        if (!used.has(id)) used.set(id, new Set());
        used.get(id).add(name);
      }
    } else {
      if (state.blocking.size === 0) state.blocking.add('no-advisory-resolved');
      findings.push({
        name,
        severity: typeof node.severity === 'string' ? node.severity : 'unknown',
        blocking: [...state.blocking].sort(),
      });
    }
  }
  return { findings, used, matched: matchedIds(vulns, allowIds) };
}

function parseReport(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  return data;
}

// Cross-checks metadata.vulnerabilities (npm's own tally) against the
// vulnerabilities map the classifier walks. Returns a reason string when the
// report is inconsistent or the tally is absent, null when the HIGH plus
// CRITICAL counts agree. A report whose tally claims more gating packages
// than the map shows (or the reverse) cannot be trusted to be classified from
// the map alone.
export function metadataDisagreement(data) {
  const tally = isRecord(data.metadata) ? data.metadata.vulnerabilities : undefined;
  if (!isRecord(tally)) return 'the report has no metadata.vulnerabilities tally to cross-check';
  const { high, critical } = tally;
  const isCount = (n) => Number.isInteger(n) && n >= 0;
  if (!isCount(high) || !isCount(critical)) {
    return 'metadata.vulnerabilities.high and .critical are not non-negative integers';
  }
  let mapCount = 0;
  for (const node of Object.values(data.vulnerabilities)) {
    if (isRecord(node) && (node.severity === 'high' || node.severity === 'critical')) mapCount += 1;
  }
  if (high + critical !== mapCount) {
    return `metadata counts ${high + critical} HIGH/CRITICAL package(s) but the vulnerabilities map holds ${mapCount}`;
  }
  return null;
}

function isAuditReport(data) {
  return (
    data !== null && data.auditReportVersion === 2 && isRecord(data.vulnerabilities)
  );
}

// Core decision. Pure: no file or clock access. `today` is YYYY-MM-DD (UTC).
// Returns { exitCode, lines } where each line is a log line (workflow
// annotations included).
export function classify({ stdout = '', stderr = '', status, allowlistText, allowlistFile, today }) {
  // npm's own diagnostics go through the sanitiser, never straight to the log.
  const lines = sanitizeStderr(stderr);
  const unclassified = (why) => {
    lines.push(`::error::npm audit gate: UNCLASSIFIED: ${why}`);
    return { exitCode: EXIT_UNCLASSIFIED, lines };
  };

  let entries;
  try {
    entries = parseAllowlist(allowlistText, allowlistFile, today);
  } catch (err) {
    if (err instanceof AllowlistError) return unclassified(err.message);
    throw err;
  }
  const allowIds = new Set(entries.map((entry) => entry.id));

  const expired = entries.filter((entry) => entry.reviewBy < today);
  for (const entry of expired) {
    lines.push(
      `::error::npm audit gate: allowlist entry ${entry.id} expired (reviewBy ${entry.reviewBy}, today ${today} UTC); review it and either renew reviewBy with a recorded reason or remove the entry`,
    );
  }

  const audit = classifyAudit({
    stdout,
    stderr,
    status,
    allowIds,
    entries,
    lines,
    expiredFound: expired.length > 0,
  });
  if (expired.length > 0) {
    lines.push('npm audit gate: FINDINGS: expired allowlist entries (see above)');
    return { exitCode: EXIT_FINDINGS, lines };
  }
  return audit;
}

function classifyAudit({ stdout, stderr, status, allowIds, entries, lines, expiredFound }) {
  const result = (exitCode) => ({ exitCode, lines });

  if (status === 124) {
    lines.push(
      '::error::npm audit gate: OUTAGE: npm audit did not return within the local timeout (ERR_SOCKET_TIMEOUT); this is NOT an advisory finding, retry the job later',
    );
    return result(EXIT_OUTAGE);
  }

  const data = parseReport(stdout);
  if (data !== null && isAuditReport(data)) {
    if (status !== 0 && status !== 1) {
      lines.push(
        `::error::npm audit gate: UNCLASSIFIED: npm audit exited with status ${clean(status)} but printed an audit report; check the log`,
      );
      return result(EXIT_UNCLASSIFIED);
    }
    const disagreement = metadataDisagreement(data);
    if (disagreement !== null) {
      lines.push(
        `::error::npm audit gate: UNCLASSIFIED: inconsistent audit report: ${clean(disagreement)}; check the log`,
      );
      return result(EXIT_UNCLASSIFIED);
    }
    const { findings, used, matched } = evaluateReport(data, allowIds);
    for (const entry of entries) {
      if (!matched.has(entry.id)) {
        lines.push(
          `::warning::npm audit gate: allowlist entry ${entry.id} matched no advisory in this tree (unmatched entries are warnings only)`,
        );
      }
    }
    if (findings.length > 0) {
      lines.push(
        `::error::npm audit gate: FINDINGS: ${findings.length} package(s) with HIGH or CRITICAL advisories not covered by the allowlist`,
      );
      for (const finding of findings) {
        lines.push(
          `  - ${clean(finding.name)} (${clean(finding.severity)}): ${finding.blocking.map(clean).join(', ')}`,
        );
      }
      return result(EXIT_FINDINGS);
    }
    if (used.size === 0 && status !== 0) {
      lines.push(
        '::error::npm audit gate: UNCLASSIFIED: npm audit failed but the report holds no HIGH or CRITICAL advisory; check the log',
      );
      return result(EXIT_UNCLASSIFIED);
    }
    if (expiredFound) return result(EXIT_CLEAN); // caller turns this into FINDINGS
    for (const entry of entries) {
      const packages = used.get(entry.id);
      if (!packages) continue;
      lines.push(
        `npm audit gate: excepted by allowlist: ${entry.id} (reviewBy ${entry.reviewBy}; ${clean(entry.reason)}) for ${[...packages].sort().map(clean).join(', ')}`,
      );
    }
    lines.push('npm audit gate: CLEAN: no HIGH or CRITICAL advisories outside the allowlist.');
    return result(EXIT_CLEAN);
  }

  // No audit report. npm's JSON error body carries the registry error in
  // `message` (and sometimes error.code/summary/detail); stderr carries the
  // same text. Scan all of them for an outage marker.
  const haystack = [stdout, stderr].join('\n');
  if (status === 0) {
    lines.push(
      '::error::npm audit gate: UNCLASSIFIED: npm audit exited 0 but printed no audit report; check the log',
    );
    return result(EXIT_UNCLASSIFIED);
  }
  if (OUTAGE_MARKER.test(haystack)) {
    lines.push(
      '::error::npm audit gate: OUTAGE: the audit endpoint did not answer (registry outage), this is NOT an advisory finding; retry the job later',
    );
    return result(EXIT_OUTAGE);
  }
  lines.push(
    `::error::npm audit gate: UNCLASSIFIED: npm audit failed with status ${clean(status)} and produced neither an audit report nor an outage marker; check the log and the working-directory`,
  );
  return result(EXIT_UNCLASSIFIED);
}

function parseArgs(argv) {
  const out = {};
  const known = ['--allowlist', '--status', '--stdout', '--stderr'];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!known.includes(flag) || value === undefined) return null;
    out[flag.slice(2)] = value;
  }
  if (out.allowlist === undefined || out.status === undefined || out.stdout === undefined) {
    return null;
  }
  if (!/^\d+$/.test(out.status)) return null;
  return out;
}

export function main(argv, io = { log: console.log, readFile: fs.readFileSync }) {
  const args = parseArgs(argv);
  // npm's stderr is printed (sanitised) before anything else, on every path,
  // so an early exit never hides it and never prints it raw. On a usage error
  // the --stderr value is looked up leniently, since the arguments did not parse.
  const stderrFile =
    args !== null
      ? args.stderr
      : argv.indexOf('--stderr') >= 0
        ? argv[argv.indexOf('--stderr') + 1]
        : undefined;
  let stderr = '';
  let stderrUnreadable = null;
  if (stderrFile !== undefined) {
    try {
      stderr = io.readFile(stderrFile, 'utf8');
    } catch (err) {
      stderrUnreadable = err;
    }
  }
  const printStderr = () => {
    for (const line of sanitizeStderr(stderr)) io.log(line);
  };
  if (args === null) {
    printStderr();
    io.log(
      '::error::npm audit gate: UNCLASSIFIED: usage: audit-gate.mjs --allowlist <file> --status <npm exit code> --stdout <file> [--stderr <file>]',
    );
    return EXIT_UNCLASSIFIED;
  }
  let allowlistText;
  try {
    allowlistText = io.readFile(args.allowlist, 'utf8');
  } catch (err) {
    printStderr();
    io.log(
      `::error::npm audit gate: UNCLASSIFIED: allowlist ${clean(args.allowlist)}: cannot be read (${clean(err.code ?? err.message)})`,
    );
    return EXIT_UNCLASSIFIED;
  }
  let stdout = '';
  try {
    stdout = io.readFile(args.stdout, 'utf8');
    if (stderrUnreadable !== null) throw stderrUnreadable;
  } catch (err) {
    printStderr();
    io.log(
      `::error::npm audit gate: UNCLASSIFIED: captured npm audit output cannot be read (${clean(err.code ?? err.message)})`,
    );
    return EXIT_UNCLASSIFIED;
  }
  const { exitCode, lines } = classify({
    stdout,
    stderr,
    status: Number(args.status),
    allowlistText,
    allowlistFile: args.allowlist,
    today: todayUtc(),
  });
  for (const line of lines) io.log(line);
  return exitCode;
}

// True when this module is the process entry point, whatever the spelling of
// the path it was started through: import.meta.url is symlink-resolved while
// process.argv[1] is not, so both sides go through realpath. A mismatch here
// would skip main() and exit 0 silently, a green gate with findings. A realpath
// error is not caught: it can only happen if the file vanishes after Node loaded
// it, and an uncaught error exits non-zero (fail closed), never 0.
export function isEntryPoint(argv1, moduleUrl) {
  if (!argv1) return false;
  return (
    pathToFileURL(fs.realpathSync(argv1)).href ===
    pathToFileURL(fs.realpathSync(fileURLToPath(moduleUrl))).href
  );
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
