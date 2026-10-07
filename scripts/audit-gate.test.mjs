// Self-test for scripts/audit-gate.mjs (node:test + node:assert, no npm
// dependencies: the audit workflow runs no `npm ci`).
//
// Fixtures under scripts/fixtures/audit-gate/ are real output of
// `npm audit --audit-level=high --json` captured from this repository's own
// lockfile tree(s) on 2026-10-06 (npm 11.18). The variants below (extra
// advisory, expired entry, error bodies) are derived from those shapes. Dates
// are computed from today (UTC), so the tests do not rot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'audit-gate.mjs');
const FIXTURE_DIR = path.join(here, 'fixtures', 'audit-gate');
const FIXTURES = ['root'];
const BRACES = 'GHSA-vfj7-8cjw-p6xm';
const OTHER = 'GHSA-2222-3333-4444';

function day(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

function allowlist(reviewBy, id = BRACES) {
  return JSON.stringify({ entries: [{ id, reason: 'test entry', reviewBy }] });
}

// npm derives metadata.vulnerabilities from the same package map the gate walks, and the
// gate cross-checks the two, so a synthetic report needs its tally recomputed after
// its map is edited.
function withTally(report) {
  const copy = structuredClone(report);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const entry of Object.values(copy.vulnerabilities)) {
    if (entry.severity in counts && entry.severity !== 'total') counts[entry.severity] += 1;
    counts.total += 1;
  }
  copy.metadata = { ...copy.metadata, vulnerabilities: counts };
  return copy;
}

// The fixture report plus one more HIGH advisory the allowlist does not cover.
function withOtherHigh(report) {
  const copy = structuredClone(report);
  copy.vulnerabilities['other-pkg'] = {
    name: 'other-pkg',
    severity: 'high',
    isDirect: true,
    via: [
      {
        source: 1,
        name: 'other-pkg',
        dependency: 'other-pkg',
        title: 'synthetic advisory',
        url: `https://github.com/advisories/${OTHER}`,
        severity: 'high',
        range: '*',
      },
    ],
    effects: [],
    range: '*',
    nodes: ['node_modules/other-pkg'],
    fixAvailable: false,
  };
  return withTally(copy);
}

