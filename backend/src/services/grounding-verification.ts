import { groundingAudience, groundingChallengeSeconds, validateGroundingTrust } from "../config/grounding-runtime.js";
import type { GroundingAttemptsConfig } from "./grounding-attempts.js";
import { GROUNDING_POLICY, unavailable } from "./grounding-context.js";
export function groundingSettings(config: GroundingAttemptsConfig, projectId: string) {
  try {
    const audience = groundingAudience.parse(config.audience);
    const seconds = groundingChallengeSeconds.parse(config.challengeSeconds ?? 900);
    const trust = validateGroundingTrust(config.trust());
    if (!trust.some(t => !t.revoked && t.projectIds.includes(projectId) && t.audiences.includes(audience) && t.profileDigest === GROUNDING_POLICY.sha256)) unavailable();
    return { audience, seconds, trust };
  } catch { return unavailable(); }
}
export function groundingTime(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000 - 86400) unavailable();
  return now;
}
