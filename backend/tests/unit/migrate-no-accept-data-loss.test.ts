// Guard: a destructive schema change must stop the production deploy.
//
// Without --accept-data-loss, `prisma db push` exits non-zero when Prisma
// prints a data-loss warning, the one-shot `migrate` service fails, and
// compose does not start `backend` (docs/ops-backups.md, "Applying a
// destructive schema change"). That holds only while the whole chain below
// holds, so this file checks the chain as one contract instead of single
// lines:
//
// 1. .relay.yml: relay deploys docker-compose.prod.yml (`compose_file`;
//    relay's own default is docker-compose.yml) in its default build and up
//    flow (no `command:`), and its hooks are exactly the reviewed list.
// 2. Dockerfile.migrate: no parser directive, one build stage from the
//    official node image (whose entrypoint execs the command it is given),
//    only the instructions FROM, RUN, COPY, WORKDIR and CMD (so no
//    ENTRYPOINT, ENV, SHELL or ONBUILD), and exactly one CMD, equal to the
//    pinned exec form: push, then the fence SQL, then the claim repair,
//    joined by `&&`. Instruction names are read case-insensitively and line
//    continuations are joined, as Docker does.
// 3. docker-compose.prod.yml, parsed as YAML (anchors and merge keys
//    resolved, duplicate keys rejected): no top-level `include:`; service
//    `migrate` carries only reviewed keys (so no `command:`, `entrypoint:`,
//    `extends:`, `image:`, `profiles:` or `deploy:`), builds
//    `Dockerfile.migrate` from context `.`, and has `restart: "no"`.
// 4. Service `backend` waits for `migrate` with
//    `service_completed_successfully`, not marked `required: false`.
// 5. No --accept-data-loss or --force-reset outside comments in the three
//    files, read line by line and again after parsing.
//
// A check that cannot find what it looks for (a renamed service, a missing
// key, a file that no longer parses) fails; nothing is skipped. Changing any
// part of the chain on purpose means editing the expectation here in the
// same change. The fixture tests at the end show that each check rejects the
// edit it exists for.
//
// Not covered (residuals):
// - Environment interpolation: values resolved from the host .env at deploy
//   time, such as migrate's DATABASE_URL, are seen only as literal text. A
//   pinned field written as `${...}` fails here.
// - Extra compose files: `docker compose -f docker-compose.prod.yml -f
//   other.yml` run on the host can still override migrate's command; relay
//   passes only `-f docker-compose.prod.yml`.
// - Host-side commands outside .relay.yml, including the deliberate manual
//   path in docs/ops-backups.md.
// - What RUN and COPY put into the image (for example a RUN that replaces
//   npx) and the base image's contents: the guard pins which instructions
//   exist and the CMD, not their effect on the image filesystem.
// - Literal values in migrate's `environment:` (Node, npm or Prisma option
//   variables, PATH) can change what the pinned CMD runs; only the
//   Dockerfile ENV form is refused.
// - Destructive Prisma commands that use neither flag (for example a reset)
//   in services other than migrate.
// - Deliberate obfuscation of a flag (assembled by shell quoting, or encoded)
//   in a service whose command is not pinned; the scan reads literal text and
//   decoded `!!binary` scalars only.
//
// Run: npx vitest run tests/unit/migrate-no-accept-data-loss.test.ts from
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

// --- 5. data-loss flags -----------------------------------------------------

const FLAGS = ["--accept-data-loss", "--force-reset"];

const hasFlag = (text: string): boolean => FLAGS.some((f) => text.includes(f));

function nonCommentLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => !l.trim().startsWith("#"));
}

// Every string in a parsed YAML document, mapping keys included.
function yamlStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  // js-yaml returns `!!binary` scalars as bytes; compose decodes them to text.
  if (value instanceof Uint8Array) return [Buffer.from(value).toString("utf8")];
  if (Array.isArray(value)) return value.flatMap(yamlStrings);
  if (isMapping(value)) {
    return Object.entries(value).flatMap(([k, v]) => [k, ...yamlStrings(v)]);
  }
  return [];
}

// Raw non-comment lines, plus the parsed form: Dockerfile instructions after
// continuation joining (a flag split across `\` lines), YAML values after
// parsing (a flag split by a double-quoted line escape).
function flagHits(kind: "dockerfile" | "yaml", text: string): string[] {
  const hits = nonCommentLines(text).filter(hasFlag);
  if (kind === "dockerfile") {
    for (const i of parseDockerfile(text).instructions) {
      if (hasFlag(i.args)) hits.push(`line ${i.line}: ${i.keyword} ${i.args}`);
    }
  } else {
    hits.push(...yamlStrings(load(text)).filter(hasFlag));
  }
  return hits;
}

