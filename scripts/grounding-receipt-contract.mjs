#!/usr/bin/env node
/** Explicit Git-object sync and producer-free integrity check for v1 fixtures. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const PINNED_REVISION = "0884c4054c446648aaaf44e2fe9eef5dff5648cf";
export const PINNED_MANIFEST_SHA256 = "b8dd4a913b59cfc1195aba22518aef59736eefb3fa187cf24557f7c84ce68906";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultTarget = join(root, "backend/tests/fixtures/grounding-receipt-v1");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const productionPin = { producerRevision: PINNED_REVISION, manifestSha256: PINNED_MANIFEST_SHA256 };

export function validateCorpus(targetPath, expectedPin = productionPin) {
  const pin = JSON.parse(readFileSync(join(targetPath, "PIN.json"), "utf8"));
  if (pin.producerRevision !== expectedPin.producerRevision || pin.manifestSha256 !== expectedPin.manifestSha256) throw new Error("PIN.json differs from independently supplied pin");
  const manifestBytes = readFileSync(join(targetPath, "manifest.json"));
  if (hash(manifestBytes) !== expectedPin.manifestSha256) throw new Error("manifest digest does not match independently supplied pin");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!Array.isArray(manifest.files) || manifest.format !== "grounding-receipt/v1" || manifest.schemaVersion !== 1) throw new Error("invalid manifest");
  const expected = new Set(["PIN.json", "manifest.json"]);
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || file.path.includes("/") || !Number.isSafeInteger(file.bytes) || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error("invalid manifest file entry");
    expected.add(file.path); const bytes = readFileSync(join(targetPath, file.path));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`fixture digest mismatch: ${file.path}`);
  }
  const actual = new Set(readdirSync(targetPath));
  if (actual.size !== expected.size || [...actual].some((file) => !expected.has(file))) throw new Error("fixture inventory differs from pinned manifest");
  return manifest;
}
function show(producer, revision, path) {
  const result = spawnSync("git", ["-C", producer, "show", `${revision}:packages/grounding-mcp/contracts/grounding-receipt-v1/${path}`], { encoding: null });
  if (result.status !== 0) throw new Error(`cannot read pinned Git object: ${path}`);
  return result.stdout;
}
export function syncCorpus({ producer, target, pin }) {
  const resolved = spawnSync("git", ["-C", producer, "rev-parse", "--verify", `${pin.producerRevision}^{commit}`], { encoding: "utf8" });
  if (resolved.status !== 0 || resolved.stdout.trim() !== pin.producerRevision) throw new Error("independently supplied producer revision is unavailable");
  const manifestBytes = show(producer, pin.producerRevision, "manifest.json");
  if (hash(manifestBytes) !== pin.manifestSha256) throw new Error("independently supplied manifest digest mismatch in producer Git object");
  const manifest = JSON.parse(manifestBytes.toString("utf8")); const staging = `${target}.sync-staging`;
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "PIN.json"), JSON.stringify(pin, null, 2) + "\n"); writeFileSync(join(staging, "manifest.json"), manifestBytes);
  for (const file of manifest.files) writeFileSync(join(staging, file.path), show(producer, pin.producerRevision, file.path));
  validateCorpus(staging, pin); rmSync(target, { recursive: true, force: true }); mkdirSync(dirname(target), { recursive: true }); renameSync(staging, target);
}
function main() {
  const args = process.argv.slice(2); const command = args.shift(); const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const target = resolve(option("--target") ?? defaultTarget);
  try {
    if (command === "check") { const manifest = validateCorpus(target); process.stdout.write(`offline corpus OK (${manifest.files.length + 2} files)\n`); return; }
    if (command === "sync") { const producer = option("--producer"); const revision = option("--revision"); if (!producer || revision !== PINNED_REVISION) throw new Error(`usage: sync --producer <local-git-repo> --revision ${PINNED_REVISION} [--target <fixture-dir>]`); syncCorpus({ producer, target, pin: productionPin }); process.stdout.write(`synced pinned corpus ${PINNED_REVISION}\n`); return; }
    throw new Error(`usage: grounding-receipt-contract.mjs <check|sync> [--producer <local-git-repo> --revision ${PINNED_REVISION}] [--target <fixture-dir>]`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
