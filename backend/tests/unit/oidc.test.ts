/**
 * Unit tests for services/oidc.ts
 *
 * Covers: verifyIdToken (ES256 + all validation paths), discover (cache,
 * invalidation, error cases), buildAuthorizeUrl, generatePkcePair,
 * exchangeCode, and randomToken. No DB, no real network — fetch is stubbed
 * via save/restore idiom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webcrypto } from "node:crypto";

import {
  discover,
  invalidateDiscovery,
  buildAuthorizeUrl,
  generatePkcePair,
  exchangeCode,
  verifyIdToken,
  randomToken,
  type OidcDiscovery,
} from "../../src/services/oidc.js";

// ── ES256 test-token helper ───────────────────────────────────────────────────

const b64url = (b: Uint8Array | Buffer): string =>
  Buffer.from(b).toString("base64url");

async function makeEs256(): Promise<{
  publicJwk: any;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}> {
  const { publicKey, privateKey } = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const jwk = (await webcrypto.subtle.exportKey("jwk", publicKey)) as any;
  const publicJwk = { ...jwk, kid: "test-kid", alg: "ES256", use: "sig" };

  async function sign(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ): Promise<string> {
    const h = b64url(
      Buffer.from(JSON.stringify({ alg: "ES256", kid: "test-kid", ...header })),
    );
    const p = b64url(Buffer.from(JSON.stringify(claims)));
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      data,
    );
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  }

  return { publicJwk, sign };
}

// RS256 is the dominant enterprise IdP alg (Azure AD, Okta, Google), so the
// RSA branch of importJwk/verifyAlgParams/jwkMatchesAlg needs end-to-end cover.
async function makeRs256(): Promise<{
  publicJwk: any;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}> {
  const { publicKey, privateKey } = (await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const jwk = (await webcrypto.subtle.exportKey("jwk", publicKey)) as any;
  const publicJwk = { ...jwk, kid: "rsa-kid", alg: "RS256", use: "sig" };

  async function sign(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ): Promise<string> {
    const h = b64url(
      Buffer.from(JSON.stringify({ alg: "RS256", kid: "rsa-kid", ...header })),
    );
    const p = b64url(Buffer.from(JSON.stringify(claims)));
    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = await webcrypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, data);
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  }

  return { publicJwk, sign };
}

// ── Shared claim factory ──────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://idp.example.com",
    sub: "user-123",
    aud: "client-id",
    exp: now + 3600,
    iat: now,
    nonce: "test-nonce",
    email: "user@example.com",
    ...overrides,
  };
}

const EXPECTED_ISSUER = "https://idp.example.com";
const EXPECTED_AUDIENCE = "client-id";
const EXPECTED_NONCE = "test-nonce";

// ── Fetch stub (save / restore) ───────────────────────────────────────────────

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── verifyIdToken ─────────────────────────────────────────────────────────────

describe("verifyIdToken", () => {
  let pair: Awaited<ReturnType<typeof makeEs256>>;

  beforeEach(async () => {
    pair = await makeEs256();
  });

  it("verifies a valid ES256 token and returns the claims", async () => {
    const claims = validClaims();
    const token = await pair.sign(claims);
    const result = await verifyIdToken({
      idToken: token,
      jwks: [pair.publicJwk],
      expectedIssuer: EXPECTED_ISSUER,
      expectedAudience: EXPECTED_AUDIENCE,
      expectedNonce: EXPECTED_NONCE,
    });
    expect(result.sub).toBe("user-123");
    expect(result.email).toBe("user@example.com");
  });

  it("verifies a valid RS256 token (the dominant enterprise alg) and returns the claims", async () => {
    const rsa = await makeRs256();
    const token = await rsa.sign(validClaims());
    const result = await verifyIdToken({
      idToken: token,
      jwks: [rsa.publicJwk],
      expectedIssuer: EXPECTED_ISSUER,
      expectedAudience: EXPECTED_AUDIENCE,
      expectedNonce: EXPECTED_NONCE,
    });
    expect(result.sub).toBe("user-123");
  });

  it("rejects a tampered RS256 signature with /signature verification failed/", async () => {
    const rsa = await makeRs256();
    const token = await rsa.sign(validClaims());
    const parts = token.split(".");
    const sig = Buffer.from(parts[2]!, "base64url");
    sig[0] = sig[0]! ^ 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${b64url(sig)}`;
    await expect(
      verifyIdToken({
        idToken: tampered,
        jwks: [rsa.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects a token whose exp is missing/non-numeric with /expired/", async () => {
    const { exp: _exp, ...noExp } = validClaims();
    const token = await pair.sign(noExp);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("accepts aud as an array that contains the expected audience", async () => {
    const claims = validClaims({ aud: ["other-client", "client-id"] });
    const token = await pair.sign(claims);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a 2-part (malformed) token with /Malformed/", async () => {
    await expect(
      verifyIdToken({
        idToken: "header.payload",
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/Malformed/);
  });

  it("rejects alg=HS256 in header with /Unsupported ID token alg/", async () => {
    // The sign helper spreads header last, so { alg: "HS256" } overrides "ES256".
    // verifyIdToken checks alg before ever touching the signature.
    const claims = validClaims();
    const token = await pair.sign(claims, { alg: "HS256" });
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/Unsupported ID token alg/);
  });

  it("rejects when jwks is empty with /No matching JWK/", async () => {
    const token = await pair.sign(validClaims());
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/No matching JWK/);
  });

  it("rejects when header kid does not match any JWK with /No matching JWK/", async () => {
    const claims = validClaims();
    // Spread overrides kid from "test-kid" to "other-kid" in the JWT header.
    const token = await pair.sign(claims, { kid: "other-kid" });
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk], // has kid="test-kid"
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/No matching JWK/);
  });

  it("rejects a tampered signature (first byte of sig flipped) with /signature verification failed/", async () => {
    const token = await pair.sign(validClaims());
    const parts = token.split(".");
    // Decode the signature bytes, flip a real data byte, then re-encode.
    // (Mutating only the last base64url char is unreliable because for a 64-byte
    // ES256 sig the last char encodes only padding bits; they are ignored on decode.)
    const sigBytes = Buffer.from(parts[2]!, "base64url");
    sigBytes[0] = sigBytes[0]! ^ 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${sigBytes.toString("base64url")}`;
    await expect(
      verifyIdToken({
        idToken: tampered,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects a tampered payload (re-encoded claims with original signature) with /signature verification failed/", async () => {
    const claims = validClaims();
    const token = await pair.sign(claims);
    const parts = token.split(".");
    // Replace the payload with modified claims while keeping the old header and sig.
    const tamperedClaims = { ...claims, sub: "hacker" };
    const tamperedPayload = b64url(Buffer.from(JSON.stringify(tamperedClaims)));
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    await expect(
      verifyIdToken({
        idToken: tampered,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it("rejects issuer mismatch with /issuer mismatch/", async () => {
    const claims = validClaims({ iss: "https://evil.example.com" });
    const token = await pair.sign(claims);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/issuer mismatch/);
  });

  it("rejects audience mismatch with /audience mismatch/", async () => {
    const claims = validClaims({ aud: "wrong-client" });
    const token = await pair.sign(claims);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/audience mismatch/);
  });

  it("rejects an expired token (exp in the past) with /expired/", async () => {
    const claims = validClaims({ exp: now - 3600 });
    const token = await pair.sign(claims);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a token issued in the future (iat ahead) with /issued in the future/", async () => {
    const claims = validClaims({ iat: now + 3600 });
    const token = await pair.sign(claims);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/issued in the future/);
  });

  it("rejects nonce mismatch with /nonce mismatch/", async () => {
    const claims = validClaims({ nonce: "wrong-nonce" });
    const token = await pair.sign(claims);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/nonce mismatch/);
  });

  it("rejects a token with no nonce field with /nonce mismatch/", async () => {
    // Destructure out the nonce so the claim object has no nonce key.
    const { nonce: _nonce, ...claimsWithoutNonce } = validClaims();
    const token = await pair.sign(claimsWithoutNonce);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/nonce mismatch/);
  });

  it("clock-skew: exp=now-30 with default 60s skew still passes", async () => {
    // exp + 60 >= now when exp = now - 30, so verification should succeed.
    const claims = validClaims({ exp: now - 30 });
    const token = await pair.sign(claims);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
        // default clockSkewSeconds = 60
      }),
    ).resolves.toBeDefined();
  });

  it("clock-skew: exp=now-61 with default 60s skew rejects (boundary beyond tolerance)", async () => {
    const claims = validClaims({ exp: now - 61 });
    const token = await pair.sign(claims);
    await expect(
      verifyIdToken({
        idToken: token,
        jwks: [pair.publicJwk],
        expectedIssuer: EXPECTED_ISSUER,
        expectedAudience: EXPECTED_AUDIENCE,
        expectedNonce: EXPECTED_NONCE,
      }),
    ).rejects.toThrow(/expired/);
  });
});

// ── discover ──────────────────────────────────────────────────────────────────

function makeDiscoveryDoc(issuer: string): OidcDiscovery {
  return {
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  };
}

function makeDiscoveryFetch(issuer: string, extraKeys: unknown[] = []): ReturnType<typeof vi.fn> {
  return vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => makeDiscoveryDoc(issuer),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: extraKeys }),
    });
}

describe("discover", () => {
  it("fetches .well-known/openid-configuration then jwks_uri and returns both", async () => {
    const issuer = "https://issuer-discover-success.example.com";
    const fetchMock = makeDiscoveryFetch(issuer);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await discover(issuer);

    expect(result.discovery.issuer).toBe(issuer);
    expect(result.discovery.token_endpoint).toBe(`${issuer}/token`);
    expect(result.jwks).toEqual([]);
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${issuer}/.well-known/openid-configuration`);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${issuer}/jwks`);
  });

  it("caches the result so a second call with the same issuer does NOT re-fetch", async () => {
    const issuer = "https://issuer-discover-cache.example.com";
    const fetchMock = makeDiscoveryFetch(issuer);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await discover(issuer);
    const callsAfterFirst = fetchMock.mock.calls.length;

    await discover(issuer);
    // Cache hit: no additional fetch calls.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("invalidateDiscovery forces a re-fetch on the next call", async () => {
    const issuer = "https://issuer-discover-invalidate.example.com";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => makeDiscoveryDoc(issuer) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => makeDiscoveryDoc(issuer) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [] }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await discover(issuer);
    expect(fetchMock.mock.calls.length).toBe(2);

    invalidateDiscovery(issuer);
    await discover(issuer);
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  it("throws /issuer mismatch/ when the doc issuer does not match the requested issuer", async () => {
    const issuer = "https://issuer-discover-mismatch.example.com";
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ...makeDiscoveryDoc(issuer), issuer: "https://different.example.com" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(discover(issuer)).rejects.toThrow(/issuer mismatch/);
  });

  it("throws /discovery failed/ when the discovery response is not ok", async () => {
    const issuer = "https://issuer-discover-fail.example.com";
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch;

    await expect(discover(issuer)).rejects.toThrow(/discovery failed/);
  });

  it("throws /JWKS fetch failed/ when the JWKS response is not ok", async () => {
    const issuer = "https://issuer-jwks-fail.example.com";
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => makeDiscoveryDoc(issuer) })
      .mockResolvedValueOnce({ ok: false, status: 500 }) as unknown as typeof fetch;

    await expect(discover(issuer)).rejects.toThrow(/JWKS fetch failed/);
  });
});

// ── buildAuthorizeUrl ─────────────────────────────────────────────────────────

describe("buildAuthorizeUrl", () => {
  const discovery: OidcDiscovery = {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://idp.example.com/auth",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
  };

  it("produces a URL with all required PKCE + OIDC parameters", () => {
    const url = buildAuthorizeUrl({
      discovery,
      clientId: "my-client",
      redirectUri: "https://app.example.com/callback",
      state: "my-state",
      nonce: "my-nonce",
      codeChallenge: "my-challenge",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("my-client");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(parsed.searchParams.get("scope")).toBe("openid email profile");
    expect(parsed.searchParams.get("state")).toBe("my-state");
    expect(parsed.searchParams.get("nonce")).toBe("my-nonce");
    expect(parsed.searchParams.get("code_challenge")).toBe("my-challenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("uses the provided scope when specified (overrides default)", () => {
    const url = buildAuthorizeUrl({
      discovery,
      clientId: "c",
      redirectUri: "https://app.example.com/cb",
      state: "s",
      nonce: "n",
      codeChallenge: "ch",
      scope: "openid profile",
    });
    expect(new URL(url).searchParams.get("scope")).toBe("openid profile");
  });
});

// ── generatePkcePair ──────────────────────────────────────────────────────────

describe("generatePkcePair", () => {
  it("challenge equals base64url(SHA-256(verifier)) computed independently", async () => {
    const { verifier, challenge } = await generatePkcePair();
    const digest = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const expected = Buffer.from(new Uint8Array(digest)).toString("base64url");
    expect(challenge).toBe(expected);
  });

  it("verifier is base64url-encoded (no +, /, or = characters)", async () => {
    const { verifier } = await generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("two consecutive pairs differ", async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

// ── exchangeCode ──────────────────────────────────────────────────────────────

describe("exchangeCode", () => {
  const discovery: OidcDiscovery = {
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://idp.example.com/auth",
    token_endpoint: "https://idp.example.com/token",
    jwks_uri: "https://idp.example.com/jwks",
  };
  const baseParams = {
    discovery,
    clientId: "client-id",
    clientSecret: "secret",
    code: "auth-code",
    redirectUri: "https://app.example.com/callback",
    codeVerifier: "pkce-verifier",
  };

  it("POSTs to token_endpoint and returns token response containing id_token", async () => {
    const tokens = { access_token: "acc", id_token: "idtok", token_type: "Bearer" };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => tokens,
    });

    const result = await exchangeCode(baseParams);

    expect(result.id_token).toBe("idtok");
    expect(result.access_token).toBe("acc");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://idp.example.com/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("throws /token exchange failed with status/ when response is not ok", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    await expect(exchangeCode(baseParams)).rejects.toThrow(/token exchange failed with status/);
  });

  it("throws /token error/ when body contains an error field", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: "invalid_grant", error_description: "Code expired" }),
    });
    await expect(exchangeCode(baseParams)).rejects.toThrow(/token error/);
  });

  it("throws /missing id_token/ when body lacks id_token", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "acc", token_type: "Bearer" }),
    });
    await expect(exchangeCode(baseParams)).rejects.toThrow(/missing id_token/);
  });
});

// ── randomToken ───────────────────────────────────────────────────────────────

describe("randomToken", () => {
  it("returns a lowercase hex string of length 2*n (default n=16 → 32 chars)", () => {
    expect(randomToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns a hex string of length 2*n for a custom n", () => {
    expect(randomToken(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomToken(24)).toMatch(/^[0-9a-f]{48}$/);
  });

  it("two consecutive calls return different values", () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});
