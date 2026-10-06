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
  return copy;
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
