/**
 * Offline consumer for the producer-owned grounding-receipt/v1 byte format.
 * This is intentionally a pure verifier: callers inject trust, expected server
 * context, and time.  It does not load keys, contact a producer, or authorize
 * a task transition.
 */
import * as crypto from "node:crypto";
const FORMAT = "grounding-receipt/v1";
const ALGORITHM = "Ed25519";
const POLICY_ID = "debug-evidence-assessment/v1";
const POLICY_REVISION = "1";
const POLICY_SHA256 = "50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4";
const MAX_WIRE_BYTES = 32768;
const MAX_PAYLOAD_BYTES = 16384;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASONS = ["session_binding_invalid", "session_revision_invalid", "mandatory_steps_incomplete", "fact_missing", "claim_missing", "claim_prerequisites_missing"] as const;
export type GroundingReceiptErrorCode = "grounding_receipt_invalid" | "grounding_receipt_unsupported" | "grounding_receipt_untrusted" | "grounding_receipt_mismatch" | "grounding_receipt_stale" | "grounding_required" | "grounding_verification_unavailable";
export class GroundingReceiptVerificationError extends Error {
  constructor(readonly code: GroundingReceiptErrorCode, readonly detail?: "assessment_failed") {
    super(code);
    this.name = "GroundingReceiptVerificationError";
  }
}
export interface GroundingReceiptTrustEntry {
  issuer: string;
  kid: string;
  publicKeyPem: string;
  /** The pinned producer policy profile digest, never inferred from a receipt. */
  profileDigest: string;
  projectIds: readonly string[];
  audiences: readonly string[];
  revoked?: boolean;
}
export interface GroundingReceiptExpectedContext {
  audience: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  nonce: string;
  contextRevision: number;
  target: {
    workflowId: string | null;
    from: string;
    to: string;
    action: string;
  };
  subjectDigest: string;
  session: {
    id: string;
    revision: number;
  };
  /** Server-recorded start time of this specific finish attempt. */
  attemptCreatedAt: number;
  /** Server-recorded expiry of this specific challenge; no receipt can extend it. */
  attemptExpiresAt: number;
}
export interface GroundingReceiptVerifierConfig {
  trust: readonly GroundingReceiptTrustEntry[];
  expected: GroundingReceiptExpectedContext;
  /** Injected server time in epoch seconds. */
  now: number;
}
export interface AgentAssertedGroundingEvidence {
  evidenceOrigin: "agent_asserted";
  receiptId: string;
  assessmentDossierSha256: string;
  evaluatedAt: number;
  issuedAt: number;
  expiresAt: number;
}
type Payload = {
  schemaVersion: 1;
  receiptId: string;
  audience: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  nonce: string;
  contextRevision: number;
  target: {
    workflowId: string | null;
    from: string;
    to: string;
    action: string;
  };
  subject: {
    kind: "task-context/v1";
    digest: string;
  };
  policy: {
    id: typeof POLICY_ID;
    revision: typeof POLICY_REVISION;
    sha256: typeof POLICY_SHA256;
  };
  session: {
    id: string;
    revision: number;
  };
  assessment: {
    outcome: "pass" | "fail";
    evidenceOrigin: "agent_asserted";
    factCount: number;
    claimAllowed: boolean;
    reasons: string[];
    dossierSha256: string;
  };
  evaluatedAt: number;
  issuedAt: number;
  expiresAt: number;
  producer: {
    name: string;
    version: string;
    policyBuild: string;
  };
};
type Envelope = {
  format: typeof FORMAT;
  alg: typeof ALGORITHM;
  issuer: string;
  kid: string;
  payload: string;
  signature: string;
};
function fail(code: GroundingReceiptErrorCode, detail?: "assessment_failed"): never {
  throw new GroundingReceiptVerificationError(code, detail);
}

function invalid(): never { return fail("grounding_receipt_invalid"); }

function unsupported(): never { return fail("grounding_receipt_unsupported"); }

function ensure(condition: unknown): asserts condition {
  if (!condition)
    invalid();
}

function obj(value: unknown, keys: readonly string[], ordered = true): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value));
  const actual = Object.keys(value);
  ensure(actual.length === keys.length && keys.every((key, index) => ordered ? actual[index] === key : actual.includes(key)));
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  ensure(typeof value === "string");
  return value;
}

function token(value: unknown): string {
  const result = text(value);
  ensure(TOKEN.test(result));
  return result;
}

function sha(value: unknown): string {
  const result = text(value);
  ensure(SHA256.test(result));
  return result;
}

function int(value: unknown, positive = false): number {
  ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0));
  return value;
}