// --- 2. Dockerfile.migrate ----------------------------------------------------

interface Instruction {
  keyword: string;
  args: string;
  line: number;
}

// Reads a Dockerfile the way Docker does without an escape directive (one is
// refused below): a line whose first non-blank character is `#` is a comment,
// also inside a continuation; a trailing backslash joins the next line with
// no separator; blank lines are skipped; the instruction name is
// case-insensitive. Heredocs (`<<WORD`) are not modelled and are refused
// outright, because their body lines could otherwise pass as instructions.
function parseDockerfile(text: string): {
  directives: string[];
  instructions: Instruction[];
} {
  const directives: string[] = [];
  const instructions: Instruction[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let pending: { text: string; line: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith("#")) {
      if (/^#\s*(syntax|escape|check)\s*=/i.test(trimmed)) {
        directives.push(`line ${i + 1}: ${trimmed}`);
      }
      continue;
    }
    if (trimmed === "") continue;
    const continues = /\\[ \t]*$/.test(raw);
    const piece = continues ? raw.replace(/\\[ \t]*$/, "") : raw;
    pending = pending
      ? { text: pending.text + piece, line: pending.line }
      : { text: piece, line: i + 1 };
    if (!continues) {
      instructions.push(toInstruction(pending));
      pending = null;
    }
  }
  if (pending) instructions.push(toInstruction(pending));
  return { directives, instructions };
}

function toInstruction(logical: { text: string; line: number }): Instruction {
  const m = /^\s*(\S+)\s*([\s\S]*)$/.exec(logical.text);
  return {
    keyword: (m?.[1] ?? "").toUpperCase(),
    args: (m?.[2] ?? "").trim(),
    line: logical.line,
  };
}

const DOCKERFILE_INSTRUCTIONS = new Set(["FROM", "RUN", "COPY", "WORKDIR", "CMD"]);
const NODE_IMAGE = /^node:[A-Za-z0-9._-]+(@sha256:[0-9a-f]{64})?$/;

const SCHEMA = "--schema=/app/backend/prisma/schema.prisma";
const PINNED_CMD = [
  "sh",
  "-c",
  [
    `npx prisma db push ${SCHEMA} --skip-generate`,
    `npx prisma db execute ${SCHEMA} --file=/app/backend/prisma/grounding-github-fence.sql`,
    `npx prisma db execute ${SCHEMA} --file=/app/backend/prisma/clear-terminal-claims.sql`,
  ].join(" && "),
];

function dockerfileStageViolations(text: string): string[] {
  const { directives, instructions } = parseDockerfile(text);
  const v: string[] = [];
  for (const d of directives) {
    v.push(`parser directive changes how Docker reads the file: ${d}`);
  }
  for (const i of instructions) {
    if (/<<-?\s*["']?[A-Za-z_]/.test(i.args)) {
      v.push(`line ${i.line}: ${i.keyword} uses a heredoc, which this check does not model`);
    }
  }
  const froms = instructions.filter((i) => i.keyword === "FROM");
  if (froms.length !== 1 || instructions[0]?.keyword !== "FROM") {
    v.push(
      `expected exactly one build stage, opened by the first instruction; found ${froms.length} FROM`,
    );
  }
  for (const f of froms) {
    if (!NODE_IMAGE.test(f.args)) {
      v.push(
        `line ${f.line}: FROM ${f.args} is not the official node image, whose entrypoint execs CMD as given`,
      );
    }
  }
  for (const i of instructions) {
    if (!DOCKERFILE_INSTRUCTIONS.has(i.keyword)) {
      v.push(
        `line ${i.line}: ${i.keyword} is outside the reviewed instructions (${[...DOCKERFILE_INSTRUCTIONS].join(", ")}); ENTRYPOINT, ENV, SHELL and ONBUILD can change what the container runs`,
      );
    }
  }
  return v;
}

function dockerfileCmdViolations(text: string): string[] {
  const cmds = parseDockerfile(text).instructions.filter((i) => i.keyword === "CMD");
  const v: string[] = [];
  if (cmds.length !== 1) {
    v.push(
      `expected exactly one CMD, found ${cmds.length} (lines ${cmds.map((c) => c.line).join(", ")})`,
    );
  }
  for (const c of cmds) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.args);
    } catch {
      parsed = undefined;
    }
    if (show(parsed) !== show(PINNED_CMD)) {
      v.push(`line ${c.line}: CMD is not the pinned exec form: ${c.args}`);
    }
  }
  return v;
}

