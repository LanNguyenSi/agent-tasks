import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GroundingReceiptVerificationError,
  verifyGroundingReceipt,
  type GroundingReceiptExpectedContext,
  type GroundingReceiptVerifierConfig,
} from "../../src/services/grounding-receipt.js";

const fixture = resolve("tests/fixtures/grounding-receipt-v1");
const json = <T>(name: string): T => JSON.parse(readFileSync(join(fixture, name), "utf8")) as T;
type FixturePayload = {
  receiptId: string;
  audience: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  nonce: string;
  contextRevision: number;
  target: GroundingReceiptExpectedContext["target"];
  subject: { digest: string; };
  session: GroundingReceiptExpectedContext["session"];
  assessment: { outcome: "pass" | "fail"; dossierSha256: string; reasons: string[]; };
  evaluatedAt: number;
  issuedAt: number;
  expiresAt: number;
};
const keys = json<{ publicKeyPem: string; seedHex: string; pkcs8DerPrefixHex: string; }>("test-keys.json");
const payload = json<FixturePayload>("golden-pass.payload.json");
const goldenPass = readFileSync(join(fixture, "golden-pass.receipt"));
const goldenFail = readFileSync(join(fixture, "golden-fail.receipt"));
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from(keys.pkcs8DerPrefixHex, "hex"), Buffer.from(keys.seedHex, "hex")]),
  format: "der", type: "pkcs8",
});
const rotated = generateKeyPairSync("ed25519");
const rotatedPem = rotated.publicKey.export({ format: "pem", type: "spki" }).toString();
const profileDigest = "50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4";
const epoch = 1_700_000_000;
function contextFor(p: FixturePayload, created = epoch, expires = epoch + 900): GroundingReceiptExpectedContext {
  return {
    audience: p.audience, projectId: p.projectId, taskId: p.taskId, attemptId: p.attemptId,
    nonce: p.nonce, contextRevision: p.contextRevision, target: { ...p.target },
    subjectDigest: p.subject.digest, session: { ...p.session },
    attemptCreatedAt: created, attemptExpiresAt: expires,
  };
}

function config(overrides: Partial<GroundingReceiptVerifierConfig> = {}): GroundingReceiptVerifierConfig {
  return {
    now: epoch + 30,
    expected: contextFor(payload),
    trust: [{
      issuer: "test.issuer", kid: "test-key", publicKeyPem: keys.publicKeyPem, profileDigest,
      projectIds: [payload.projectId], audiences: [payload.audience]
    }],
    ...overrides,
  };
}

function evidenceFor(p: FixturePayload) {
  return {
    evidenceOrigin: "agent_asserted", receiptId: p.receiptId,
    assessmentDossierSha256: p.assessment.dossierSha256,
    evaluatedAt: p.evaluatedAt, issuedAt: p.issuedAt, expiresAt: p.expiresAt,
  };
}

function error(input: Uint8Array | string, options: unknown = config()): GroundingReceiptVerificationError {
  try {
    verifyGroundingReceipt(input, options as GroundingReceiptVerifierConfig);
    throw new Error("expected receipt verification to fail");
  } catch (caught) {
    expect(caught).toBeInstanceOf(GroundingReceiptVerificationError);
    return caught as GroundingReceiptVerificationError;
  }
}

function signedPayload(next: FixturePayload, key: KeyObject = privateKey, issuer = "test.issuer", kid = "test-key"): Uint8Array {
  const body = Buffer.from(JSON.stringify(next), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(`grounding-receipt/v1\nEd25519\n${issuer}\n${kid}\n${body}`, "utf8"), key).toString("base64url");
  return Buffer.from(JSON.stringify({ format: "grounding-receipt/v1", alg: "Ed25519", issuer, kid, payload: body, signature }));
}

function changedPayload(change: (next: FixturePayload) => void): FixturePayload {
  const next = structuredClone(payload);
  change(next);
  return next;
}

function expectPass(p: FixturePayload, options = config(), key = privateKey, issuer = "test.issuer", kid = "test-key") {
  expect(verifyGroundingReceipt(signedPayload(p, key, issuer, kid), options)).toEqual(evidenceFor(p));
}

