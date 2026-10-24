/**
 * Pins the zod 4 format choices on the repo's OWN schemas and helpers, so an
 * accidental switch to a stricter/simpler v4 default fails here rather than
 * silently narrowing or widening a request field's accept-set. Every case goes
 * through a real schema (createTaskSchema, updateTaskSchema, createTokenSchema,
 * directPatchSchema, the grounding route-effects patch schema through
 * readGroundingRoutePlan, httpUrl) or a real route (POST /register), never a
 * bare z.<format>() built inline, which would test the zod library instead of
 * this repo. Each case pins one input, so reverting a format choice to a v4
 * default fails exactly the cases whose accept-set or output that choice
 * decides (for datetime the accepted minute-precision form; for URL the
 * whitespace-bearing forms that must survive unchanged).
 *
 * datetime (isoDatetime in lib/zod-formats.ts = z.union of z.iso.datetime()
 * and z.iso.datetime({ precision: -1 }), with the union `error` set to
 * "Invalid datetime"): the zod 3 `.datetime()` accept-set, minutes OR seconds
 * with any fractional precision, Z only; offsets, local times, date-only and
 * T24 are rejected; accepted values pass through unchanged. A rejected value
 * reports code `invalid_union` with message `Invalid datetime` (zod 3 reported
 * a single `invalid_string`/`Invalid datetime` for a bad string, and
 * `invalid_type` for a non-string).
 *
 * URL (urlString in lib/zod-formats.ts = z.string().refine(URL.canParse)):
 * the zod 3 `.url()` accept-set AND output. The base (zod 3) checked only that
 * `new URL(value)` does not throw and returned the value UNCHANGED. Because
 * the WHATWG URL parser itself strips leading/trailing whitespace and tab/
 * CR/LF characters before deciding validity, the base accepted
 * " http://x.io", "h\nttps://evil.com" and "http://exa\tmple.com" (measured
 * base semantics: URL.canParse agrees with `new URL` exactly); it returned
 * each of them unchanged. httpUrl additionally runs its http(s) scheme refine
 * on the unchanged value, so the leading-space and newline-spoofed forms
 * still 400 on the scheme and only the tab-inside-host form is accepted,
 * unchanged, exactly as the base did.
 *
 * guid (z.guid() in routes' uuid() helpers): keeps the zod 3 `.uuid()`
 * accept-set (any 8-4-4-4-12 hex, no RFC 9562 version/variant enforcement);
 * pinned through createTokenSchema/createTaskSchema below.
 *
 * email (z.email() in routes/auth.ts): pinned through the real
 * POST /api/auth/register route; an invalid email 400s before the handler.
 */
import { describe, expect, it, vi } from "vitest";

// routes/auth.ts pulls in config (which process.exit()s on an unset
// SESSION_SECRET) and the auth services at module load; stub them the same
// way tests/register-from-project-pilot.test.ts does, so the registerSchema
// cases below reach the REAL zValidate + registerSchema without a DB.
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("../../src/services/github-oauth.js", () => ({
  fetchGitHubUser: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeForToken: vi.fn(),
  generateState: vi.fn(),
}));
vi.mock("../../src/services/github-health.js", () => ({
  getTokenHealth: vi.fn(),
}));
vi.mock("../../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-must-be-32chars!!",
    GITHUB_CLIENT_ID: "test-id",
    GITHUB_CLIENT_SECRET: "test-secret",
    FRONTEND_URL: "http://localhost:3000",
    CORS_ORIGINS: "http://localhost:3000",
    PORT: 3001,
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ALLOWED_GITHUB_LOGINS: "",
  },
  hasGitHubOAuthConfigured: true,
  allowedGitHubLogins: [],
}));