// --- 3. and 4. docker-compose.prod.yml ---------------------------------------

const COMPOSE_TOP_LEVEL = new Set(["name", "services", "volumes", "networks", "configs", "secrets"]);
// Keys migrate may carry. Any other key (command, entrypoint, extends, image,
// profiles, deploy, scale, ...) can change what migrate runs or whether it
// runs, so it is reviewed against this contract before it is added here.
const MIGRATE_KEYS = new Set([
  "build",
  "environment",
  "depends_on",
  "networks",
  "restart",
  "mem_limit",
  "logging",
]);
const DEPENDS_ON_KEYS = new Set(["condition", "required", "restart"]);

function composeShapeViolations(doc: unknown): string[] {
  if (!isMapping(doc)) return [`compose file is not a YAML mapping: ${show(doc)}`];
  const v: string[] = [];
  const extra = Object.keys(doc).filter((k) => !COMPOSE_TOP_LEVEL.has(k) && !k.startsWith("x-"));
  if (extra.length > 0) {
    v.push(
      `top-level keys outside the reviewed set (include: pulls in services this guard never reads): ${extra.join(", ")}`,
    );
  }
  if (!isMapping(doc.services)) {
    v.push("no services mapping");
  } else {
    for (const name of ["migrate", "backend"]) {
      if (!isMapping(doc.services[name])) {
        v.push(`service ${name} not found (renamed or removed?)`);
      }
    }
  }
  return v;
}

function service(doc: unknown, name: string): Mapping | undefined {
  if (!isMapping(doc) || !isMapping(doc.services)) return undefined;
  const s = doc.services[name];
  return isMapping(s) ? s : undefined;
}

function migrateViolations(doc: unknown): string[] {
  const migrate = service(doc, "migrate");
  if (!migrate) return ["service migrate not found (renamed or removed?)"];
  const v: string[] = [];
  if ("command" in migrate) v.push(`migrate sets command: ${show(migrate.command)}, replacing the pinned CMD`);
  if ("entrypoint" in migrate) {
    v.push(`migrate sets entrypoint: ${show(migrate.entrypoint)}, wrapping or replacing the pinned CMD`);
  }
  const extra = Object.keys(migrate).filter(
    (k) => !MIGRATE_KEYS.has(k) && k !== "command" && k !== "entrypoint",
  );
  if (extra.length > 0) v.push(`migrate keys outside the reviewed set: ${extra.join(", ")}`);
  const build = migrate.build;
  if (
    !isMapping(build) ||
    Object.keys(build).sort().join(",") !== "context,dockerfile" ||
    build.context !== "." ||
    build.dockerfile !== "Dockerfile.migrate"
  ) {
    v.push(
      `migrate build is ${show(build)}, expected exactly context "." and dockerfile "Dockerfile.migrate"`,
    );
  }
  if (migrate.restart !== "no") v.push(`migrate restart is ${show(migrate.restart)}, expected "no"`);
  return v;
}

function backendViolations(doc: unknown): string[] {
  const backend = service(doc, "backend");
  if (!backend) return ["service backend not found (renamed or removed?)"];
  const dependsOn = backend.depends_on;
  if (!isMapping(dependsOn)) {
    return [
      `backend depends_on is ${show(dependsOn)}; it must be a mapping with a migrate entry (the list form means service_started)`,
    ];
  }
  const dep = dependsOn.migrate;
  if (!isMapping(dep)) return [`backend depends_on has no migrate entry: ${show(dependsOn)}`];
  const v: string[] = [];
  if (dep.condition !== "service_completed_successfully") {
    v.push(
      `backend depends_on.migrate.condition is ${show(dep.condition)}, expected "service_completed_successfully"`,
    );
  }
  if (dep.required !== undefined && dep.required !== true) {
    v.push(`backend depends_on.migrate.required is ${show(dep.required)}; false makes the dependency optional`);
  }
  const extra = Object.keys(dep).filter((k) => !DEPENDS_ON_KEYS.has(k));
  if (extra.length > 0) v.push(`backend depends_on.migrate keys outside the reviewed set: ${extra.join(", ")}`);
  return v;
}