// Config tests intentionally cross the runtime boundary without TypeScript's static guarantees.
function setField(value: unknown, path: string, replacement: unknown) {
  const parts = path.split(".");
  let object = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) object = object[part] as Record<string, unknown>;
  object[parts.at(-1)!] = replacement;
}

describe("grounding receipt consumer verifier", () => {
  it("N-02 returns exactly documentary evidence for the golden pass and assessment_failed for authentic fail", () => {
    expect(verifyGroundingReceipt(goldenPass, config())).toEqual(evidenceFor(payload));
    expect(error(goldenFail)).toMatchObject({ code: "grounding_required", detail: "assessment_failed" });
  });

  const positives = json<{ cases: { id: string; wireBase64: string; payload: FixturePayload; }[]; }>("positive-vectors.json").cases;
  it.each(positives)("N-02 producer positive $id has the exact consumer result", (vector) => {
    // Expected values come from the producer's independent payload declaration, not decoded receipt bytes.
    const p = vector.payload;
    const expected = contextFor(p, p.evaluatedAt, p.expiresAt);
    const identity = vector.id === "maximum-fields-and-900-second-lifetime"
      ? { issuer: "i".repeat(128), kid: "k".repeat(128) }
      : vector.id === "minimum-fields-one-second-lifetime"
        ? { issuer: "i", kid: "k" } : { issuer: "test.issuer", kid: "test-key" };
    const trust = [{ ...config().trust[0], ...identity, projectIds: [p.projectId], audiences: [p.audience] }];
    const options = config({ expected, trust, now: p.issuedAt });
    const wire = Buffer.from(vector.wireBase64, "base64");
    if (p.assessment.outcome === "pass") {
      expect(verifyGroundingReceipt(wire, options)).toEqual(evidenceFor(p));
    } else {
      expect(error(wire, options)).toMatchObject({ code: "grounding_required", detail: "assessment_failed" });
    }
  });

  const negatives = json<{ cases: { id: string; expected: { code: "invalid" | "unsupported" | "untrusted"; }; wireBase64: string; }[]; }>("negative-vectors.json").cases;
  it.each(negatives)("N-03/N-04/N-18 producer negative $id maps exactly", (vector) => {
    const codes = { invalid: "grounding_receipt_invalid", unsupported: "grounding_receipt_unsupported", untrusted: "grounding_receipt_untrusted" };
    expect(error(Buffer.from(vector.wireBase64, "base64")).code).toBe(codes[vector.expected.code]);
  });

  const contexts = json<{ cases: { id: string; wireBase64: string; }[]; }>("context-vectors.json").cases;
  it.each(contexts)("N-05 independently rejects binding $id", (vector) => {
    const wire = Buffer.from(vector.wireBase64, "base64");
    const envelope = JSON.parse(wire.toString()) as { payload: string; };
    const p = JSON.parse(Buffer.from(envelope.payload, "base64url").toString()) as FixturePayload;
    const trust = [{ ...config().trust[0], projectIds: [payload.projectId, p.projectId], audiences: [payload.audience, p.audience] }];
    expect(error(wire, config({ trust })).code).toBe("grounding_receipt_mismatch");
  });

  it.each(["issuer", "kid"] as const)("N-04 requires an exact allowlisted %s", (field) => {
    const trust = [{ ...config().trust[0], [field]: "unknown" }];
    expect(error(goldenPass, config({ trust })).code).toBe("grounding_receipt_untrusted");
  });
  it("N-04 treats an empty trust store as no trusted receipt key", () => {
    expect(error(goldenPass, config({ trust: [] })).code).toBe("grounding_receipt_untrusted");
  });
  it.each([
    { name: "project", change: { projectIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] } },
    { name: "audience", change: { audiences: ["another.consumer"] } },
    { name: "profile", change: { profileDigest: "a".repeat(64) } },
  ])("N-04 independently rejects trust $name scope", ({ change }) => {
    const trust = [{ ...config().trust[0], ...change }];
    expect(error(goldenPass, config({ trust })).code).toBe("grounding_receipt_untrusted");
  });
  it("N-04 supports scoped key rotation and independently revokes each issuer/kid", () => {
    const first = config().trust[0];
    const second = { ...first, kid: "rotated", publicKeyPem: rotatedPem };
    expectPass(payload, config({ trust: [first, second] }));
    expectPass(payload, config({ trust: [first, second] }), rotated.privateKey, second.issuer, second.kid);
    const revokeFirst = config({ trust: [{ ...first, revoked: true }, second] });
    expect(error(goldenPass, revokeFirst).code).toBe("grounding_receipt_untrusted");
    expectPass(payload, revokeFirst, rotated.privateKey, second.issuer, second.kid);
    const revokeSecond = config({ trust: [first, { ...second, revoked: true }] });
    expect(error(signedPayload(payload, rotated.privateKey, second.issuer, second.kid), revokeSecond).code).toBe("grounding_receipt_untrusted");
    expectPass(payload, revokeSecond);
  });
  it.each([false, true])("N-04 rejects duplicate issuer/kid even when duplicate is revoked=%s", (revoked) => {
    const first = config().trust[0];
    const duplicate = { ...first, revoked, publicKeyPem: rotatedPem };
    for (const trust of [[first, duplicate], [duplicate, first]]) {
      expect(error(goldenPass, config({ trust })).code).toBe("grounding_verification_unavailable");
    }
  });
  it("N-04 rejects a valid Ed25519 signature from a different key", () => {
    expect(error(signedPayload(payload, rotated.privateKey)).code).toBe("grounding_receipt_untrusted");
  });
  it("N-04 signs issuer and kid into the domain-separated bytes", () => {
    const envelope = JSON.parse(goldenPass.toString()) as Record<string, string>;
    for (const field of ["issuer", "kid"] as const) {
      const next = { ...envelope, [field]: "alias" };
      const trust = [{ ...config().trust[0], [field]: "alias" }];
      expect(error(JSON.stringify(next), config({ trust })).code).toBe("grounding_receipt_untrusted");
    }
  });

  const expectedFields = ["audience", "projectId", "taskId", "attemptId", "nonce", "contextRevision", "subjectDigest",
    "target", "target.workflowId", "target.from", "target.to", "target.action", "session", "session.id", "session.revision", "attemptCreatedAt", "attemptExpiresAt"];
  const trustFields = ["issuer", "kid", "publicKeyPem", "profileDigest", "projectIds", "audiences"];
  const configFields = ["expected", "trust", "now", ...expectedFields.map((field) => `expected.${field}`),
    ...trustFields.map((field) => `trust.0.${field}`)];
  const wrongTypes = [undefined, null, Symbol("invalid"), {}, [], true, 1n, () => "consumer.test"];
  it.each(configFields)("N-04 configuration field %s rejects missing and wrong runtime types", (field) => {
    for (const replacement of wrongTypes) {
      if (field === "expected.target.workflowId" && replacement === null) continue;
      if (field === "trust" && Array.isArray(replacement)) continue; // Empty store is valid but trusts no key.
      const options = config();
      setField(options, field, replacement);
      expect(error(goldenPass, options).code).toBe("grounding_verification_unavailable");
    }
    const options = config();
    const parts = field.split(".");
    let record = options as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) record = record[part] as Record<string, unknown>;
    delete record[parts.at(-1)!];
    expect(error(goldenPass, options).code).toBe("grounding_verification_unavailable");
  });
  it("N-04 rejects missing configuration and exceptional objects with the stable unavailable error", () => {
    for (const value of [null, false, [], Symbol("config"), new Proxy({}, { ownKeys() { throw new Error("trap"); } })]) {
      expect(error(goldenPass, value).code).toBe("grounding_verification_unavailable");
    }
    const options = config();
    Object.defineProperty(options.expected, "audience", { get() { throw new Error("accessor"); } });
    expect(error(goldenPass, options).code).toBe("grounding_verification_unavailable");
  });
  it.each(["now", "expected.contextRevision", "expected.session.revision", "expected.attemptCreatedAt", "expected.attemptExpiresAt"])(
    "N-08 requires exact nonnegative safe integer %s", (field) => {
      for (const replacement of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
        const options = config();
        setField(options, field, replacement);
        expect(error(goldenPass, options).code).toBe("grounding_verification_unavailable");
      }
      if (field.includes("Revision") || field.endsWith("revision")) {
        const options = config();
        setField(options, field, 0);
        expect(error(goldenPass, options).code).toBe("grounding_verification_unavailable");
      }
    });
  it("N-04 validates every entry and every scope member including sparse slots and revoked entries", () => {
    for (const member of [undefined, null, Symbol("entry"), [], {}, "entry"]) {
      expect(error(goldenPass, config({ trust: [config().trust[0], member] } as unknown as GroundingReceiptVerifierConfig)).code)
        .toBe("grounding_verification_unavailable");
    }
    for (const scope of ["audiences", "projectIds"] as const) {
      for (const members of [[], [null], [undefined], [Symbol("scope")], new Array(1), [config().trust[0][scope][0], null]]) {
        const extra = { ...config().trust[0], kid: "unused", [scope]: members };
        expect(error(goldenPass, config({ trust: [config().trust[0], extra] } as unknown as GroundingReceiptVerifierConfig)).code)
          .toBe("grounding_verification_unavailable");
      }
    }
    const extra = { ...config().trust[0], kid: "unused", revoked: true };
    delete (extra as Partial<typeof extra>).issuer;
    expect(error(goldenPass, config({ trust: [config().trust[0], extra] })).code).toBe("grounding_verification_unavailable");
    for (const revoked of [null, "false", 0, Symbol("revoked")]) {
      expect(error(goldenPass, config({ trust: [{ ...config().trust[0], revoked }] } as unknown as GroundingReceiptVerifierConfig)).code)
        .toBe("grounding_verification_unavailable");
    }
  });
  it("N-04 rejects malformed string values without coercing numeric configuration", () => {
    const strings = ["expected.audience", "expected.projectId", "expected.taskId", "expected.attemptId",
      "expected.nonce", "expected.subjectDigest", "expected.target.from", "expected.target.to",
      "expected.target.action", "expected.session.id", "trust.0.issuer", "trust.0.kid", "trust.0.profileDigest"];
    for (const field of strings) {
      for (const value of [0, 1, "", "with whitespace", "consumer.test\n", "x".repeat(129)]) {
        const options = config();
        setField(options, field, value);
        expect(error(goldenPass, options).code).toBe("grounding_verification_unavailable");
      }
    }
  });
  it("N-04 validates actual array slots, not custom iterators or accessors", () => {
    const options = config();
    const audiences = [null];
    Object.defineProperty(audiences, Symbol.iterator, { value: function* () { yield payload.audience; } });
    setField(options, "trust.0.audiences", audiences);
    expect(error(goldenPass, options).code).toBe("grounding_verification_unavailable");
    const accessorScope = [payload.audience];
    Object.defineProperty(accessorScope, "0", { get: () => payload.audience });
    setField(options, "trust.0.audiences", accessorScope);
    expect(error(goldenPass, options).code).toBe("grounding_verification_unavailable");
    const trust = [null];
    Object.defineProperty(trust, Symbol.iterator, { value: function* () { yield config().trust[0]; } });
    expect(error(goldenPass, { ...config(), trust }).code).toBe("grounding_verification_unavailable");
  });
  it("N-04 requires canonical 32-byte nonce spelling", () => {
    const last = payload.nonce.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alternate = payload.nonce.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
    expect(Buffer.from(alternate, "base64url")).toEqual(Buffer.from(payload.nonce, "base64url"));
    for (const nonce of [alternate, `${payload.nonce}=`, "A".repeat(42), "A".repeat(44), "!"]) {
      expect(error(goldenPass, config({ expected: { ...contextFor(payload), nonce } })).code).toBe("grounding_verification_unavailable");
    }
  });
  it("N-04 parses all configured public Ed25519 keys, including unused keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const malformedKeys = ["", "garbage", "-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----\n",
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      rsa.publicKey.export({ format: "pem", type: "spki" }).toString(),
      ec.publicKey.export({ format: "pem", type: "spki" }).toString(), `${keys.publicKeyPem}garbage`];
    for (const publicKeyPem of malformedKeys) {
      for (const unused of [false, true]) {
        const bad = { ...config().trust[0], kid: unused ? "unused" : "test-key", publicKeyPem };
        expect(error(goldenPass, config({ trust: unused ? [config().trust[0], bad] : [bad] })).code)
          .toBe("grounding_verification_unavailable");
      }
    }
  });

  it.each([
    { name: "both timestamps at past skew", evaluated: -60, issued: -60, expires: 200, result: "pass" },
    { name: "evaluation before past skew", evaluated: -61, issued: 1, expires: 200, result: "stale" },
    { name: "both before past skew", evaluated: -61, issued: -61, expires: 200, result: "stale" },
    { name: "issuance at future skew", evaluated: 0, issued: 90, expires: 200, result: "pass" },
    { name: "issuance beyond future skew", evaluated: 0, issued: 91, expires: 200, result: "stale" },
    { name: "both at future skew", evaluated: 90, issued: 90, expires: 200, result: "pass" },
    { name: "both beyond future skew", evaluated: 91, issued: 91, expires: 200, result: "stale" },
    { name: "receipt expires at now", evaluated: 0, issued: 1, expires: 30, result: "stale" },
    { name: "receipt expires after now", evaluated: 0, issued: 1, expires: 31, result: "pass" },
    { name: "900 second receipt lifetime", evaluated: 0, issued: 1, expires: 900, result: "pass" },
    { name: "901 second receipt lifetime", evaluated: 0, issued: 1, expires: 901, result: "invalid" },
    { name: "evaluation after issuance", evaluated: 2, issued: 1, expires: 100, result: "invalid" },
    { name: "issuance equals expiry", evaluated: 0, issued: 1, expires: 1, result: "invalid" },
  ])("N-08 independently checks $name", ({ evaluated, issued, expires, result }) => {
    const p = changedPayload((next) => { next.evaluatedAt = epoch + evaluated; next.issuedAt = epoch + issued; next.expiresAt = epoch + expires; });
    if (result === "pass") expectPass(p);
    else expect(error(signedPayload(p)).code).toBe(`grounding_receipt_${result}`);
  });
  it.each([199, 200, 201])("N-08 binds receipt expiry %s to the actual short challenge expiry 200", (expires) => {
    const p = changedPayload((next) => { next.expiresAt = epoch + expires; });
    const options = config({ expected: contextFor(payload, epoch, epoch + 200) });
    if (expires <= 200) expectPass(p, options);
    else expect(error(signedPayload(p), options).code).toBe("grounding_receipt_stale");
  });
  it("N-08 expires the stored challenge even when receipt expiry is later", () => {
    const p = changedPayload((next) => { next.expiresAt = epoch + 201; });
    const options = config({ now: epoch + 200, expected: contextFor(payload, epoch, epoch + 200) });
    expect(error(signedPayload(p), options).code).toBe("grounding_receipt_stale");
  });
  it.each([0, -1, 86_401])("N-08 rejects malformed challenge lifetime %s as configuration", (lifetime) => {
    expect(error(goldenPass, config({ expected: contextFor(payload, epoch, epoch + lifetime) })).code)
      .toBe("grounding_verification_unavailable");
  });
  it("N-08 accepts exactly 24h challenge lifetime, then expires without clock-skew extension", () => {
    const p = changedPayload((next) => { next.evaluatedAt = epoch + 86_390; next.issuedAt = epoch + 86_391; next.expiresAt = epoch + 86_400; });
    const options = config({ now: epoch + 86_399, expected: contextFor(payload, epoch, epoch + 86_400) });
    expectPass(p, options);
    expect(error(signedPayload(p), { ...options, now: epoch + 86_400 }).code).toBe("grounding_receipt_stale");
  });
  it("N-08 validates the stored start's future skew independently", () => {
    const p = changedPayload((next) => { next.evaluatedAt = epoch + 90; next.issuedAt = epoch + 90; next.expiresAt = epoch + 200; });
    expectPass(p, config({ expected: contextFor(payload, epoch + 90, epoch + 200) }));
    expect(error(signedPayload(p), config({ expected: contextFor(payload, epoch + 91, epoch + 200) })).code)
      .toBe("grounding_verification_unavailable");
  });
  it("N-02/N-04 keeps fail outcome behind schema, config, authentication, scope, context and freshness", () => {
    const failedPayload = json<FixturePayload>("golden-fail.payload.json");
    expect(error("{}", { now: NaN }).code).toBe("grounding_receipt_invalid");
    expect(error(goldenFail, config({ now: NaN })).code).toBe("grounding_verification_unavailable");
    expect(error(signedPayload(failedPayload, rotated.privateKey), config({ now: epoch + 900 })).code).toBe("grounding_receipt_untrusted");
    expect(error(goldenFail, config({ trust: [{ ...config().trust[0], audiences: ["other"] }], now: epoch + 900 })).code).toBe("grounding_receipt_untrusted");
    expect(error(goldenFail, config({ expected: { ...contextFor(payload), taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, now: epoch + 900 })).code).toBe("grounding_receipt_mismatch");
    expect(error(goldenFail, config({ now: epoch + 900 })).code).toBe("grounding_receipt_stale");
    expect(error(goldenFail)).toMatchObject({ code: "grounding_required", detail: "assessment_failed" });
  });
});

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function cloneFixture(): string {
  const dir = temporary("grounding-corpus-");
  cpSync(fixture, dir, { recursive: true });
  return dir;
}
// @ts-expect-error Plain ESM CLI helpers have no TypeScript declaration file.
const utility = await import("../../../scripts/grounding-receipt-contract.mjs");
const productionRevision = "0884c4054c446648aaaf44e2fe9eef5dff5648cf";
function localProducer(change?: (source: string) => void) {
  const producer = temporary("grounding-producer-");
  const source = join(producer, "packages/grounding-mcp/contracts/grounding-receipt-v1");
  mkdirSync(source, { recursive: true });
  cpSync(fixture, source, { recursive: true });
  rmSync(join(source, "PIN.json"));
  change?.(source);
  for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Fixture Test"], ["add", "."], ["-c", "commit.gpgsign=false", "commit", "-m", "fixtures"]]) {
    expect(spawnSync("git", args, { cwd: producer }).status).toBe(0);
  }
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: producer, encoding: "utf8" }).stdout.trim();
  const manifestSha256 = createHash("sha256").update(readFileSync(join(source, "manifest.json"))).digest("hex");
  return { producer, source, pin: { producerRevision: revision, manifestSha256 } };
}
describe("pinned grounding receipt corpus", () => {
  const script = resolve("../scripts/grounding-receipt-contract.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  it("N-25 checks the entire vendor manifest offline through the executable", () => {
    const result = run("check", "--target", cloneFixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("offline corpus OK (18 files)\n");
  });
  it.each([
    ["PIN.json", JSON.stringify({ producerRevision: "a".repeat(40), manifestSha256: "b".repeat(64) }), "PIN.json differs"],
    ["manifest.json", JSON.stringify({ format: "grounding-receipt/v1", schemaVersion: 1, files: [] }), "manifest digest"],
    ["golden-pass.receipt", "x", "fixture digest mismatch"],
    ["unexpected.txt", "x", "fixture inventory differs"],
  ])("N-25 rejects corrupted %s", (file, contents, message) => {
    const dir = cloneFixture();
    writeFileSync(join(dir, file), contents);
    const result = run("check", "--target", dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
  it("N-25 independently rejects changed manifest bytes with identical semantics", () => {
    const dir = cloneFixture();
    writeFileSync(join(dir, "manifest.json"), `${readFileSync(join(dir, "manifest.json"), "utf8")} `);
    const result = run("check", "--target", dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest digest");
  });
  it("N-25 cannot re-anchor integrity by editing mutable PIN and manifest together", () => {
    const dir = cloneFixture();
    const changed = Buffer.from(`${readFileSync(join(dir, "manifest.json"), "utf8")} `);
    writeFileSync(join(dir, "manifest.json"), changed);
    writeFileSync(join(dir, "PIN.json"), JSON.stringify({ producerRevision: productionRevision, manifestSha256: createHash("sha256").update(changed).digest("hex") }));
    expect(run("check", "--target", dir).status).toBe(1);
  });
  it.each([
    [], ["wat"], ["check", "--target"], ["check", "--unknown", "x"], ["check", "--producer", "x"],
    ["check", "--target", "x", "--target", "y"], ["sync"], ["sync", "--producer"],
    ["sync", "--producer", "x"], ["sync", "--producer", "x", "--revision"],
    ["sync", "--producer", "--revision", productionRevision],
    ["sync", "--producer", "x", "--revision", "0884c405"],
    ["sync", "--producer", "x", "--revision", "a".repeat(40)],
    ["sync", "--producer", "x", "--revision", productionRevision, "--revision", productionRevision],
    ["sync", "--producer", "x", "--revision", productionRevision, "--pin", "other"],
  ])("N-25 rejects malformed public CLI arguments %j", (...args: string[]) => {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage:");
  });
  it("N-25 public pinned sync arguments reach Git validation and preserve a temporary destination", () => {
    const target = cloneFixture();
    const producer = temporary("grounding-empty-");
    const result = run("sync", "--producer", producer, "--revision", productionRevision, "--target", target);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("producer revision is unavailable");
    expect(run("check", "--target", target).status).toBe(0);
  });
  it("N-25 exercises the shared CLI argument contract with explicit temporary Git pins and no producer checkout dependency", () => {
    const { producer, source, pin } = localProducer();
    const target = cloneFixture();
    writeFileSync(join(source, "golden-pass.receipt"), "dirty working tree must not sync");
    expect(utility.runContract(["sync", "--producer", producer, "--revision", pin.producerRevision, "--target", target], pin))
      .toBe(`synced pinned corpus ${pin.producerRevision}\n`);
    expect(readFileSync(join(target, "golden-pass.receipt"))).toEqual(goldenPass);
    expect(() => utility.runContract(["sync", "--producer", producer, "--target", target], pin)).toThrow("usage:");
    rmSync(producer, { recursive: true, force: true });
    expect(utility.runContract(["check", "--target", target], pin)).toBe("offline corpus OK (18 files)\n");
    expect(run("check", "--target", target).stderr).toContain("PIN.json differs");
  });
  it("N-25 staging errors preserve the destination and clean only their own temporary directory", () => {
    const { producer, pin } = localProducer((source) => writeFileSync(join(source, "golden-pass.receipt"), "bad committed specimen"));
    const parent = temporary("grounding-stage-");
    const target = join(parent, "target");
    cpSync(fixture, target, { recursive: true });
    const legacyStaging = `${target}.sync-staging`;
    mkdirSync(legacyStaging);
    writeFileSync(join(legacyStaging, "sentinel"), "retain");
    expect(() => utility.syncCorpus({ producer, target, pin })).toThrow("fixture digest mismatch");
    expect(run("check", "--target", target).status).toBe(0);
    expect(readFileSync(join(legacyStaging, "sentinel"), "utf8")).toBe("retain");
    expect(readdirSync(parent).sort()).toEqual(["target", "target.sync-staging"]);
  });
  it.each(["../escape", "/absolute", ".", "..", "PIN.json", "manifest.json", "nested/file", "nested\\file"])(
    "N-25 rejects unsafe or reserved manifest member %s before staging", (path) => {
      const { producer, pin } = localProducer((source) => {
        const manifest = json<{ files: { path: string; bytes: number; sha256: string; }[]; }>("manifest.json");
        manifest.files[0].path = path;
        writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
      });
      const target = cloneFixture();
      expect(() => utility.syncCorpus({ producer, target, pin })).toThrow("invalid manifest file entry");
      expect(run("check", "--target", target).status).toBe(0);
    });
  it("N-25 does not replace an unrelated directory, symlink, or producer ancestor", () => {
    const { producer, pin } = localProducer();
    const target = temporary("grounding-unrelated-");
    writeFileSync(join(target, "sentinel"), "retain");
    expect(() => utility.syncCorpus({ producer, target, pin })).toThrow();
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("retain");
    const link = join(temporary("grounding-link-"), "target");
    symlinkSync(target, link);
    expect(() => utility.syncCorpus({ producer, target: link, pin })).toThrow("not a symlink");
    expect(() => utility.syncCorpus({ producer, target: producer, pin })).toThrow("must not contain the producer");
  });
});