import { createTaskSchema, updateTaskSchema } from "../../src/routes/tasks.js";
import { createTokenSchema } from "../../src/routes/agent-tokens.js";
import { httpUrl } from "../../src/lib/url-guard.js";
import { authRouter } from "../../src/routes/auth.js";
import { directPatchSchema } from "../../src/services/grounding-direct-input.js";
import { readGroundingRoutePlan } from "../../src/services/grounding-route-effects.js";

const TOKEN_FIXTURE = {
  teamId: "550e8400-e29b-41d4-a716-446655440000",
  name: "pin",
};

describe("createTaskSchema.dueAt accept-set (isoDatetime)", () => {
  it("accepts the minute-precision form 2020-01-01T00:00Z, value unchanged", () => {
    const r = createTaskSchema.safeParse({ title: "t", dueAt: "2020-01-01T00:00Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.dueAt).toBe("2020-01-01T00:00Z");
  });
  it("accepts the seconds form 2020-01-01T00:00:00Z, value unchanged", () => {
    const r = createTaskSchema.safeParse({ title: "t", dueAt: "2020-01-01T00:00:00Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.dueAt).toBe("2020-01-01T00:00:00Z");
  });
  it("accepts the millisecond form 2020-01-01T00:00:00.123Z, value unchanged", () => {
    const r = createTaskSchema.safeParse({ title: "t", dueAt: "2020-01-01T00:00:00.123Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.dueAt).toBe("2020-01-01T00:00:00.123Z");
  });
  it("rejects the +02:00 offset form (zod 3 was Z-only)", () => {
    expect(
      createTaskSchema.safeParse({ title: "t", dueAt: "2020-01-01T00:00:00+02:00" }).success,
    ).toBe(false);
  });
  it("rejects the local form 2020-01-01T00:00:00 without the Z suffix", () => {
    expect(createTaskSchema.safeParse({ title: "t", dueAt: "2020-01-01T00:00:00" }).success).toBe(false);
  });
});

describe("updateTaskSchema.dueAt accept-set (isoDatetime)", () => {
  it("accepts the minute-precision form 2020-01-01T00:00Z, value unchanged", () => {
    const r = updateTaskSchema.safeParse({ dueAt: "2020-01-01T00:00Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.dueAt).toBe("2020-01-01T00:00Z");
  });
  it("accepts the seconds form 2020-01-01T00:00:00Z, value unchanged", () => {
    const r = updateTaskSchema.safeParse({ dueAt: "2020-01-01T00:00:00Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.dueAt).toBe("2020-01-01T00:00:00Z");
  });
  it("accepts the millisecond form 2020-01-01T00:00:00.123Z, value unchanged", () => {
    const r = updateTaskSchema.safeParse({ dueAt: "2020-01-01T00:00:00.123Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.dueAt).toBe("2020-01-01T00:00:00.123Z");
  });
  it("rejects the +02:00 offset form (zod 3 was Z-only)", () => {
    expect(updateTaskSchema.safeParse({ dueAt: "2020-01-01T00:00:00+02:00" }).success).toBe(false);
  });
  it("rejects the local form 2020-01-01T00:00:00 without the Z suffix", () => {
    expect(updateTaskSchema.safeParse({ dueAt: "2020-01-01T00:00:00" }).success).toBe(false);
  });
});

describe("createTokenSchema.expiresAt accept-set (isoDatetime)", () => {
  it("accepts the minute-precision form 2020-01-01T00:00Z, value unchanged", () => {
    const r = createTokenSchema.safeParse({ ...TOKEN_FIXTURE, expiresAt: "2020-01-01T00:00Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.expiresAt).toBe("2020-01-01T00:00Z");
  });
  it("accepts the seconds form 2020-01-01T00:00:00Z, value unchanged", () => {
    const r = createTokenSchema.safeParse({ ...TOKEN_FIXTURE, expiresAt: "2020-01-01T00:00:00Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.expiresAt).toBe("2020-01-01T00:00:00Z");
  });
  it("accepts the millisecond form 2020-01-01T00:00:00.123Z, value unchanged", () => {
    const r = createTokenSchema.safeParse({ ...TOKEN_FIXTURE, expiresAt: "2020-01-01T00:00:00.123Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.expiresAt).toBe("2020-01-01T00:00:00.123Z");
  });
  it("rejects the +02:00 offset form (zod 3 was Z-only)", () => {
    expect(createTokenSchema.safeParse({ ...TOKEN_FIXTURE, expiresAt: "2020-01-01T00:00:00+02:00" }).success).toBe(false);
  });
  it("rejects the local form 2020-01-01T00:00:00 without the Z suffix", () => {
    expect(createTokenSchema.safeParse({ ...TOKEN_FIXTURE, expiresAt: "2020-01-01T00:00:00" }).success).toBe(false);
  });
});

describe("httpUrl() accept-set and unchanged output (urlString + scheme refine)", () => {
  it("accepts http://x.io/a, value unchanged", () => {
    const r = httpUrl().safeParse("http://x.io/a");
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe("http://x.io/a");
  });
  it("accepts https://h:8080, value unchanged", () => {
    const r = httpUrl().safeParse("https://h:8080");
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe("https://h:8080");
  });
  it("rejects the bare authority http:// (new URL rejects it)", () => {
    expect(httpUrl().safeParse("http://").success).toBe(false);
  });
  it("rejects http://a b (an inner space fails URL parsing)", () => {
    expect(httpUrl().safeParse("http://a b").success).toBe(false);
  });
  it("rejects ftp://x (parses as a URL, fails the http(s) scheme refine)", () => {
    expect(httpUrl().safeParse("ftp://x").success).toBe(false);
  });
  it("rejects javascript:alert(1) (parses as a URL, fails the http(s) scheme refine)", () => {
    expect(httpUrl().safeParse("javascript:alert(1)").success).toBe(false);
  });
  it("rejects not a url (URL.canParse false)", () => {
    expect(httpUrl().safeParse("not a url").success).toBe(false);
  });
  // Base semantics for the whitespace-bearing forms, measured per URL.canParse
  // (identical to zod 3's `new URL(value)` check): all three PARSE (the URL
  // parser strips the whitespace characters internally), so the base .url()
  // accepted them and returned them unchanged, and the http(s) refine on the
  // unchanged value then decided the final result. Pin that exact outcome.
  it('rejects " http://x.io" (leading space: parses, fails the scheme refine on the unchanged value)', () => {
    expect(httpUrl().safeParse(" http://x.io").success).toBe(false);
  });
  it('rejects the newline-spoofed "h\\nttps://evil.com" (parses, fails the scheme refine on the unchanged value)', () => {
    expect(httpUrl().safeParse("h\nttps://evil.com").success).toBe(false);
  });
  it('accepts the tab-inside-host "http://exa\\tmple.com" with the value UNCHANGED (base semantics; z.url() would strip the tab and rewrite the output)', () => {
    const r = httpUrl().safeParse("http://exa\tmple.com");
    expect(r.success).toBe(true);
    expect(r.success && r.data).toBe("http://exa\tmple.com");
  });
});

describe("registerSchema email through POST /api/auth/register (z.email)", () => {
  it("rejects an invalid email with 400 and an issue on the email path", async () => {
    const res = await authRouter.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "plainaddress", password: "supersecret" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: Array<{ path: Array<string | number> }> } };
    expect(body.error.issues.some((i) => i.path.join(".") === "email")).toBe(true);
  });
});

describe("guid fields through the real token/task schemas (z.guid, not z.uuid)", () => {
  it("createTokenSchema accepts the all-zero variant hex id 00000000-0000-0000-0000-000000000001 (would fail RFC 9562 checks)", () => {
    const r = createTokenSchema.safeParse({ ...TOKEN_FIXTURE, teamId: "00000000-0000-0000-0000-000000000001" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.teamId).toBe("00000000-0000-0000-0000-000000000001");
  });
  it("createTaskSchema rejects a non-guid workflowId", () => {
    expect(createTaskSchema.safeParse({ title: "t", workflowId: "not-a-guid" }).success).toBe(false);
  });
});

// Fix B (datetime rejection message): the isoDatetime union carries an explicit
// `error` so a rejected value reports code `invalid_union` with message
// `Invalid datetime`. The zod 3 `.datetime()` produced a single `invalid_string`
// issue with that same message for a bad string, and `invalid_type` for a
// non-string; zod 4's bare union would say `invalid_union`/"Invalid input".
// Pinned through the real createTaskSchema (the POST /api/projects/:id/tasks
// body validator), one input per case.
describe("createTaskSchema.dueAt rejection code and message (invalid_union / Invalid datetime)", () => {
  it("reports invalid_union + \"Invalid datetime\" for the +02:00 offset form", () => {
    const r = createTaskSchema.safeParse({ title: "t", dueAt: "2020-01-01T00:00:00+02:00" });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues.find((i) => i.path.join(".") === "dueAt");
    expect(issue?.code).toBe("invalid_union");
    expect(issue?.message).toBe("Invalid datetime");
  });
  it("reports invalid_union + \"Invalid datetime\" for a non-string dueAt (base reported invalid_type)", () => {
    const r = createTaskSchema.safeParse({ title: "t", dueAt: 1234 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issue = r.error.issues.find((i) => i.path.join(".") === "dueAt");
    expect(issue?.code).toBe("invalid_union");
    expect(issue?.message).toBe("Invalid datetime");
  });
  it("still accepts the minute-precision form through the same schema (error option does not change the accept-set)", () => {
    const r = createTaskSchema.safeParse({ title: "t", dueAt: "2020-01-01T00:00Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.dueAt).toBe("2020-01-01T00:00Z");
  });
});

// Fix A (site 2): directPatchSchema.dueAt (grounding direct-input patch) uses
// the same isoDatetime helper. The mutation that reverts it to a bare
// z.iso.datetime() drops the minute-precision branch, so the accepted minute
// form (value unchanged) is the discriminator; the offset reject guards the
// other direction.
describe("directPatchSchema.dueAt accept-set (isoDatetime)", () => {
  it("accepts the minute-precision form 2020-01-01T00:00Z, value unchanged", () => {
    const r = directPatchSchema.safeParse({ dueAt: "2020-01-01T00:00Z" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.dueAt).toBe("2020-01-01T00:00Z");
  });
  it("rejects the +02:00 offset form (zod 3 was Z-only)", () => {
    expect(directPatchSchema.safeParse({ dueAt: "2020-01-01T00:00:00+02:00" }).success).toBe(false);
  });
});

// Fix A (site 3): the grounding route-effects patch schema (patchSchema, run
// through the exported readGroundingRoutePlan) carries the same dueAt field.
// A minimal valid plan is built and round-tripped; the minute-precision dueAt
// must survive unchanged, which the z.iso.datetime() revert rejects.
function minimalRoutePlan(patch: Record<string, unknown>) {
  return {
    version: 1,
    kind: "direct",
    action: "transition",
    remote: false,
    patch: { status: "open", ...patch },
    response: {},
    acknowledge: false,
    signals: [],
    comments: [],
    audits: [],
  };
}

describe("grounding route-effects patch.dueAt accept-set (isoDatetime, via readGroundingRoutePlan)", () => {
  it("accepts the minute-precision form 2020-01-01T00:00Z, value unchanged", () => {
    const plan = readGroundingRoutePlan(minimalRoutePlan({ dueAt: "2020-01-01T00:00Z" }));
    expect(plan.patch.dueAt).toBe("2020-01-01T00:00Z");
  });
  it("rejects the +02:00 offset form (zod 3 was Z-only)", () => {
    expect(() => readGroundingRoutePlan(minimalRoutePlan({ dueAt: "2020-01-01T00:00:00+02:00" }))).toThrow();
  });
});
