// Guard: every port the dev compose file publishes on the host must bind
// 127.0.0.1.
// The dev stack runs Postgres with the fixed credentials agent_tasks /
// agent_tasks and a Redis with no auth, so an unprefixed "5432:5432" makes
// both reachable from any host that can route to the machine's address.
// The three-part form "127.0.0.1:HOST:CONTAINER" keeps every local consumer
// working (the host DATABASE_URL/REDIS_URL point at localhost, the browser
// opens localhost) while refusing external connections.
//
// Checks on docker-compose.yml, parsed with js-yaml (same parser contract as
// migrate-no-accept-data-loss.test.ts: anchors resolved, duplicate keys
// rejected):
// 1. every published port, in string or long mapping form, names 127.0.0.1
//    as its host address. An entry without one publishes on all interfaces.
//    No service uses network_mode: host (binds every interface without a
//    ports entry) or extends, and the file has no top-level include: this
//    check cannot follow either into another file.
// 2. the four dev services publish exactly the pinned ports, so a service
//    that drops `ports:` entirely or renames a target cannot slip past a
//    comment-only edit.
// The fixture tests at the end show that check 1 rejects the edit it exists
// for (dropping the "127.0.0.1:" prefix from one port).
//
// Run: npx vitest run tests/unit/docker-compose-loopback-ports.test.ts from
// backend/ (also part of `npm run test --workspace=backend`).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const show = (value: unknown): string => JSON.stringify(value) ?? "absent";

// service name -> the exact ports list the dev file must publish. The
// container sides are the historical ones; only the host address changed.
const PINNED_PORTS: Record<string, unknown[]> = {
  db: ["127.0.0.1:5432:5432"],
  redis: ["127.0.0.1:6379:6379"],
  backend: ["127.0.0.1:3001:3001"],
  frontend: ["127.0.0.1:3000:3000"],
};

// Host address of one published port, or undefined when the entry names none
// (a bare HOST:CONTAINER pair publishes on every interface). Strings use the
// compose short syntax, optionally "[ADDRESS:]HOST:CONTAINER[/PROTO]" with a
// bracketed IPv6 address; mappings carry `host_ip`.
function hostAddress(entry: unknown): string | undefined {
  if (isMapping(entry)) {
    return typeof entry.host_ip === "string" ? entry.host_ip : undefined;
  }
  if (typeof entry !== "string") return undefined;
  const body = entry.split("/")[0];
  const bracketed = /^\[([^\]]*)\]/.exec(body);
  if (bracketed) return bracketed[1];
  return body.split(":").length === 3 ? body.split(":")[0] : undefined;
}

function loopbackViolations(doc: unknown): string[] {
  if (!isMapping(doc) || !isMapping(doc.services)) {
    return [`compose file has no services mapping: ${show(doc)}`];
  }
  const v: string[] = [];
  // A top-level include pulls in services this check cannot see.
  if (doc.include !== undefined) {
    v.push(`compose file uses include, which this check cannot follow: ${show(doc.include)}`);
  }
  for (const [name, svc] of Object.entries(doc.services)) {
    if (!isMapping(svc)) {
      v.push(`service ${name} is not a mapping: ${show(svc)}`);
      continue;
    }
    // Host networking listens on every host interface without any ports entry.
    if (svc.network_mode === "host") {
      v.push(`service ${name} uses network_mode: host, which binds every interface`);
    }
    // extends can bring in ports from another file this check does not read.
    if (svc.extends !== undefined) {
      v.push(`service ${name} uses extends, which this check cannot follow: ${show(svc.extends)}`);
    }
    const ports = svc.ports;
    if (ports === undefined) continue;
    const entries = Array.isArray(ports) ? ports : [ports];
    if (entries.length === 0) {
      v.push(`service ${name} has an empty ports list`);
      continue;
    }
    for (const entry of entries) {
      const addr = hostAddress(entry);
      if (addr === undefined) {
        v.push(
          `service ${name} publishes ${show(entry)} without a host address, which binds every interface`,
        );
      } else if (addr !== "127.0.0.1") {
        v.push(`service ${name} publishes ${show(entry)} on ${addr}, expected 127.0.0.1`);
      }
    }
  }
  return v;
}

function pinnedPortViolations(doc: unknown): string[] {
  if (!isMapping(doc) || !isMapping(doc.services)) {
    return [`compose file has no services mapping: ${show(doc)}`];
  }
  const v: string[] = [];
  for (const [name, ports] of Object.entries(PINNED_PORTS)) {
    const svc = doc.services[name];
    if (!isMapping(svc)) {
      v.push(`service ${name} not found (renamed or removed?)`);
      continue;
    }
    if (show(svc.ports) !== show(ports)) {
      v.push(`service ${name} ports are ${show(svc.ports)}, expected ${show(ports)}`);
    }
  }
  return v;
}