function uuid(value: unknown, v4 = false): string {
  const result = text(value);
  ensure((v4 ? UUID_V4 : UUID).test(result));
  return result;
}

function b64(value: unknown, bytes?: number): string {
  const result = text(value);
  ensure(/^[A-Za-z0-9_-]*$/.test(result) && !result.includes("="));
  const decoded = Buffer.from(result, "base64url");
  ensure(decoded.toString("base64url") === result && (bytes === undefined || decoded.length === bytes));
  return result;
}

function scalar(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff)
      continue;
    const next = value.charCodeAt(index + 1);
    if (code > 0xdbff || !Number.isFinite(next) || next < 0xdc00 || next > 0xdfff)
      invalid();
    index += 1;
  }
}

function parseStrictJson(bytes: Uint8Array): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(bytes);
  } catch {
    invalid();
  }
  let at = 0;
  const whitespace = () => {
    while (at < source.length && /[ \t\n\r]/.test(source[at])) {
      at += 1;
    }
  };
  const string = (): string => {
    const start = at;
    ensure(source[at++] === "\"");
    while (at < source.length) {
      const char = source[at++];
      if (char === "\"") {
        try {
          const result = JSON.parse(source.slice(start, at)) as string;
          scalar(result);
          return result;
        }
        catch {
          invalid();
        }
      }
      if (char === "\\") {
        const escape = source[at++];
        if (escape === "u") {
          ensure(/^[0-9a-fA-F]{4}$/.test(source.slice(at, at + 4)));
          at += 4;
        }
        else
          ensure(!!escape && '"\\/bfnrt'.includes(escape));
      } else
        ensure(char.charCodeAt(0) >= 0x20);
    }
    return invalid();
  };
  const value = (depth = 0): void => {
    ensure(depth <= 32);
    whitespace();
    const char = source[at];
    if (char === "{") {
      at += 1;
      whitespace();
      const seen = new Set<string>();
      if (source[at] === "}") {
        at += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        ensure(!seen.has(key));
        seen.add(key);
        whitespace();
        ensure(source[at++] === ":");
        value(depth + 1);
        whitespace();
        if (source[at] === "}") {
          at += 1;
          return;
        }
        ensure(source[at++] === ",");
      }
    }
    if (char === "[") {
      at += 1;
      whitespace();
      if (source[at] === "]") {
        at += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        if (source[at] === "]") {
          at += 1;
          return;
        }
        ensure(source[at++] === ",");
      }
    }
    if (char === "\"") {
      string();
      return;
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
    ensure(primitive);
    at += primitive[0].length;
  };
  value();
  whitespace();
  ensure(at === source.length);
  try {
    return JSON.parse(source);
  } catch {
    return invalid();
  }
}

function canonical(payload: Payload): Uint8Array {
  return Buffer.from(JSON.stringify({
    schemaVersion: payload.schemaVersion,
    receiptId: payload.receiptId,
    audience: payload.audience,
    projectId: payload.projectId,
    taskId: payload.taskId,
    attemptId: payload.attemptId,
    nonce: payload.nonce,
    contextRevision: payload.contextRevision,
    target: payload.target,
    subject: payload.subject,
    policy: payload.policy,
    session: payload.session,
    assessment: payload.assessment,
    evaluatedAt: payload.evaluatedAt,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    producer: payload.producer
  }), "utf8");
}

function validateAssessment(raw: unknown): Payload["assessment"] {
  const a = obj(raw, ["outcome", "evidenceOrigin", "factCount", "claimAllowed", "reasons", "dossierSha256"]);
  ensure(a.outcome === "pass" || a.outcome === "fail");
  ensure(a.evidenceOrigin === "agent_asserted");
  const factCount = int(a.factCount);
  ensure(typeof a.claimAllowed === "boolean");
  ensure(Array.isArray(a.reasons) && a.reasons.length <= REASONS.length);
  let previous = -1;
  const reasons: string[] = [];
  for (const reason of a.reasons) {
    const index = REASONS.indexOf(reason as typeof REASONS[number]);
    ensure(index > previous);
    previous = index;
    reasons.push(reason as string);
  }
  if (a.outcome === "pass") {
    ensure(factCount >= 1 && a.claimAllowed && reasons.length === 0);
  } else {
    ensure(reasons.length > 0);
  }
  ensure((factCount === 0) === reasons.includes("fact_missing"));
  const hasClaimFailure = reasons.some((reason) => reason === "claim_missing" || reason === "claim_prerequisites_missing");
  ensure(a.claimAllowed === !hasClaimFailure);
  return {
    outcome: a.outcome,
    evidenceOrigin: "agent_asserted",
    factCount,
    claimAllowed: a.claimAllowed,
    reasons,
    dossierSha256: sha(a.dossierSha256),
  };
}

