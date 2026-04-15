/**
 * GitHub token health probe.
 *
 * Detects the "silent outage" class: a user's OAuth token has expired,
 * been revoked on github.com/settings/applications, or had its owning
 * OAuth app revoked by a org admin. Without this, every downstream
 * GitHub-delegation feature (repo sync, PR create, PR merge, PR
 * comment, the `ciGreen` transition gate) fails with 401 until someone
 * raises their hand.
 *
 * ## Lazy probe
 *
 * The probe is on-demand, not scheduled. The `/api/auth/github/health`
 * endpoint re-probes when the cached state is older than
 * `PROBE_TTL_MS`; otherwise it returns the cached result. This keeps
 * GitHub API traffic proportional to actual interest (an ops dashboard
 * poll, or a user opening Settings) without a cron job that probes
 * every connected user on a fixed interval.
 *
 * ## Classification
 *
 * - `200` from `GET /user` → `healthy`
 * - `401` → `invalid` (revoked / expired / scope downgraded)
 * - `403` without rate-limit markers → `invalid` (OAuth app revoked /
 *   scope downgraded)
 * - `403` with rate-limit markers (`x-ratelimit-remaining: 0`,
 *   `retry-after`, or a body `message` mentioning "rate limit") →
 *   `unknown` (transient, the token itself is fine)
 * - Anything else (network error, 5xx) → `unknown` — we deliberately
 *   do NOT mark the token as invalid, because a transient GitHub outage
 *   would otherwise cause a UI stampede of "reconnect" prompts. The
 *   last healthy state sticks until we get a definitive 200 or 401/403.
 */

import { prisma } from "../lib/prisma.js";

/** How long a definitive probe result (healthy or invalid) is considered fresh. */
const PROBE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Backoff for retrying an `unknown` (transient) probe result. Without this,
 *  a GitHub 5xx outage would cause every Settings visit to re-probe, fanning
 *  the load out instead of backing off. */
const UNKNOWN_RETRY_FLOOR_MS = 60 * 1000; // 60 seconds

export type HealthState = "healthy" | "invalid" | "unknown" | "not_connected";

export interface HealthResult {
  state: HealthState;
  lastCheckedAt: Date | null;
  /** GitHub login if known (from the probe response). Only populated
   *  for `healthy` — we don't store it separately here because it's
   *  already available on the User row when the token was first set.
   *  Reserved for future use. */
  login?: string;
}

/**
 * Minimal header lookup shape. `fetch`'s `Headers` satisfies this, and
 * tests can pass a plain record — lowercase keys — without constructing
 * a Headers instance.
 */
export type ProbeHeaders = Pick<Headers, "get"> | Record<string, string> | null;

function readHeader(headers: ProbeHeaders, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

/**
 * Classify a GitHub `GET /user` probe. Exposed for testability.
 *
 * - `200` → healthy
 * - `401` → invalid (revoked / expired)
 * - `403` with rate-limit markers → unknown (transient, user's token is fine)
 * - `403` otherwise → invalid (genuine OAuth app revocation / scope downgrade)
 * - `fetchError: true` or any 5xx → unknown (don't flip healthy→invalid
 *   on a transient blip)
 * - Any other 4xx → unknown (conservative: don't flap the UI on
 *   GitHub quirks we haven't seen before)
 *
 * `headers` and `body` are optional so existing callers and tests keep
 * working. When the caller has them, a 403 can be disambiguated between
 * rate-limit (transient) and genuine revocation (invalid).
 */
export function classifyProbeResponse(
  status: number | null,
  fetchError: boolean,
  headers: ProbeHeaders = null,
  body: { message?: string } | null = null,
): "healthy" | "invalid" | "unknown" {
  if (fetchError || status === null) return "unknown";
  if (status === 200) return "healthy";
  if (status === 401) return "invalid";
  if (status === 403) {
    const remaining = readHeader(headers, "x-ratelimit-remaining");
    if (remaining === "0") return "unknown";
    if (readHeader(headers, "retry-after") !== null) return "unknown";
    if (body?.message && /rate limit/i.test(body.message)) return "unknown";
    return "invalid";
  }
  return "unknown";
}

/** Check GitHub with a stored token. Returns a classified state. */
async function probeToken(token: string): Promise<"healthy" | "invalid" | "unknown"> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    // Only parse the body on 403 — a rate-limit response is small and
    // JSON; the happy path is 200 and we skip the parse cost entirely.
    let body: { message?: string } | null = null;
    if (res.status === 403) {
      try {
        body = (await res.json()) as { message?: string };
      } catch {
        body = null;
      }
    }
    return classifyProbeResponse(res.status, false, res.headers, body);
  } catch {
    return classifyProbeResponse(null, true);
  }
}