function run({ report, stdoutText, stderrText = '', status, allowlistText, scriptPath = SCRIPT }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
  try {
    const out = path.join(dir, 'out.json');
    const err = path.join(dir, 'err.txt');
    const list = path.join(dir, 'allowlist.json');
    fs.writeFileSync(out, stdoutText ?? JSON.stringify(report));
    fs.writeFileSync(err, stderrText);
    fs.writeFileSync(list, allowlistText);
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--allowlist', list, '--status', String(status), '--stdout', out, '--stderr', err],
      { encoding: 'utf8' },
    );
    return { code: result.status, out: result.stdout + result.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const name of FIXTURES) {
  test(`${name}: allowlisted advisory only -> exit 0 and CLEAN`, () => {
    const r = run({ report: loadFixture(name), status: 1, allowlistText: allowlist(day(30)) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`excepted by allowlist: ${BRACES}`));
    assert.match(r.out, /CLEAN/);
  });

  test(`${name}: allowlisted plus another high advisory -> exit 1`, () => {
    const r = run({
      report: withOtherHigh(loadFixture(name)),
      status: 1,
      allowlistText: allowlist(day(30)),
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FINDINGS/);
    assert.match(r.out, /other-pkg/);
    assert.doesNotMatch(r.out, /CLEAN/);
  });
}

const BASE = FIXTURES[0];

test('expired allowlist entry -> exit 1 even though the advisory is still allowlisted', () => {
  const r = run({ report: loadFixture(BASE), status: 1, allowlistText: allowlist(day(-1)) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /expired/);
});

test('reviewBy beyond the 90 day horizon -> exit 3', () => {
  const r = run({ report: loadFixture(BASE), status: 1, allowlistText: allowlist(day(120)) });
  assert.equal(r.code, 3, r.out);
});

test('malformed allowlist -> exit 3', () => {
  const r = run({ report: loadFixture(BASE), status: 1, allowlistText: '{"entries": [{"id": "nope"}]}' });
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /UNCLASSIFIED/);
  const notJson = run({ report: loadFixture(BASE), status: 1, allowlistText: 'not json' });
  assert.equal(notJson.code, 3, notJson.out);
});

test('npm error JSON without a report -> exit 2 (outage)', () => {
  const body = JSON.stringify({
    error: {
      code: 'ENOTFOUND',
      summary: 'audit endpoint returned an error',
      detail: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed',
    },
  });
  const r = run({ stdoutText: body, stderrText: 'npm error code ENOTFOUND\n', status: 1, allowlistText: allowlist(day(30)) });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /OUTAGE/);
});

test('npm error JSON without outage marker -> exit 3', () => {
  const body = JSON.stringify({ error: { code: 'ENOLOCK', summary: 'missing lockfile' } });
  const r = run({ stdoutText: body, status: 1, allowlistText: allowlist(day(30)) });
  assert.equal(r.code, 3, r.out);
});

test('local timeout (status 124) -> exit 2', () => {
  const r = run({ stdoutText: '', status: 124, allowlistText: allowlist(day(30)) });
  assert.equal(r.code, 2, r.out);
});

test('script started through a symlink still runs main(): findings -> exit 1 with a FINDINGS line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-link-'));
  try {
    const link = path.join(dir, 'gate-link.mjs');
    fs.symlinkSync(SCRIPT, link);
    const r = run({
      report: withOtherHigh(loadFixture(BASE)),
      status: 1,
      allowlistText: allowlist(day(30)),
      scriptPath: link,
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FINDINGS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Hardened gate: metadata cross-check and sanitised npm stderr. These cases run the
// script as a child process like the ones above, on this tree's real npm output.
const HG_BASES = FIXTURES.map((name) => [name, loadFixture(name)]);
const HG_ID = 'GHSA-vfj7-8cjw-p6xm';

function hgRun({ report, stdout, stderr = '', status = 1, argv }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-hardened-'));
  try {
    const review = new Date();
    review.setUTCDate(review.getUTCDate() + 30);
    fs.writeFileSync(
      path.join(dir, 'allow.json'),
      JSON.stringify({ entries: [{ id: HG_ID, reason: 'test entry', reviewBy: review.toISOString().slice(0, 10) }] }),
    );
    fs.writeFileSync(path.join(dir, 'out.json'), stdout ?? JSON.stringify(report));
    fs.writeFileSync(path.join(dir, 'err.txt'), stderr);
    const args = argv
      ? argv(dir)
      : [
          '--allowlist', path.join(dir, 'allow.json'),
          '--status', String(status),
          '--stdout', path.join(dir, 'out.json'),
          '--stderr', path.join(dir, 'err.txt'),
        ];
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: result.status, text: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function hgWithCounts(report, counts) {
  const copy = structuredClone(report);
  copy.metadata = { ...copy.metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, ...counts } };
  return copy;
}

for (const [name, base] of HG_BASES) {
  test(`hardened gate: the real report's own metadata tally is not UNCLASSIFIED (${name})`, () => {
    const { code, text } = hgRun({ report: base });
    assert.equal(code, 0, text);
    assert.match(text, /^npm audit gate: CLEAN: /m);
  });
}

const [HG_NAME, HG_BASE] = HG_BASES[0];
const HG_TALLY = withTally(HG_BASE).metadata.vulnerabilities;

test(`hardened gate: a tally with criticals the map does not show is UNCLASSIFIED (${HG_NAME})`, () => {
  const { code, text } = hgRun({ report: hgWithCounts(HG_BASE, { high: HG_TALLY.high, critical: HG_TALLY.critical + 2 }) });
  assert.equal(code, 3, text);
  assert.match(text, /UNCLASSIFIED: inconsistent audit report/);
  assert.doesNotMatch(text, /CLEAN/);
});

test('hardened gate: a tally lower than the map is UNCLASSIFIED', () => {
  assert.ok(HG_TALLY.high > 0, 'fixture must carry a high advisory');
  const { code, text } = hgRun({ report: hgWithCounts(HG_BASE, { high: HG_TALLY.high - 1, critical: HG_TALLY.critical }) });
  assert.equal(code, 3, text);
  assert.doesNotMatch(text, /CLEAN/);
});

test('hardened gate: a report without a metadata tally is UNCLASSIFIED', () => {
  const copy = structuredClone(HG_BASE);
  delete copy.metadata;
  const { code, text } = hgRun({ report: copy });
  assert.equal(code, 3, text);
  assert.match(text, /no metadata\.vulnerabilities tally/);
});

test('hardened gate: a negative count that still sums to the map size is UNCLASSIFIED', () => {
  const { code, text } = hgRun({ report: hgWithCounts(HG_BASE, { high: HG_TALLY.high + HG_TALLY.critical + 1, critical: -1 }) });
  assert.equal(code, 3, text);
  assert.match(text, /not non-negative integers/);
});

test('hardened gate: non-integer counts are UNCLASSIFIED', () => {
  const { code, text } = hgRun({ report: hgWithCounts(HG_BASE, { high: String(HG_TALLY.high), critical: 0 }) });
  assert.equal(code, 3, text);
});

const HG_FORGED = [
  '::error::forged finding',
  'npm error ::set-output name=x::y',
  '::stop-commands::token',
  'npm error line\u2028::warning::split',
].join('\n');

test('hardened gate: no npm stderr line starts a workflow command', () => {
  const { text } = hgRun({ report: HG_BASE, stderr: HG_FORGED });
  for (const line of text.split('\n')) {
    assert.equal(/^::(?!(error|warning)::npm audit gate: )/.test(line), false, line);
  }
  assert.ok(!text.includes('::stop-commands::'));
  assert.ok(!text.includes('::set-output'));
  assert.ok(!text.includes('::error::forged'));
  assert.ok(!text.includes('::warning::split'));
  assert.ok(text.includes('npm stderr| '));
  assert.ok(text.includes('forged finding'));
});

test('hardened gate: the same holds when the stderr text decides an outage', () => {
  const { code, text } = hgRun({ stdout: '', stderr: '::error::forged\nnpm error code ENOTFOUND' });
  assert.equal(code, 2, text);
  assert.ok(!text.includes('\n::error::forged'));
  assert.ok(!text.startsWith('::error::forged'));
});

test('hardened gate: a long stderr is bounded', () => {
  const { text } = hgRun({ report: HG_BASE, stderr: 'x\n'.repeat(500) });
  assert.ok(text.split('\n').length < 80);
  assert.ok(text.includes('more line(s) omitted'));
});

test('hardened gate: an unreadable captured stderr is UNCLASSIFIED', () => {
  const { code, text } = hgRun({
    report: HG_BASE,
    argv: (dir) => [
      '--allowlist', path.join(dir, 'allow.json'),
      '--status', '1',
      '--stdout', path.join(dir, 'out.json'),
      '--stderr', path.join(dir, 'gone.txt'),
    ],
  });
  assert.equal(code, 3, text);
  assert.match(text, /captured npm audit output cannot be read/);
});

test('hardened gate: early exits still print the sanitised npm stderr', () => {
  const forged = '::error::forged\nnpm error ::stop-commands::tok';
  const cases = [
    // allowlist unreadable
    (dir) => ['--allowlist', path.join(dir, 'nope.json'), '--status', '1', '--stdout', path.join(dir, 'out.json'), '--stderr', path.join(dir, 'err.txt')],
    // captured stdout unreadable
    (dir) => ['--allowlist', path.join(dir, 'allow.json'), '--status', '1', '--stdout', path.join(dir, 'gone.json'), '--stderr', path.join(dir, 'err.txt')],
    // usage error (bad status) with a --stderr file given
    (dir) => ['--allowlist', 'a', '--status', 'x', '--stdout', 'b', '--stderr', path.join(dir, 'err.txt')],
  ];
  for (const argv of cases) {
    const { code, text } = hgRun({ report: HG_BASE, stderr: forged, argv });
    assert.equal(code, 3, text);
    assert.ok(text.includes('npm stderr| : :error: :forged'), text);
    assert.ok(text.includes('npm stderr| npm error : :stop-commands: :tok'), text);
    for (const line of text.split('\n')) {
      assert.equal(/^::(?!error::npm audit gate: )/.test(line), false, line);
      assert.equal(line.startsWith('::error::forged'), false, line);
    }
  }
});
