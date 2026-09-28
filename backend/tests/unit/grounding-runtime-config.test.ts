import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGroundingRuntimeConfig } from "../../src/config/grounding-runtime.js";
import { ids, testIssuer } from "../helpers/grounding-fixtures.js";

const valid = () => ({ enabled: true, audience: "consumer.test", trust: testIssuer().trust, creationPolicy: [{ projectId: ids.project, subjectMode: "TASK_SPEC" }] });

describe("strict grounding runtime configuration", () => {
  it.each([undefined, "", '{"enabled":false}'])("preserves explicit empty disabled input %s", raw => {
    expect(parseGroundingRuntimeConfig(raw)).toEqual({ enabled: false });
  });
  it("validates public trust and defaults the challenge lifetime", () => {
    const input = valid();
    expect(parseGroundingRuntimeConfig(JSON.stringify(input))).toEqual({ ...input, challengeSeconds: 900 });
    expect(parseGroundingRuntimeConfig('{"enabled":true,"audience":"consumer.test","trust":[],"creationPolicy":[]}')).toMatchObject({ enabled: true, creationPolicy: [] });
  });
  it("freezes trust scopes and creation selection after parsing", () => {
    const input = valid(); const parsed = parseGroundingRuntimeConfig(JSON.stringify(input));
    if (!parsed.enabled) throw new Error("Expected enabled configuration");
    expect(() => { parsed.trust[0]!.projectIds.push(ids.task); }).toThrow();
    expect(() => { parsed.trust[0]!.revoked = true; }).toThrow();
    expect(() => { parsed.creationPolicy[0]!.subjectMode = "CODE_HEAD"; }).toThrow();
    expect(() => { parsed.creationPolicy.pop(); }).toThrow();
    input.trust[0]!.audiences = ["changed"];
    expect(parsed.trust[0]!.audiences).toEqual(["consumer.test"]);
  });
  it.each([" ", "{", "null", "[]", "true", '{"enabled":"false"}', '{"enabled":false,"audience":"ignored"}', '{"enabled":false,"signingKey":"secret"}', '{"enabled":false,"enabled":true}', '{"enabled":false,"enab\\u006ced":false}'])("rejects malformed, unknown and duplicate fields: %s", raw => {
    expect(() => parseGroundingRuntimeConfig(raw)).toThrow("Invalid GROUNDING_RUNTIME_CONFIG");
  });
  it.each([
    ["private material", (value: ReturnType<typeof valid>) => Object.assign(value, { privateKey: "never-log-this" })],
    ["missing selection", (value: ReturnType<typeof valid>) => Reflect.deleteProperty(value, "creationPolicy")],
    ["invalid audience", (value: ReturnType<typeof valid>) => { value.audience = "https://not-a-token"; }],
    ["duplicate project", (value: ReturnType<typeof valid>) => { value.creationPolicy.push(value.creationPolicy[0]!); }],
    ["bad project", (value: ReturnType<typeof valid>) => { value.creationPolicy[0]!.projectId = "not-uuid"; }],
    ["bad mode", (value: ReturnType<typeof valid>) => { value.creationPolicy[0]!.subjectMode = "OFF"; }],
    ["duplicate trust", (value: ReturnType<typeof valid>) => { value.trust.push(value.trust[0]!); }],
    ["duplicate scope", (value: ReturnType<typeof valid>) => { value.trust[0]!.projectIds = [ids.project, ids.project]; }],
    ["unknown trust field", (value: ReturnType<typeof valid>) => Object.assign(value.trust[0]!, { privateKeyPem: "never-log-this" })],
    ["private PEM", (value: ReturnType<typeof valid>) => { value.trust[0]!.publicKeyPem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(); }],
    ["wrong algorithm", (value: ReturnType<typeof valid>) => { value.trust[0]!.publicKeyPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString(); }],
    ["invalid unused revoked key", (value: ReturnType<typeof valid>) => { value.trust.push({ ...value.trust[0]!, kid: "revoked", publicKeyPem: "invalid", revoked: true }); }],
    ["too many entries", (value: ReturnType<typeof valid>) => { value.trust = Array.from({ length: 65 }, (_, i) => ({ ...value.trust[0]!, kid: `key${i}` })); }],
  ])("rejects %s without reflecting input", (_name, mutate) => {
    const value = valid(); mutate(value);
    expect(() => parseGroundingRuntimeConfig(JSON.stringify(value))).toThrow(/^Invalid GROUNDING_RUNTIME_CONFIG$/);
  });
  it.each([0, -1, 86401, 1.5, "900"])("rejects invalid challenge lifetime %s", challengeSeconds => {
    expect(() => parseGroundingRuntimeConfig(JSON.stringify({ ...valid(), challengeSeconds }))).toThrow();
  });
  it("rejects nested duplicate keys and input beyond the byte bound", () => {
    const raw = JSON.stringify(valid()).replace('"subjectMode":"TASK_SPEC"', '"subjectMode":"TASK_SPEC","subjectMode":"CODE_HEAD"');
    expect(() => parseGroundingRuntimeConfig(raw)).toThrow();
    expect(() => parseGroundingRuntimeConfig('{"enabled":false}' + " ".repeat(65536))).toThrow();
  });
});
