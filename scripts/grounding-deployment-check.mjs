#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAX_REPORT_BYTES = 256 * 1024;
const usage = "Usage: grounding-deployment-check --inventory-only [--project <project-id-or-slug>]";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parse(args) {
  if (args[0] !== "--inventory-only") throw new Error(usage);
  const rest = args.slice(1);
  if (rest.length === 0) return [];
  if (rest.length === 2 && rest[0] === "--project" && rest[1] && !rest[1].startsWith("-")) return ["--project", rest[1]];
  throw new Error(usage);
}

function main() {
  const reportArgs = parse(process.argv.slice(2));
  const databaseUrl = process.env.GROUNDING_MIGRATION_DATABASE_URL;
  const report = fileURLToPath(new URL("../backend/dist/scripts/grounding-migration-report.js", import.meta.url));
  if (!databaseUrl || !existsSync(report)) throw new Error("Grounding deployment inventory is unavailable");
  const child = spawnSync(process.execPath, [report, "--json", ...reportArgs], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", maxBuffer: MAX_REPORT_BYTES, timeout: 10_000,
    env: { PATH: process.env.PATH ?? "", GROUNDING_MIGRATION_DATABASE_URL: databaseUrl },
  });
  if (child.error || child.status !== 0 || child.signal || Buffer.byteLength(child.stdout) > MAX_REPORT_BYTES) throw new Error("Grounding deployment inventory failed");
  const inventory = JSON.parse(child.stdout);
  if (inventory?.inventoryOnly !== true) throw new Error("Grounding deployment inventory failed");
  process.stdout.write(`${JSON.stringify({
    mode: "inventory-only", inventory,
    activation: {
      status: "blocked",
      unresolved: [
        "authorized cohort conversion and enforceable maintenance exclusion",
        "runtime trust composition and explicit new-task selection",
        "writer-fleet exclusion and separate host/operator qualification",
      ],
    },
  })}\n`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], "file:"));
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error && error.message === usage ? usage : "Grounding deployment inventory failed");
  }
}
