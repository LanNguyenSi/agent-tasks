import { createPublicKey } from "node:crypto";
import { z } from "zod";

const token = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
export const groundingChallengeSeconds = z.number().int().positive().max(86400);
export const groundingAudience = token;
const unique = (values: string[]) => new Set(values).size === values.length;
const trustSchema = z.array(z.object({
  issuer: token,
  kid: token,
  publicKeyPem: z.string().max(1024).regex(/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/),
  profileDigest: z.string().regex(/^[0-9a-f]{64}$/),
  projectIds: z.array(uuid).min(1).max(256).refine(unique),
  audiences: z.array(token).min(1).max(64).refine(unique),
  revoked: z.boolean().optional(),
}).strict()).max(64);

/** Shared validation also runs at every attempt issue/ingest and completion. */
export function validateGroundingTrust(input: unknown) {
  const trust = trustSchema.parse(input);
  const seen = new Set<string>();
  for (const entry of trust) {
    const id = `${entry.issuer}\u0000${entry.kid}`;
    if (seen.has(id)) throw new Error("Duplicate grounding trust identity");
    seen.add(id);
    const key = createPublicKey(entry.publicKeyPem);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("Invalid grounding public key");
  }
  return trust;
}

const schema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true), audience: token,
    challengeSeconds: groundingChallengeSeconds.default(900), trust: trustSchema,
    creationPolicy: z.array(z.object({ projectId: uuid, subjectMode: z.enum(["TASK_SPEC", "CODE_HEAD"]) }).strict()).max(256)
      .refine(entries => unique(entries.map(entry => entry.projectId))),
  }).strict(),
]);
export type GroundingRuntimeConfig = z.infer<typeof schema>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// JSON.parse discards duplicate keys. Inspect the valid JSON tokens before using
// its value, including escaped spellings of the same key in nested objects.
function rejectDuplicateKeys(raw: string) {
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      if (stack.length > 16) throw new Error("Grounding configuration nesting exceeded");
    } else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ":") {
      const keys = stack.at(-1)!;
      const key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw new Error("Duplicate grounding configuration key");
      keys.add(key);
    }
  }
}

/** Environment input only. Errors never echo config values or cryptographic material. */
export function parseGroundingRuntimeConfig(raw: string | undefined): GroundingRuntimeConfig {
  try {
    if (raw === undefined || raw === "") return freeze({ enabled: false });
    if (Buffer.byteLength(raw, "utf8") > 65536) throw new Error("Grounding configuration too large");
    const value: unknown = JSON.parse(raw);
    rejectDuplicateKeys(raw);
    const result = schema.parse(value);
    if (result.enabled) validateGroundingTrust(result.trust);
    return freeze(result);
  } catch { throw new Error("Invalid GROUNDING_RUNTIME_CONFIG"); }
}