function validatePayload(raw: unknown): Payload {
  const p = obj(raw, ["schemaVersion", "receiptId", "audience", "projectId", "taskId", "attemptId", "nonce", "contextRevision", "target", "subject", "policy", "session", "assessment", "evaluatedAt", "issuedAt", "expiresAt", "producer"]);
  ensure(typeof p.schemaVersion === "number" && Number.isSafeInteger(p.schemaVersion));
  if (p.schemaVersion !== 1)
    unsupported();
  const target = obj(p.target, ["workflowId", "from", "to", "action"]);
  ensure(target.workflowId === null || UUID.test(text(target.workflowId)));
  const subject = obj(p.subject, ["kind", "digest"]);
  ensure(typeof subject.kind === "string");
  if (subject.kind !== "task-context/v1")
    unsupported();
  const policy = obj(p.policy, ["id", "revision", "sha256"]);
  ensure(typeof policy.id === "string" && typeof policy.revision === "string" && typeof policy.sha256 === "string");
  if (policy.id !== POLICY_ID || policy.revision !== POLICY_REVISION || policy.sha256 !== POLICY_SHA256)
    unsupported();
  const session = obj(p.session, ["id", "revision"]);
  const producer = obj(p.producer, ["name", "version", "policyBuild"]);
  const assessment = validateAssessment(p.assessment);
  const result: Payload = {
    schemaVersion: 1,
    receiptId: uuid(p.receiptId, true),
    audience: token(p.audience),
    projectId: uuid(p.projectId),
    taskId: uuid(p.taskId),
    attemptId: uuid(p.attemptId),
    nonce: b64(p.nonce, 32),
    contextRevision: int(p.contextRevision, true),
    target: {
      workflowId: target.workflowId as string | null,
      from: token(target.from),
      to: token(target.to),
      action: token(target.action)
    },
    subject: {
      kind: "task-context/v1",
      digest: sha(subject.digest)
    },
    policy: {
      id: POLICY_ID,
      revision: POLICY_REVISION,
      sha256: POLICY_SHA256
    },
    session: {
      id: token(session.id),
      revision: int(session.revision, true)
    },
    assessment,
    evaluatedAt: int(p.evaluatedAt),
    issuedAt: int(p.issuedAt),
    expiresAt: int(p.expiresAt),
    producer: {
      name: token(producer.name),
      version: token(producer.version),
      policyBuild: token(producer.policyBuild)
    }
  };
  ensure(result.evaluatedAt <= result.issuedAt);
  ensure(result.issuedAt < result.expiresAt);
  ensure(result.expiresAt - result.evaluatedAt <= 900);
  return result;
}

function decode(input: Uint8Array | string): {
  envelope: Envelope;
  payload: Payload;
} {
  let wire: Uint8Array;
  if (typeof input === "string") {
    scalar(input);
    ensure(Buffer.byteLength(input, "utf8") <= MAX_WIRE_BYTES);
    wire = Buffer.from(input, "utf8");
  } else {
    ensure(input instanceof Uint8Array);
    wire = input;
  }
  ensure(wire.length <= MAX_WIRE_BYTES);
  const raw = obj(parseStrictJson(wire), ["format", "alg", "issuer", "kid", "payload", "signature"], false);
  ensure(typeof raw.format === "string" && typeof raw.alg === "string");
  if (raw.format !== FORMAT || raw.alg !== ALGORITHM)
    unsupported();
  const envelope: Envelope = {
    format: FORMAT,
    alg: ALGORITHM,
    issuer: token(raw.issuer),
    kid: token(raw.kid),
    payload: b64(raw.payload),
    signature: b64(raw.signature, 64)
  };
  const bytes = Buffer.from(envelope.payload, "base64url");
  ensure(bytes.length <= MAX_PAYLOAD_BYTES);
  const result = validatePayload(parseStrictJson(bytes));
  ensure(Buffer.from(canonical(result)).equals(bytes));
  return {
    envelope,
    payload: result
  };
}
const MAX_CHALLENGE_SECONDS = 86400;
const CLOCK_SKEW_SECONDS = 60;
type ValidatedTrustEntry = Omit<GroundingReceiptTrustEntry, "publicKeyPem"> & {
  key: crypto.KeyObject;
};
type ValidatedConfig = Omit<GroundingReceiptVerifierConfig, "trust"> & {
  trust: ValidatedTrustEntry[];
};
function requireConfig(condition: unknown): asserts condition {
  if (!condition)
    fail("grounding_verification_unavailable");
}