// --- 1. .relay.yml --------------------------------------------------------------

// Keys of agent-relay's .relay.yml schema, without `command` (a custom
// command replaces relay's compose build and up flow).
const RELAY_KEYS = new Set([
  "name",
  "health",
  "health_port",
  "compose_file",
  "pre_update",
  "post_update",
  "rollback",
  "step_timeout_seconds",
]);
// Hooks are host shell commands this guard cannot interpret, so they are
// pinned: a new or changed hook is reviewed against the contract first.
const RELAY_PRE_UPDATE = ["docker compose -f docker-compose.prod.yml build --pull"];

function relayViolations(doc: unknown): string[] {
  if (!isMapping(doc)) return [`.relay.yml is not a YAML mapping: ${show(doc)}`];
  const v: string[] = [];
  if (doc.compose_file !== "docker-compose.prod.yml") {
    v.push(
      `compose_file is ${show(doc.compose_file)}; relay must deploy docker-compose.prod.yml (its default is docker-compose.yml)`,
    );
  }
  if ("command" in doc) v.push(`command: ${show(doc.command)} replaces relay's compose build and up flow`);
  const extra = Object.keys(doc).filter((k) => !RELAY_KEYS.has(k) && k !== "command");
  if (extra.length > 0) v.push(`.relay.yml keys outside the reviewed set: ${extra.join(", ")}`);
  if (show(doc.pre_update) !== show(RELAY_PRE_UPDATE)) {
    v.push(`pre_update is ${show(doc.pre_update)}, expected ${show(RELAY_PRE_UPDATE)}`);
  }
  if (doc.post_update !== undefined && show(doc.post_update) !== "[]") {
    v.push(`post_update is ${show(doc.post_update)}, expected none`);
  }
  return v;
}

// --- checks against the repository files ----------------------------------------

describe("migrate does not accept data loss", () => {
  for (const [file, kind] of [
    ["Dockerfile.migrate", "dockerfile"],
    ["docker-compose.prod.yml", "yaml"],
    [".relay.yml", "yaml"],
  ] as const) {
    it(`${file} has no --accept-data-loss or --force-reset outside comments`, () => {
      expect(flagHits(kind, read(file))).toEqual([]);
    });
  }

  it(".relay.yml deploys docker-compose.prod.yml in relay's default flow with only the reviewed hooks", () => {
    expect(relayViolations(load(read(".relay.yml")))).toEqual([]);
  });

  it("Dockerfile.migrate is one node stage with only reviewed instructions (no ENTRYPOINT)", () => {
    expect(dockerfileStageViolations(read("Dockerfile.migrate"))).toEqual([]);
  });

  it("Dockerfile.migrate CMD is exactly push, fence SQL, claim repair joined by &&", () => {
    expect(dockerfileCmdViolations(read("Dockerfile.migrate"))).toEqual([]);
  });

  it("docker-compose.prod.yml has no include and defines services migrate and backend", () => {
    expect(composeShapeViolations(load(read("docker-compose.prod.yml")))).toEqual([]);
  });

  it("compose migrate builds Dockerfile.migrate, keeps its CMD and is not restarted", () => {
    expect(migrateViolations(load(read("docker-compose.prod.yml")))).toEqual([]);
  });

  it("compose backend starts only after migrate completed successfully", () => {
    expect(backendViolations(load(read("docker-compose.prod.yml")))).toEqual([]);
  });
});

// --- the checks reject the edits they exist for ---------------------------------

// Replaces `from` (which must occur) so a fixture edit cannot silently miss.
function edit(base: string, from: string, to: string): string {
  if (!base.includes(from)) throw new Error(`fixture anchor not found: ${from}`);
  return base.replace(from, to);
}

const CMD_LINE = `CMD ${JSON.stringify(PINNED_CMD)}`;
const DOCKERFILE_OK = ["FROM node:22-slim", "WORKDIR /app", "# comment", CMD_LINE, ""].join("\n");
const dockerfileViolations = (text: string): string[] => [
  ...dockerfileStageViolations(text),
  ...dockerfileCmdViolations(text),
];

