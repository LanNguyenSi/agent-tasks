#!/usr/bin/env node
/** Explicit Git-object sync and producer-free integrity check for v1 fixtures. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const PINNED_REVISION = "0884c4054c446648aaaf44e2fe9eef5dff5648cf";
export const PINNED_MANIFEST_SHA256 = "b8dd4a913b59cfc1195aba22518aef59736eefb3fa187cf24557f7c84ce68906";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultTarget = join(root, "backend/tests/fixtures/grounding-receipt-v1");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const productionPin = Object.freeze({ producerRevision: PINNED_REVISION, manifestSha256: PINNED_MANIFEST_SHA256 });

function validatePin(pin) {
  if (!pin || typeof pin.producerRevision !== "string" || !/^[0-9a-f]{40}$/.test(pin.producerRevision)
    || typeof pin.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.manifestSha256)) {
    throw new Error("a full producer revision and manifest SHA-256 are required");
  }
}

function readManifest(bytes) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!manifest || !Array.isArray(manifest.files) || manifest.format !== "grounding-receipt/v1" || manifest.schemaVersion !== 1) {
    throw new Error("invalid manifest");
  }
  const names = new Set(["PIN.json", "manifest.json"]);
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.path)
      || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error("invalid manifest file entry");
    }
    names.add(file.path);
  }
  return manifest;
}

export function validateCorpus(targetPath, expectedPin = productionPin) {
  validatePin(expectedPin);
  const pin = JSON.parse(readFileSync(join(targetPath, "PIN.json"), "utf8"));
  if (!pin || pin.producerRevision !== expectedPin.producerRevision || pin.manifestSha256 !== expectedPin.manifestSha256) throw new Error("PIN.json differs from independently supplied pin");
  const manifestBytes = readFileSync(join(targetPath, "manifest.json"));
  if (hash(manifestBytes) !== expectedPin.manifestSha256) throw new Error("manifest digest does not match independently supplied pin");
  const manifest = readManifest(manifestBytes);
  const expected = new Set(["PIN.json", "manifest.json"]);
  for (const file of manifest.files) {
    expected.add(file.path);
    const bytes = readFileSync(join(targetPath, file.path));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`fixture digest mismatch: ${file.path}`);
  }
  const actual = readdirSync(targetPath);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file) || !lstatSync(join(targetPath, file)).isFile())) {
    throw new Error("fixture inventory differs from pinned manifest");
  }
  return manifest;
}

function show(producer, revision, path) {
  const result = spawnSync("git", ["-C", producer, "show", `${revision}:packages/grounding-mcp/contracts/grounding-receipt-v1/${path}`], { encoding: null });
  if (result.status !== 0) throw new Error(`cannot read pinned Git object: ${path}`);
  return result.stdout;
}

function validateDestination(target, producer) {
  const producerWithinTarget = relative(target, resolve(producer));
  if (target === dirname(target) || producerWithinTarget === "" || (!producerWithinTarget.startsWith(`..${sep}`) && producerWithinTarget !== "..")) {
    throw new Error("target must not contain the producer repository or be a filesystem root");
  }
  if (!existsSync(target)) return;
  if (!lstatSync(target).isDirectory()) throw new Error("target must be a directory, not a symlink or file");
  if (readdirSync(target).length === 0) return;
  // A replacement is limited to a previously valid corpus, including its inventory.
  const previousPin = JSON.parse(readFileSync(join(target, "PIN.json"), "utf8"));
  validateCorpus(target, previousPin);
}

export function syncCorpus({ producer, target, pin }) {
  validatePin(pin);
  target = resolve(target);
  validateDestination(target, producer);
  const resolved = spawnSync("git", ["-C", producer, "rev-parse", "--verify", `${pin.producerRevision}^{commit}`], { encoding: "utf8" });
  if (resolved.status !== 0 || resolved.stdout.trim() !== pin.producerRevision) throw new Error("independently supplied producer revision is unavailable");
  const manifestBytes = show(producer, pin.producerRevision, "manifest.json");
  if (hash(manifestBytes) !== pin.manifestSha256) throw new Error("independently supplied manifest digest mismatch in producer Git object");
  const manifest = readManifest(manifestBytes);
  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(join(dirname(target), ".grounding-corpus-"));
  const prepared = join(staging, "prepared");
  const previous = join(staging, "previous");
  let installed = false;
  try {
    mkdirSync(prepared);
    writeFileSync(join(prepared, "PIN.json"), JSON.stringify(pin, null, 2) + "\n");
    writeFileSync(join(prepared, "manifest.json"), manifestBytes);
    for (const file of manifest.files) writeFileSync(join(prepared, file.path), show(producer, pin.producerRevision, file.path));
    validateCorpus(prepared, pin);
    if (existsSync(target)) renameSync(target, previous);
    try {
      renameSync(prepared, target);
      installed = true;
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, target);
      throw error;
    }
  } finally {
    // If restoring a backup itself failed, retain it for recovery.
    if (installed || !existsSync(previous)) rmSync(staging, { recursive: true, force: true });
  }
}

/** The injectable pin supports portable Git-fixture tests; the executable always uses productionPin. */
export function runContract(args, pin = productionPin) {
  validatePin(pin);
  const [command, ...rest] = args;
  const usage = `usage: grounding-receipt-contract.mjs <check|sync> [--producer <local-git-repo> --revision ${pin.producerRevision}] [--target <fixture-dir>]`;
  if (command !== "check" && command !== "sync") throw new Error(usage);
  const allowed = command === "check" ? ["--target"] : ["--producer", "--revision", "--target"];
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!allowed.includes(name) || options.has(name) || !value || value.startsWith("--")) throw new Error(usage);
    options.set(name, value);
  }
  const target = resolve(options.get("--target") ?? defaultTarget);
  if (command === "check") {
    const manifest = validateCorpus(target, pin);
    return `offline corpus OK (${manifest.files.length + 2} files)\n`;
  }
  const producer = options.get("--producer");
  if (!producer || options.get("--revision") !== pin.producerRevision) throw new Error(usage);
  syncCorpus({ producer, target, pin });
  return `synced pinned corpus ${pin.producerRevision}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(runContract(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
