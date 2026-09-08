import { createPublicKey } from "node:crypto";
import { z } from "zod";
import type { GroundingAttemptsConfig } from "./grounding-attempts.js";
import { GROUNDING_POLICY, unavailable } from "./grounding-context.js";
const token = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const trustSchema = z.array(z.object({
  issuer: token, kid: token, publicKeyPem: z.string().regex(/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/),
  profileDigest: z.string().regex(/^[0-9a-f]{64}$/), projectIds: z.array(uuid).min(1), audiences: z.array(token).min(1), revoked: z.boolean().optional(),
}).strict());
export function groundingSettings(config: GroundingAttemptsConfig, projectId: string) {
  try {
    const audience = token.parse(config.audience);
    const seconds = z.number().int().positive().max(86400).parse(config.challengeSeconds ?? 900);
    const trust = trustSchema.parse(config.trust());
    const seen = new Set<string>();
    for (const entry of trust) {
      const id = `${entry.issuer}\u0000${entry.kid}`;
      if (seen.has(id)) unavailable();
      seen.add(id);
      const key = createPublicKey(entry.publicKeyPem);
      if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") unavailable();
    }
    if (!trust.some(t => !t.revoked && t.projectIds.includes(projectId) && t.audiences.includes(audience) && t.profileDigest === GROUNDING_POLICY.sha256)) unavailable();
    return { audience, seconds, trust };
  } catch { return unavailable(); }
}
export function groundingTime(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000 - 86400) unavailable();
  return now;
}