describe("Dockerfile contract checks", () => {
  it("accept the pinned file, CRLF line endings, and a CMD continued over a comment line", () => {
    expect(dockerfileViolations(DOCKERFILE_OK)).toEqual([]);
    expect(dockerfileViolations(DOCKERFILE_OK.replace(/\n/g, "\r\n"))).toEqual([]);
    const continued = edit(
      DOCKERFILE_OK,
      CMD_LINE,
      `cmd ["sh", "-c", \\\n# Docker drops this line\n  ${JSON.stringify(PINNED_CMD[2])}]`,
    );
    expect(dockerfileViolations(continued)).toEqual([]);
  });

  it.each([
    ["a second, lowercase cmd", `${CMD_LINE}\ncmd ["true"]`, /exactly one CMD/],
    ["an ENTRYPOINT", `ENTRYPOINT ["sh", "-c"]\n${CMD_LINE}`, /ENTRYPOINT is outside/],
    ["a lowercase entrypoint", `entrypoint ["sh", "-c"]\n${CMD_LINE}`, /ENTRYPOINT is outside/],
    ["an ENV", `ENV NODE_OPTIONS=--require=/app/x.js\n${CMD_LINE}`, /ENV is outside/],
    ["`|| true` on the chain", CMD_LINE.replace(/"\]$/, ' || true"]'), /not the pinned/],
    ["a shell-form CMD", `CMD ${PINNED_CMD[2]}`, /not the pinned/],
    ["a second build stage", `${CMD_LINE}\nFROM busybox`, /one build stage/],
    ["a continued instruction at end of file", `${CMD_LINE}\ncmd ["true"] \\`, /exactly one CMD/],
    ["a COPY heredoc", `COPY <<CMD /tmp/x\n${CMD_LINE}\nCMD`, /heredoc/],
    ["a quoted RUN heredoc", `RUN <<-"EOT"\necho hi\nEOT\n${CMD_LINE}`, /heredoc/],
  ])("reject %s", (_name, replacement, expected) => {
    const text = edit(DOCKERFILE_OK, CMD_LINE, replacement);
    expect(dockerfileViolations(text).join("\n")).toMatch(expected);
  });

  it("reject a parser directive and a base image other than node", () => {
    expect(dockerfileViolations(`# syntax=docker/dockerfile:1\n${DOCKERFILE_OK}`).join("\n")).toMatch(
      /parser directive/,
    );
    expect(dockerfileViolations(`# escape=\`\n${DOCKERFILE_OK}`).join("\n")).toMatch(/parser directive/);
    expect(dockerfileViolations(`# ESCAPE=\`\n${DOCKERFILE_OK}`).join("\n")).toMatch(/parser directive/);
    const debian = edit(DOCKERFILE_OK, "FROM node:22-slim", "FROM debian:12-slim");
    expect(dockerfileViolations(debian).join("\n")).toMatch(/not the official node image/);
  });

  it("find a flag split across a line continuation", () => {
    const split = edit(DOCKERFILE_OK, "--skip-generate", "--skip-generate --accept-data-\\\nloss");
    expect(flagHits("dockerfile", split)).toHaveLength(1);
    expect(dockerfileViolations(split).join("\n")).toMatch(/not the pinned/);
  });
});

// restart comes in through a merge key, so the positive case also shows that
// merge keys are resolved before the checks run.
const COMPOSE_OK = `name: t
x-one-shot: &one-shot
  restart: "no"
services:
  migrate:
    <<: *one-shot
    build:
      context: .
      dockerfile: Dockerfile.migrate
  backend:
    depends_on:
      migrate:
        condition: service_completed_successfully
`;
const composeViolations = (text: string): string[] => {
  const doc = load(text);
  return [...composeShapeViolations(doc), ...migrateViolations(doc), ...backendViolations(doc)];
};
const MIGRATE_BUILD = "    build:\n      context: .\n      dockerfile: Dockerfile.migrate\n";

describe("compose contract checks", () => {
  it("accept the fixture", () => {
    expect(composeViolations(COMPOSE_OK)).toEqual([]);
  });

  const DEPENDS_ON = "    depends_on:\n      migrate:\n        condition: service_completed_successfully\n";
  it.each([
    [
      "a migrate command without a flag",
      MIGRATE_BUILD,
      `${MIGRATE_BUILD}    command: ["true"]\n`,
      /sets command/,
    ],
    [
      "a migrate entrypoint",
      MIGRATE_BUILD,
      `${MIGRATE_BUILD}    entrypoint: ["sh", "-c"]\n`,
      /sets entrypoint/,
    ],
    [
      "a command arriving by merge key",
      '  restart: "no"\n',
      '  restart: "no"\n  command: ["true"]\n',
      /sets command/,
    ],
    [
      "migrate extends another service",
      MIGRATE_BUILD,
      `${MIGRATE_BUILD}    extends: backend\n`,
      /outside the reviewed set: extends/,
    ],
    [
      "a swapped dockerfile",
      "dockerfile: Dockerfile.migrate",
      "dockerfile: backend/Dockerfile.migrate",
      /migrate build is/,
    ],
    ["the short build form", MIGRATE_BUILD, "    build: .\n", /migrate build is/],
    ["a swapped build context", "      context: .\n", "      context: ./other\n", /migrate build is/],
    [
      "an extra build key",
      MIGRATE_BUILD,
      `${MIGRATE_BUILD}      additional_contexts:\n        node:22-slim: docker-image://busybox\n`,
      /migrate build is/,
    ],
    ["restart other than no", '  restart: "no"\n', "  restart: on-failure\n", /migrate restart is/],
    [
      "a renamed migrate service",
      "  migrate:\n    <<",
      "  schema-sync:\n    <<",
      /service migrate not found/,
    ],
    [
      "condition service_started",
      "service_completed_successfully",
      "service_started",
      /condition is "service_started"/,
    ],
    ["the depends_on list form", DEPENDS_ON, "    depends_on: [migrate]\n", /list form/],
    [
      "required: false",
      DEPENDS_ON,
      `${DEPENDS_ON}        required: false\n`,
      /makes the dependency optional/,
    ],
    [
      "a top-level include",
      "name: t\n",
      "name: t\ninclude:\n  - other.yml\n",
      /never reads\): include$/,
    ],
  ])("reject %s", (_name, from, to, expected) => {
    expect(composeViolations(edit(COMPOSE_OK, from, to)).join("\n")).toMatch(expected);
  });

  it("refuse a duplicated key instead of reading only one of them", () => {
    const dup = edit(COMPOSE_OK, '  restart: "no"\n', '  restart: "no"\n  restart: always\n');
    expect(() => load(dup)).toThrow(/duplicated mapping key/);
  });

  it("find --force-reset in a service other than migrate", () => {
    const reset = edit(
      COMPOSE_OK,
      "  backend:\n",
      '  backend:\n    command: ["npx", "prisma", "db", "push", "--force-reset"]\n',
    );
    expect(flagHits("yaml", reset)).toContain("--force-reset");
  });

  it("find a flag in a !!binary scalar", () => {
    const encoded = Buffer.from("npx prisma db push --force-reset").toString("base64");
    const text = edit(COMPOSE_OK, "name: t\n", `name: t\nx-cmd: !!binary ${encoded}\n`);
    expect(flagHits("yaml", text)).toContain("npx prisma db push --force-reset");
  });

  it("find a flag split by a double-quoted line escape", () => {
    const split = edit(COMPOSE_OK, "name: t\n", 'name: t\nx-note: "--accept-data-\\\n  loss"\n');
    expect(flagHits("yaml", split)).toEqual(["--accept-data-loss"]);
  });
});