/** Snapshot own data properties: absent fields and accessors are not configuration. */
function configRecord(value: unknown): Record<string, unknown> {
  requireConfig(value !== null && typeof value === "object" && !Array.isArray(value));
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    requireConfig("value" in descriptor);
    result[name] = descriptor.value;
  }
  return result;
}

function configString(value: unknown, pattern: RegExp): string {
  requireConfig(typeof value === "string");
  const match = pattern.exec(value);
  requireConfig(match !== null && match[0] === value);
  return value;
}

function configInteger(value: unknown, minimum = 0): number {
  requireConfig(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);
  return value;
}

function configNonce(value: unknown): string {
  const nonce = configString(value, /^[A-Za-z0-9_-]{43}$/);
  const decoded = Buffer.from(nonce, "base64url");
  requireConfig(decoded.length === 32 && decoded.toString("base64url") === nonce);
  return nonce;
}

/** Read dense own array slots without invoking an injected iterator or getter. */
function configArray(value: unknown): unknown[] {
  requireConfig(Array.isArray(value));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  const length = configInteger(Object.getOwnPropertyDescriptor(value, "length")?.value);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    requireConfig(descriptor !== undefined && "value" in descriptor);
    result.push(descriptor.value);
  }
  return result;
}

function configScope(value: unknown, pattern: RegExp): string[] {
  const members = configArray(value);
  requireConfig(members.length > 0);
  return members.map((member) => configString(member, pattern));
}

function validateExpectedContext(value: unknown, now: number): GroundingReceiptExpectedContext {
  const raw = configRecord(value);
  const target = configRecord(raw.target);
  const session = configRecord(raw.session);
  const expected: GroundingReceiptExpectedContext = {
    audience: configString(raw.audience, TOKEN),
    projectId: configString(raw.projectId, UUID),
    taskId: configString(raw.taskId, UUID),
    attemptId: configString(raw.attemptId, UUID),
    nonce: configNonce(raw.nonce),
    contextRevision: configInteger(raw.contextRevision, 1),
    target: {
      workflowId: target.workflowId === null ? null : configString(target.workflowId, UUID),
      from: configString(target.from, TOKEN),
      to: configString(target.to, TOKEN),
      action: configString(target.action, TOKEN),
    },
    subjectDigest: configString(raw.subjectDigest, SHA256),
    session: {
      id: configString(session.id, TOKEN),
      revision: configInteger(session.revision, 1)
    },
    attemptCreatedAt: configInteger(raw.attemptCreatedAt),
    attemptExpiresAt: configInteger(raw.attemptExpiresAt),
  };
  requireConfig(expected.attemptCreatedAt - now <= CLOCK_SKEW_SECONDS);
  requireConfig(expected.attemptExpiresAt > expected.attemptCreatedAt);
  requireConfig(expected.attemptExpiresAt - expected.attemptCreatedAt <= MAX_CHALLENGE_SECONDS);
  return expected;
}

function validatePublicKey(value: unknown): crypto.KeyObject {
  // createPublicKey also accepts private PEMs; require an actual public SPKI PEM.
  const pem = configString(value, /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/);
  const key = crypto.createPublicKey(pem);
  requireConfig(key.type === "public" && key.asymmetricKeyType === "ed25519");
  return key;
}

function validateTrust(value: unknown): ValidatedTrustEntry[] {
  const members = configArray(value);
  const entries: ValidatedTrustEntry[] = [];
  const identifiers = new Set<string>();
  for (const member of members) {
    const raw = configRecord(member);
    const entry: ValidatedTrustEntry = {
      issuer: configString(raw.issuer, TOKEN),
      kid: configString(raw.kid, TOKEN),
      profileDigest: configString(raw.profileDigest, SHA256),
      projectIds: configScope(raw.projectIds, UUID),
      audiences: configScope(raw.audiences, TOKEN),
      key: validatePublicKey(raw.publicKeyPem),
    };
    requireConfig(raw.revoked === undefined || typeof raw.revoked === "boolean");
    entry.revoked = raw.revoked;
    const id = `${entry.issuer}\u0000${entry.kid}`;
    if (identifiers.has(id))
      fail("grounding_verification_unavailable");
    identifiers.add(id);
    entries.push(entry);
  }
  return entries;
}