describe("dev compose publishes its ports on the loopback interface only", () => {
  const doc = (): unknown => load(read("docker-compose.yml"));

  it("every published port names 127.0.0.1 as its host address", () => {
    expect(loopbackViolations(doc())).toEqual([]);
  });

  it("db, redis, backend and frontend publish exactly the pinned ports", () => {
    expect(pinnedPortViolations(doc())).toEqual([]);
  });
});

// --- the checks reject the edits they exist for -------------------------------

// Replaces `from` (which must occur) so a fixture edit cannot silently miss.
function edit(base: string, from: string, to: string): string {
  if (!base.includes(from)) throw new Error(`fixture anchor not found: ${from}`);
  return base.replace(from, to);
}

const COMPOSE_OK = `name: t
services:
  db:
    image: postgres:16-alpine
    ports:
      - "127.0.0.1:5432:5432"
  redis:
    image: redis:7-alpine
    ports:
      - "127.0.0.1:6379:6379"
  backend:
    ports:
      - "127.0.0.1:3001:3001"
  frontend:
    ports:
      - "127.0.0.1:3000:3000"
  worker:
    image: busybox
`;
const loopback = (text: string): string => loopbackViolations(load(text)).join("\n");

describe("loopback check on fixtures", () => {
  it("accepts the pinned loopback fixture and a service without ports", () => {
    expect(loopbackViolations(load(COMPOSE_OK))).toEqual([]);
  });

  it.each([
    ["a dropped 127.0.0.1 prefix", '"127.0.0.1:5432:5432"', '"5432:5432"', /without a host address/],
    ["an explicit wildcard bind", '"127.0.0.1:5432:5432"', '"0.0.0.0:5432:5432"', /on 0\.0\.0\.0/],
    ["another interface's address", '"127.0.0.1:5432:5432"', '"10.0.0.5:5432:5432"', /on 10\.0\.0\.5/],
    ["the long form without host_ip", '"127.0.0.1:5432:5432"', "{published: '5432', target: 5432}", /without a host address/],
    ["the long form with a wildcard host_ip", '"127.0.0.1:5432:5432"', "{host_ip: 0.0.0.0, published: '5432', target: 5432}", /on 0\.0\.0\.0/],
    ["an IPv6 address other than loopback", '"127.0.0.1:5432:5432"', '"[::]:5432:5432"', /on ::/],
    ["a non-string ports entry", '"127.0.0.1:5432:5432"', "5432", /without a host address/],
    ["host networking", "    image: redis:7-alpine\n", "    image: redis:7-alpine\n    network_mode: host\n", /network_mode: host/],
    ["a service extends", "  worker:\n    image: busybox\n", "  worker:\n    image: busybox\n    extends: {file: other.yml, service: db}\n", /uses extends/],
    ["a top-level include", "name: t\n", "name: t\ninclude:\n  - other.yml\n", /uses include/],
  ])("rejects %s", (_name, from, to, expected) => {
    expect(loopback(edit(COMPOSE_OK, from, to))).toMatch(expected);
  });

  it("accepts the forms the guard defines as loopback-bound", () => {
    const withProto = edit(COMPOSE_OK, '"127.0.0.1:5432:5432"', '"127.0.0.1:5432:5432/tcp"');
    expect(loopbackViolations(load(withProto))).toEqual([]);
    const longForm = edit(
      COMPOSE_OK,
      '"127.0.0.1:5432:5432"',
      "{host_ip: 127.0.0.1, published: '5432', target: 5432}",
    );
    expect(loopbackViolations(load(longForm))).toEqual([]);
  });
});

describe("pinned ports check on fixtures", () => {
  it("rejects a dropped or changed pin", () => {
    const dropped = edit(COMPOSE_OK, '  db:\n    image: postgres:16-alpine\n    ports:\n      - "127.0.0.1:5432:5432"\n', "  db:\n    image: postgres:16-alpine\n");
    expect(pinnedPortViolations(load(dropped)).join("\n")).toMatch(/db ports are absent/);
    const changed = edit(COMPOSE_OK, '"127.0.0.1:6379:6379"', '"127.0.0.1:6380:6379"');
    expect(pinnedPortViolations(load(changed)).join("\n")).toMatch(/redis ports are/);
    const renamed = edit(COMPOSE_OK, "  db:\n", "  postgres:\n");
    expect(pinnedPortViolations(load(renamed)).join("\n")).toMatch(/service db not found/);
  });
});