/**
 * Get the current health state for a user. Re-probes GitHub when the
 * stored state is older than the TTL; otherwise returns the cached
 * result unchanged.
 *
 * When a probe produces `unknown` (transient error), the stored
 * `githubTokenHealthy` is NOT updated — we keep the last definitive
 * answer until GitHub gives us a clear 200 or 401/403. Only
 * `lastCheckedAt` is bumped so the caller can see we tried.
 */
export async function getTokenHealth(userId: string): Promise<HealthResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      githubAccessToken: true,
      githubConnectedAt: true,
      githubTokenHealthy: true,
      githubTokenLastCheckedAt: true,
    },
  });
  if (!user || !user.githubAccessToken || !user.githubConnectedAt) {
    return { state: "not_connected", lastCheckedAt: null };
  }

  const now = Date.now();
  const last = user.githubTokenLastCheckedAt?.getTime() ?? 0;
  const sinceLast = now - last;
  const isFresh = sinceLast < PROBE_TTL_MS;

  // Fast path: a definitive answer (healthy or invalid) within the TTL.
  if (isFresh && user.githubTokenHealthy !== null) {
    return {
      state: user.githubTokenHealthy ? "healthy" : "invalid",
      lastCheckedAt: user.githubTokenLastCheckedAt,
    };
  }

  // Backoff path: the last probe was `unknown` (timestamp set but
  // `healthy` still null). Re-probing on every call would amplify a
  // GitHub outage outward — respect a 60s floor before retrying.
  if (
    user.githubTokenHealthy === null &&
    user.githubTokenLastCheckedAt &&
    sinceLast < UNKNOWN_RETRY_FLOOR_MS
  ) {
    return { state: "unknown", lastCheckedAt: user.githubTokenLastCheckedAt };
  }

  // Probe needed — stale, never checked, or past the unknown-retry floor.
  const result = await probeToken(user.githubAccessToken);
  const checkedAt = new Date();

  if (result === "unknown") {
    // Don't flip the stored healthy flag on a transient error. Bump
    // the timestamp so the caller knows we tried, and return the
    // previous definitive answer if we have one, else "unknown".
    await prisma.user.update({
      where: { id: userId },
      data: { githubTokenLastCheckedAt: checkedAt },
    });
    const preserved: HealthState =
      user.githubTokenHealthy === true
        ? "healthy"
        : user.githubTokenHealthy === false
          ? "invalid"
          : "unknown";
    return { state: preserved, lastCheckedAt: checkedAt };
  }

  const healthy = result === "healthy";
  await prisma.user.update({
    where: { id: userId },
    data: {
      githubTokenLastCheckedAt: checkedAt,
      githubTokenHealthy: healthy,
    },
  });
  return {
    state: healthy ? "healthy" : "invalid",
    lastCheckedAt: checkedAt,
  };
}

/**
 * Count users whose token is known-invalid. For the ops dashboard.
 * Users who have never been probed are NOT counted as invalid.
 */
export async function countInvalidTokenUsers(): Promise<number> {
  return prisma.user.count({
    where: {
      githubAccessToken: { not: null },
      githubConnectedAt: { not: null },
      githubTokenHealthy: false,
    },
  });
}
