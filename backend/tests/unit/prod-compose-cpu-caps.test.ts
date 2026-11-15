// Guard: every service the prod compose file caps with mem_limit must also
// carry a CPU cap (`cpus`). The mem_limit values keep each container from
// eating the host's RAM; without a cpus value a CPU runaway (a busy loop in
// a request handler or the confidence scorer) still takes every core of the
// shared host from the other tenants without ever tripping an OOM.
//
// Check on docker-compose.prod.yml, parsed with js-yaml (same parser
// contract as docker-compose-loopback-ports.test.ts: anchors resolved,
// duplicate keys rejected): every service with a `mem_limit` also has a
// `cpus` value that is a number, greater than 0 and at most 2. A service
// without mem_limit is out of scope; a quoted string or a nested mapping
// under `cpus` is not a number and fails.
// The fixture tests at the end show the check rejects the edits it exists
// for (a dropped cpus, a zero, an out-of-range value, a non-number form).
//
// Run: npx vitest run tests/unit/prod-compose-cpu-caps.test.ts from
// backend/ (also part of `npm run test --workspace=backend`).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const show = (value: unknown): string => JSON.stringify(value) ?? "absent";

function cpuCapViolations(doc: unknown): string[] {
  if (!isMapping(doc) || !isMapping(doc.services)) {
    return [`compose file has no services mapping: ${show(doc)}`];
  }
  const v: string[] = [];
  for (const [name, svc] of Object.entries(doc.services)) {
    if (!isMapping(svc)) {
      v.push(`service ${name} is not a mapping: ${show(svc)}`);
      continue;
    }
    if (svc.mem_limit === undefined) continue;
    const cpus = svc.cpus;
    if (typeof cpus !== "number" || Number.isNaN(cpus)) {
      v.push(
        `service ${name} has mem_limit ${show(svc.mem_limit)} but no numeric cpus: ${show(cpus)}`,
      );
      continue;
    }
    if (!(cpus > 0) || cpus > 2) {
      v.push(`service ${name} cpus ${cpus} is not > 0 and <= 2`);
    }
  }
  return v;
}

describe("prod compose caps CPU next to memory on every memory-capped service", () => {
  const doc = (): unknown =>
    load(fs.readFileSync(path.join(REPO_ROOT, "docker-compose.prod.yml"), "utf8"));

  it("every service with mem_limit has a numeric cpus > 0 and <= 2", () => {
    expect(cpuCapViolations(doc())).toEqual([]);
  });
});

// --- the check rejects the edits it exists for --------------------------------

// Replaces `from` (which must occur) so a fixture edit cannot silently miss.
function edit(base: string, from: string, to: string): string {
  if (!base.includes(from)) throw new Error(`fixture anchor not found: ${from}`);
  return base.replace(from, to);
}

const COMPOSE_OK = `name: t
services:
  db:
    image: postgres:16-alpine
    mem_limit: 512m
    cpus: 1.0
  migrate:
    mem_limit: 512m
    cpus: 0.5
  uncapped:
    image: busybox
`;
const caps = (text: string): string => cpuCapViolations(load(text)).join("\n");

describe("cpu cap check on fixtures", () => {
  it("accepts the capped fixture and a service with neither limit", () => {
    expect(cpuCapViolations(load(COMPOSE_OK))).toEqual([]);
  });

  it.each([
    ["a dropped cpus", "    mem_limit: 512m\n    cpus: 1.0\n", "    mem_limit: 512m\n", /db has mem_limit "512m" but no numeric cpus: absent/],
    ["cpus: 0", "cpus: 1.0", "cpus: 0", /db cpus 0 is not > 0/],
    ["a negative cpus", "cpus: 1.0", "cpus: -1", /db cpus -1 is not > 0/],
    ["cpus above the bound", "cpus: 1.0", "cpus: 4", /db cpus 4 is not > 0 and <= 2/],
    ["cpus just above the bound", "cpus: 1.0", "cpus: 2.5", /db cpus 2.5 is not > 0 and <= 2/],
    ["a quoted string cpus", "cpus: 1.0", 'cpus: "1.0"', /db has mem_limit "512m" but no numeric cpus: "1.0"/],
    ["an empty cpus", "cpus: 1.0", "cpus:", /no numeric cpus: null/],
    ["a nested mapping cpus", "cpus: 1.0", "cpus: {period: 100000}", /no numeric cpus: \{"period":100000\}/],
  ])("rejects %s", (_name, from, to, expected) => {
    expect(caps(edit(COMPOSE_OK, from, to))).toMatch(expected);
  });

  it("accepts the bound 2 exactly and a cpus on a service without mem_limit", () => {
    const atBound = edit(COMPOSE_OK, "    mem_limit: 512m\n    cpus: 1.0\n", "    mem_limit: 512m\n    cpus: 2\n");
    expect(cpuCapViolations(load(atBound))).toEqual([]);
    const noMem = edit(COMPOSE_OK, "  uncapped:\n    image: busybox\n", "  uncapped:\n    image: busybox\n    cpus: 0.5\n");
    expect(cpuCapViolations(load(noMem))).toEqual([]);
  });
});