const RELAY_OK = `name: t
health: /api/health
compose_file: docker-compose.prod.yml
pre_update:
  - docker compose -f docker-compose.prod.yml build --pull
rollback: true
`;

describe(".relay.yml contract checks", () => {
  it("accept the fixture", () => {
    expect(relayViolations(load(RELAY_OK))).toEqual([]);
  });

  it.each([
    [
      "a missing compose_file (relay then deploys docker-compose.yml)",
      "compose_file: docker-compose.prod.yml\n",
      "",
      /compose_file is absent/,
    ],
    [
      "another compose_file",
      "compose_file: docker-compose.prod.yml",
      "compose_file: docker-compose.yml",
      /compose_file is "docker-compose.yml"/,
    ],
    [
      "a custom command",
      "rollback: true\n",
      "rollback: true\ncommand: ./deploy.sh\n",
      /replaces relay's compose build/,
    ],
    [
      "a post_update hook that runs migrate",
      "rollback: true\n",
      "rollback: true\npost_update:\n  - docker compose -f docker-compose.prod.yml run --rm migrate sh -c true\n",
      /post_update is/,
    ],
    [
      "a changed pre_update hook",
      "build --pull",
      "build --pull && docker compose run --rm migrate true",
      /pre_update is/,
    ],
  ])("reject %s", (_name, from, to, expected) => {
    expect(relayViolations(load(edit(RELAY_OK, from, to))).join("\n")).toMatch(expected);
  });
});
