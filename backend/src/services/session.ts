/**
 * Session management
 *
 * Simple JWT-based sessions for Wave 2.
 * Stores userId + githubAccessToken in a signed JWT cookie.
 */

export interface SessionPayload {
  userId: string;
  githubAccessToken: string;
  iat: number;
  exp: number;
}

const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** Encode a session payload as a simple base64url signed token (HMAC-SHA256) */
export async function createSessionToken(
  userId: string,
  githubAccessToken: string,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    userId,
    githubAccessToken,
    iat: now,
    exp: now + SESSION_DURATION_SECONDS,
  };

  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = await sign(`${header}.${body}`, secret);

  return `${header}.${body}.${signature}`;
}

/** Verify and decode a session token */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts as [string, string, string];
  const expectedSig = await sign(`${header}.${body}`, secret);

  if (!timingSafeEqual(signature, expectedSig)) return null;

  try {
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Extract session from cookie header */
export function extractSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Build a Set-Cookie header value for the session */
export function buildSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DURATION_SECONDS}`,
    "Path=/",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build a cookie that clears the session */
export function buildClearSessionCookie(): string {
  return "session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64url(String.fromCharCode(...new Uint8Array(sig)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
