import { createPrivateKey, sign } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GroundingReceiptVerificationError, verifyGroundingReceipt, type GroundingReceiptVerifierConfig } from "../../src/services/grounding-receipt.js";

const fixture = resolve("tests/fixtures/grounding-receipt-v1");
const json = <T>(name: string): T => JSON.parse(readFileSync(join(fixture, name), "utf8")) as T;
const keys = json<{ publicKeyPem: string; seedHex: string; pkcs8DerPrefixHex: string }>("test-keys.json");
const payload = json<Record<string, unknown>>("golden-pass.payload.json");
const expected = {
  audience: payload.audience as string, projectId: payload.projectId as string, taskId: payload.taskId as string,
  attemptId: payload.attemptId as string, nonce: payload.nonce as string, contextRevision: payload.contextRevision as number,
  target: payload.target as GroundingReceiptVerifierConfig["expected"]["target"], subjectDigest: (payload.subject as { digest: string }).digest,
  session: payload.session as { id: string; revision: number }, attemptCreatedAt: 1_700_000_000, attemptExpiresAt: 1_700_000_900,
};
const config = (overrides: Partial<GroundingReceiptVerifierConfig> = {}): GroundingReceiptVerifierConfig => ({
  now: 1_700_000_030, expected,
  trust: [{ issuer: "test.issuer", kid: "test-key", publicKeyPem: keys.publicKeyPem, profileDigest: "50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4", projectIds: [expected.projectId], audiences: [expected.audience] }],
  ...overrides,
});
function error(input: Uint8Array | string, options = config()): GroundingReceiptVerificationError {
  try { verifyGroundingReceipt(input, options); throw new Error("expected receipt verification to fail"); }
  catch (caught) { expect(caught).toBeInstanceOf(GroundingReceiptVerificationError); return caught as GroundingReceiptVerificationError; }
}
function resign(change: (next: Record<string, unknown>) => void): Uint8Array {
  const next = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>; change(next);
  const body = Buffer.from(JSON.stringify(next), "utf8").toString("base64url");
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from(keys.pkcs8DerPrefixHex, "hex"), Buffer.from(keys.seedHex, "hex")]), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(`grounding-receipt/v1\nEd25519\ntest.issuer\ntest-key\n${body}`, "utf8"), privateKey).toString("base64url");
  return Buffer.from(JSON.stringify({ format: "grounding-receipt/v1", alg: "Ed25519", issuer: "test.issuer", kid: "test-key", payload: body, signature }), "utf8");
}