function validateConfig(value: unknown): ValidatedConfig {
  try {
    const raw = configRecord(value);
    const now = configInteger(raw.now);
    const expected = validateExpectedContext(raw.expected, now);
    const trust = validateTrust(raw.trust);
    return {
      now, expected, trust
    };
  } catch {
    // Invalid keys and exceptional runtime objects share the configuration error.
    return fail("grounding_verification_unavailable");
  }
}

function authenticate(envelope: Envelope, trust: ValidatedTrustEntry[]): ValidatedTrustEntry {
  const entry = trust.find((candidate) => candidate.issuer === envelope.issuer && candidate.kid === envelope.kid);
  if (!entry || entry.revoked)
    fail("grounding_receipt_untrusted");
  const signed = Buffer.from(`${FORMAT}\n${ALGORITHM}\n${envelope.issuer}\n${envelope.kid}\n${envelope.payload}`, "utf8");
  let signatureValid: boolean;
  try {
    signatureValid = crypto.verify(null, signed, entry.key, Buffer.from(envelope.signature, "base64url"));
  } catch {
    return fail("grounding_receipt_untrusted");
  }
  if (!signatureValid)
    fail("grounding_receipt_untrusted");
  return entry;
}

function validateTrustScope(p: Payload, entry: ValidatedTrustEntry): void {
  if (!entry.projectIds.includes(p.projectId))
    fail("grounding_receipt_untrusted");
  if (!entry.audiences.includes(p.audience))
    fail("grounding_receipt_untrusted");
  if (entry.profileDigest !== p.policy.sha256)
    fail("grounding_receipt_untrusted");
}

function validateContextBinding(p: Payload, e: GroundingReceiptExpectedContext): void {
  if (p.audience !== e.audience)
    fail("grounding_receipt_mismatch");
  if (p.projectId !== e.projectId)
    fail("grounding_receipt_mismatch");
  if (p.taskId !== e.taskId)
    fail("grounding_receipt_mismatch");
  if (p.attemptId !== e.attemptId)
    fail("grounding_receipt_mismatch");
  if (p.nonce !== e.nonce)
    fail("grounding_receipt_mismatch");
  if (p.contextRevision !== e.contextRevision)
    fail("grounding_receipt_mismatch");
  if (p.subject.digest !== e.subjectDigest)
    fail("grounding_receipt_mismatch");
  if (p.session.id !== e.session.id)
    fail("grounding_receipt_mismatch");
  if (p.session.revision !== e.session.revision)
    fail("grounding_receipt_mismatch");
  if (p.target.workflowId !== e.target.workflowId)
    fail("grounding_receipt_mismatch");
  if (p.target.from !== e.target.from)
    fail("grounding_receipt_mismatch");
  if (p.target.to !== e.target.to)
    fail("grounding_receipt_mismatch");
  if (p.target.action !== e.target.action)
    fail("grounding_receipt_mismatch");
}

function validateFreshness(p: Payload, e: GroundingReceiptExpectedContext, now: number): void {
  if (now >= e.attemptExpiresAt)
    fail("grounding_receipt_stale");
  if (e.attemptCreatedAt - p.issuedAt > CLOCK_SKEW_SECONDS)
    fail("grounding_receipt_stale");
  if (e.attemptCreatedAt - p.evaluatedAt > CLOCK_SKEW_SECONDS)
    fail("grounding_receipt_stale");
  if (p.issuedAt - now > CLOCK_SKEW_SECONDS)
    fail("grounding_receipt_stale");
  if (p.evaluatedAt - now > CLOCK_SKEW_SECONDS)
    fail("grounding_receipt_stale");
  if (p.expiresAt <= now)
    fail("grounding_receipt_stale");
  if (p.expiresAt > e.attemptExpiresAt)
    fail("grounding_receipt_stale");
  // Schema limits receipt lifetime to 900s; config caps the stored challenge at 24h.
}

/** Returns passing evidence only; successful signature verification alone is never exposed. */
export function verifyGroundingReceipt(input: Uint8Array | string, config: GroundingReceiptVerifierConfig): AgentAssertedGroundingEvidence {
  const receipt = decode(input);
  const validated = validateConfig(config);
  const entry = authenticate(receipt.envelope, validated.trust);
  const p = receipt.payload;
  validateTrustScope(p, entry);
  validateContextBinding(p, validated.expected);
  validateFreshness(p, validated.expected, validated.now);
  if (p.assessment.outcome !== "pass")
    fail("grounding_required", "assessment_failed");
  return {
    evidenceOrigin: "agent_asserted",
    receiptId: p.receiptId,
    assessmentDossierSha256: p.assessment.dossierSha256,
    evaluatedAt: p.evaluatedAt,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
  };
}
