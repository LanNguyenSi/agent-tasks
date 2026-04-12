/**
 * Minimal OIDC Authorization Code client.
 *
 * Intentionally dependency-free: uses node:crypto (WebCrypto) for JWKS-based
 * ID token verification. Supports RS256 and ES256, which covers virtually
 * every enterprise IdP (Azure AD, Okta, Google Workspace, Auth0, Keycloak).
 *
 * Flow used by the routes layer:
 *   1. discover(issuer) — fetch & cache the OpenID configuration
 *   2. buildAuthorizeUrl(...) — redirect the user here
 *   3. exchangeCode(...) — back-channel token exchange
 *   4. verifyIdToken(...) — validate signature, issuer, audience, nonce, exp
 */

import { webcrypto } from "node:crypto";

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

export interface OidcTokens {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OidcIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  picture?: string;
  hd?: string;
  [key: string]: unknown;
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface DiscoveryCacheEntry {
  discovery: OidcDiscovery;
  jwks: Jwk[];
  fetchedAt: number;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

/** Fetch and cache `.well-known/openid-configuration` + JWKS. */
export async function discover(issuer: string): Promise<{ discovery: OidcDiscovery; jwks: Jwk[] }> {
  const key = normalizeIssuer(issuer);
  const cached = discoveryCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return { discovery: cached.discovery, jwks: cached.jwks };
  }

  const wellKnown = `${key}/.well-known/openid-configuration`;
  const discoveryRes = await fetch(wellKnown);
  if (!discoveryRes.ok) {
    throw new Error(`OIDC discovery failed (${discoveryRes.status}) for ${wellKnown}`);
  }
  const discovery = (await discoveryRes.json()) as OidcDiscovery;

  // Issuer in the document MUST match (RFC 8414 §3.3). We normalize trailing slashes.
  if (normalizeIssuer(discovery.issuer) !== key) {
    throw new Error(`OIDC issuer mismatch: expected ${key}, got ${discovery.issuer}`);
  }

  const jwksRes = await fetch(discovery.jwks_uri);
  if (!jwksRes.ok) {
    throw new Error(`JWKS fetch failed (${jwksRes.status})`);
  }
  const jwksBody = (await jwksRes.json()) as { keys: Jwk[] };

  const entry: DiscoveryCacheEntry = {
    discovery,
    jwks: jwksBody.keys ?? [],
    fetchedAt: Date.now(),
  };
  discoveryCache.set(key, entry);
  return { discovery: entry.discovery, jwks: entry.jwks };
}

/** Invalidate discovery cache (used by team admin after updating SSO config). */
export function invalidateDiscovery(issuer: string): void {
  discoveryCache.delete(normalizeIssuer(issuer));
}

export interface AuthorizeUrlParams {
  discovery: OidcDiscovery;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope?: string;
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope ?? "openid email profile",
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${params.discovery.authorization_endpoint}?${qs.toString()}`;
}

/** Generate a PKCE verifier + S256 challenge pair. */
export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const verifier = Buffer.from(verifierBytes).toString("base64url");
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(new Uint8Array(digest)).toString("base64url");
  return { verifier, challenge };
}

export interface ExchangeCodeParams {
  discovery: OidcDiscovery;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export async function exchangeCode(params: ExchangeCodeParams): Promise<OidcTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });

  const res = await fetch(params.discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    // Body may contain sensitive IdP-provided data; don't include it in the
    // thrown error message so it can't end up in logs or error pages.
    await res.text().catch(() => "");
    throw new Error(`OIDC token exchange failed with status ${res.status}`);
  }

  const json = (await res.json()) as OidcTokens & { error?: string };
  if (json.error) {
    throw new Error(`OIDC token error: ${json.error}`);
  }
  if (!json.id_token) {
    throw new Error("OIDC token response missing id_token");
  }
  return json;
}

// ── ID token verification ────────────────────────────────────────────────────

function base64urlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function base64urlDecodeToString(input: string): string {
  return new TextDecoder().decode(base64urlDecode(input));
}

function jwkMatchesAlg(jwk: Jwk, alg: string): boolean {
  // Refuse encryption-only keys outright.
  if (jwk.use && jwk.use !== "sig") return false;
  // kty must align with the declared alg.
  if (alg === "RS256" && jwk.kty !== "RSA") return false;
  if (alg === "ES256" && (jwk.kty !== "EC" || (jwk.crv && jwk.crv !== "P-256"))) return false;
  // If the JWK advertises its own alg, it must match.
  if (jwk.alg && jwk.alg !== alg) return false;
  return true;
}

function findJwk(jwks: Jwk[], kid: string | undefined, alg: string): Jwk | undefined {
  // Prefer exact kid match — this is the normal case for every real IdP.
  if (kid) {
    const byKid = jwks.find((k) => k.kid === kid && jwkMatchesAlg(k, alg));
    if (byKid) return byKid;
    // kid was specified but didn't match any signing key — refuse to fall back,
    // otherwise we risk key-confusion across rotations.
    return undefined;
  }
  // No kid in the header: only allow the single-key JWKS case, and only if
  // that key is compatible with the declared alg.
  const eligible = jwks.filter((k) => jwkMatchesAlg(k, alg));
  if (eligible.length === 1) return eligible[0];
  return undefined;
}

async function importJwk(jwk: Jwk, alg: string): Promise<CryptoKey> {
  if (jwk.kty === "RSA" && alg === "RS256") {
    return webcrypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  if (jwk.kty === "EC" && alg === "ES256") {
    return webcrypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  }
  throw new Error(`Unsupported JWK/alg combination: kty=${jwk.kty} alg=${alg}`);
}

function verifyAlgParams(alg: string): AlgorithmIdentifier | EcdsaParams {
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5" };
  if (alg === "ES256") return { name: "ECDSA", hash: "SHA-256" } as EcdsaParams;
  throw new Error(`Unsupported JWT alg: ${alg}`);
}

export interface VerifyIdTokenParams {
  idToken: string;
  jwks: Jwk[];
  expectedIssuer: string;
  expectedAudience: string;
  expectedNonce: string;
  clockSkewSeconds?: number;
}

/**
 * Verify an OIDC ID token end-to-end:
 * - signature against JWKS (RS256/ES256)
 * - iss matches the configured issuer
 * - aud contains the configured client_id
 * - exp is in the future (with small skew allowance)
 * - nonce matches the value we stored pre-redirect (replay protection)
 */
export async function verifyIdToken(params: VerifyIdTokenParams): Promise<OidcIdTokenClaims> {
  const skew = params.clockSkewSeconds ?? 60;
  const parts = params.idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed ID token");
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const header = JSON.parse(base64urlDecodeToString(headerB64)) as { alg: string; kid?: string };
  const claims = JSON.parse(base64urlDecodeToString(payloadB64)) as OidcIdTokenClaims;

  if (header.alg !== "RS256" && header.alg !== "ES256") {
    throw new Error(`Unsupported ID token alg: ${header.alg}`);
  }

  const jwk = findJwk(params.jwks, header.kid, header.alg);
  if (!jwk) {
    throw new Error("No matching JWK for ID token");
  }
  const key = await importJwk(jwk, header.alg);

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlDecode(sigB64);
  const ok = await webcrypto.subtle.verify(
    verifyAlgParams(header.alg) as Parameters<SubtleCrypto["verify"]>[0],
    key,
    signature,
    signingInput,
  );
  if (!ok) {
    throw new Error("ID token signature verification failed");
  }

  if (normalizeIssuer(claims.iss) !== normalizeIssuer(params.expectedIssuer)) {
    throw new Error(`ID token issuer mismatch: ${claims.iss}`);
  }

  const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audList.includes(params.expectedAudience)) {
    throw new Error("ID token audience mismatch");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + skew < now) {
    throw new Error("ID token expired");
  }
  if (typeof claims.iat === "number" && claims.iat - skew > now) {
    throw new Error("ID token issued in the future");
  }

  if (!claims.nonce || claims.nonce !== params.expectedNonce) {
    throw new Error("ID token nonce mismatch");
  }

  return claims;
}

/** Cryptographically random hex string for state/nonce. */
export function randomToken(bytes = 16): string {
  return Array.from(webcrypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