describe("grounding receipt consumer verifier", () => {
  it("N-02 authenticates an agent_asserted pass but never presents a signed fail as evidence", () => {
    const evidence = verifyGroundingReceipt(readFileSync(join(fixture, "golden-pass.receipt")), config());
    expect(evidence).toMatchObject({ evidenceOrigin: "agent_asserted", receiptId: payload.receiptId });
    const failed = error(readFileSync(join(fixture, "golden-fail.receipt")), config());
    expect(failed.code).toBe("grounding_required"); expect(failed.detail).toBe("assessment_failed");
  });

  it("N-02 accepts all producer positive declarations through syntax and keeps each signed fail ineligible", () => {
    const cases = json<{ cases: { wireBase64: string }[] }>("positive-vectors.json").cases;
    for (const vector of cases) {
      const wire = Buffer.from(vector.wireBase64, "base64");
      const envelope = JSON.parse(wire.toString("utf8")) as { issuer: string; kid: string; payload: string };
      const signedPayload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as { projectId: string; audience: string };
      const scoped = config({ trust: [{ ...config().trust[0], issuer: envelope.issuer, kid: envelope.kid, projectIds: [signedPayload.projectId], audiences: [signedPayload.audience] }] });
      try { verifyGroundingReceipt(wire, scoped); }
      catch (caught) { expect((caught as GroundingReceiptVerificationError).code).not.toMatch(/invalid|unsupported|untrusted/); }
    }
  });

  it("N-03/N-04/N-18 rejects every producer negative vector with the mapped stable category", () => {
    const vectors = json<{ cases: { expected: { code: "invalid" | "unsupported" | "untrusted" }; wireBase64: string }[] }>("negative-vectors.json").cases;
    const map = { invalid: "grounding_receipt_invalid", unsupported: "grounding_receipt_unsupported", untrusted: "grounding_receipt_untrusted" } as const;
    for (const vector of vectors) expect(error(Buffer.from(vector.wireBase64, "base64")).code).toBe(map[vector.expected.code]);
  });

  it("N-05 compares every signed producer context vector against exact server context", () => {
    const vectors = json<{ cases: { wireBase64: string }[] }>("context-vectors.json").cases;
    const projectIds = new Set<string>([expected.projectId]); const audiences = new Set<string>([expected.audience]);
    for (const vector of vectors) { const wire = Buffer.from(vector.wireBase64, "base64"); const envelope = JSON.parse(wire.toString("utf8")) as { payload: string }; const next = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as { projectId: string; audience: string }; projectIds.add(next.projectId); audiences.add(next.audience); }
    const scoped = config({ trust: [{ ...config().trust[0], projectIds: [...projectIds], audiences: [...audiences] }] });
    for (const vector of vectors) expect(error(Buffer.from(vector.wireBase64, "base64"), scoped).code).toBe("grounding_receipt_mismatch");
  });

  it("N-04 rejects unknown, revoked, and wrongly scoped issuer entries after strict config validation", () => {
    expect(error(readFileSync(join(fixture, "golden-pass.receipt")), config({ trust: [] })).code).toBe("grounding_receipt_untrusted");
    expect(error(readFileSync(join(fixture, "golden-pass.receipt")), config({ trust: [{ ...config().trust[0], revoked: true }] })).code).toBe("grounding_receipt_untrusted");
    expect(error(readFileSync(join(fixture, "golden-pass.receipt")), config({ trust: [{ ...config().trust[0], projectIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] }] })).code).toBe("grounding_receipt_untrusted");
    expect(error(readFileSync(join(fixture, "golden-pass.receipt")), config({ trust: [{ ...config().trust[0], profileDigest: "a".repeat(64) }] })).code).toBe("grounding_receipt_untrusted");
    expect(error(readFileSync(join(fixture, "golden-pass.receipt")), config({ now: Number.NaN })).code).toBe("grounding_verification_unavailable");
  });

  it("N-08 fail-closes skew, expiry, and an expired expected attempt", () => {
    expect(error(resign((next) => { next.issuedAt = 1_700_000_091; next.expiresAt = 1_700_000_190; }), config()).code).toBe("grounding_receipt_stale");
    expect(error(resign((next) => { next.issuedAt = 1_699_999_939; next.evaluatedAt = 1_699_999_939; next.expiresAt = 1_700_000_031; }), config()).code).toBe("grounding_receipt_stale");
    expect(error(readFileSync(join(fixture, "golden-pass.receipt")), config({ expected: { ...expected, attemptCreatedAt: 1_699_913_629, attemptExpiresAt: 1_699_914_529 } })).code).toBe("grounding_receipt_stale");
  });

  it("N-08 accepts exactly 60 seconds future skew and rejects the exact expiry boundary", () => {
    const future = resign((next) => { next.evaluatedAt = 1_700_000_090; next.issuedAt = 1_700_000_090; next.expiresAt = 1_700_000_200; });
    expect(verifyGroundingReceipt(future, config())).toMatchObject({ evidenceOrigin: "agent_asserted" });
    expect(error(readFileSync(join(fixture, "golden-pass.receipt")), config({ now: 1_700_000_900 })).code).toBe("grounding_receipt_stale");
  });
});

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
function cloneFixture(): string { const dir = mkdtempSync(join(tmpdir(), "grounding-corpus-")); temps.push(dir); cpSync(fixture, dir, { recursive: true }); return dir; }
describe("pinned grounding receipt corpus", () => {
  const script = resolve("../scripts/grounding-receipt-contract.mjs");
  const run = (...arguments_: string[]) => spawnSync(process.execPath, [script, ...arguments_], { encoding: "utf8" });
  it("N-25 checks the full vendor manifest while entirely offline", () => {
    const dir = cloneFixture(); const result = run("check", "--target", dir);
    expect(result.status).toBe(0); expect(result.stdout).toContain("offline corpus OK");
  });
  it("N-25 rejects well-formed wrong pins, matching manifest metadata, specimens, and extra files", () => {
    for (const [file, contents] of [["PIN.json", JSON.stringify({ producerRevision: "a".repeat(40), manifestSha256: "b".repeat(64) })], ["manifest.json", JSON.stringify({ format: "grounding-receipt/v1", schemaVersion: 1, files: [] })], ["golden-pass.receipt", "x"], ["unexpected.txt", "x"]] as const) { const dir = cloneFixture(); writeFileSync(join(dir, file), contents); expect(run("check", "--target", dir).status).not.toBe(0); }
  });
  it("N-25 independently rejects a semantically identical manifest with changed bytes", () => {
    const dir = cloneFixture(); const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
    writeFileSync(join(dir, "manifest.json"), `${manifest} `);
    expect(run("check", "--target", dir).status).not.toBe(0);
  });
  it("N-25 syncs only explicit local Git objects and stays checkable after source removal", async () => {
    const producer = mkdtempSync(join(tmpdir(), "grounding-producer-")); temps.push(producer); const source = join(producer, "packages/grounding-mcp/contracts/grounding-receipt-v1"); mkdirSync(source, { recursive: true });
    cpSync(fixture, source, { recursive: true }); rmSync(join(source, "PIN.json"));
    for (const command of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Fixture Test"], ["add", "."], ["commit", "-m", "fixtures"]]) expect(spawnSync("git", command, { cwd: producer }).status).toBe(0);
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: producer, encoding: "utf8" }).stdout.trim(); const manifestSha256 = (await import("node:crypto")).createHash("sha256").update(readFileSync(join(source, "manifest.json"))).digest("hex");
    // The CLI is deliberately plain ESM; this test imports its exported test helper.
    // @ts-expect-error JavaScript CLI helpers have no TypeScript declaration file.
    const utility = await import("../../../scripts/grounding-receipt-contract.mjs"); const target = cloneFixture();
    writeFileSync(join(source, "golden-pass.receipt"), "dirty bytes must not sync"); utility.syncCorpus({ producer, target, pin: { producerRevision: revision, manifestSha256 } });
    utility.validateCorpus(target, { producerRevision: revision, manifestSha256 }); expect(readFileSync(join(target, "golden-pass.receipt"))).not.toEqual(readFileSync(join(source, "golden-pass.receipt")));
    rmSync(producer, { recursive: true, force: true }); expect(() => utility.validateCorpus(target, { producerRevision: revision, manifestSha256 })).not.toThrow();
  });
});
