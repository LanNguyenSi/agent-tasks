import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Regression guard for the L3 audit finding: backend/src/config/index.ts
// requires SESSION_SECRET (z.string().min(32), no default) and process.exit(1)s
// on parse failure via loadConfig(). That fail-loud behavior is the load-bearing
// safety net removed docker-compose's predictable dev default relied on. This
// suite re-imports the real config module under controlled env so a future
// change that adds a `.default()` or drops `.min(32)` fails a test instead of
// silently regressing to booting on an empty/weak secret.
//
// The module runs loadConfig() eagerly at import time (`export const config =
// loadConfig();`), so a bad env makes the dynamic import() itself reject once
// process.exit is mocked to throw, per the process.exit-mocking pattern in
// cli/tests/config.test.ts.
describe("backend config: SESSION_SECRET fail-loud guard (L3)", () => {
  const origEnv = { ...process.env };
  const VALID_DATABASE_URL = "postgresql://test:test@localhost:5432/test";

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  async function importConfigWith(secret: string | undefined) {
    process.env.DATABASE_URL = VALID_DATABASE_URL;
    if (secret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = secret;
    }
    return import("../../src/config/index.js");
  }

  it("fails loud (exit 1) when SESSION_SECRET is unset", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(importConfigWith(undefined)).rejects.toThrow("exit");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("fails loud (exit 1) when SESSION_SECRET is shorter than 32 chars", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(importConfigWith("a".repeat(31))).rejects.toThrow("exit");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("loads successfully with a SESSION_SECRET of exactly 32 chars", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    const secret = "a".repeat(32);
    const { config } = await importConfigWith(secret);

    expect(config.SESSION_SECRET).toBe(secret);
    expect(mockExit).not.toHaveBeenCalled();
  });
});

// docker-compose.prod.yml forwards BACKEND_URL, REDIS_URL and
// IDEMPOTENCY_TTL_DAYS as `${VAR:-}`, so an operator who sets none of them
// hands the backend empty strings. Empty must behave like unset, not fail the
// url() / min(1) checks.
describe("backend config: empty optional values behave like unset", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  async function importConfigWithEnv(extra: Record<string, string | undefined>) {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.SESSION_SECRET = "a".repeat(32);
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return import("../../src/config/index.js");
  }

  it("applies the defaults when the variables are empty strings", async () => {
    const { config } = await importConfigWithEnv({
      BACKEND_URL: "",
      REDIS_URL: "",
      IDEMPOTENCY_TTL_DAYS: "",
      SSO_ENCRYPTION_KEY: "",
    });

    expect(config.BACKEND_URL).toBe("http://localhost:3001");
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.IDEMPOTENCY_TTL_DAYS).toBe(30);
    expect(config.SSO_ENCRYPTION_KEY).toBe("");
  });

  it("applies the same defaults when the variables are absent", async () => {
    const { config } = await importConfigWithEnv({
      BACKEND_URL: undefined,
      REDIS_URL: undefined,
      IDEMPOTENCY_TTL_DAYS: undefined,
    });

    expect(config.BACKEND_URL).toBe("http://localhost:3001");
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.IDEMPOTENCY_TTL_DAYS).toBe(30);
  });

  it("keeps explicitly set values over the defaults", async () => {
    const { config } = await importConfigWithEnv({
      BACKEND_URL: "https://api.example.test",
      REDIS_URL: "redis://redis:6379",
      IDEMPOTENCY_TTL_DAYS: "7",
    });

    expect(config.BACKEND_URL).toBe("https://api.example.test");
    expect(config.REDIS_URL).toBe("redis://redis:6379");
    expect(config.IDEMPOTENCY_TTL_DAYS).toBe(7);
  });

  it("still rejects a malformed BACKEND_URL", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(importConfigWithEnv({ BACKEND_URL: "not a url" })).rejects.toThrow("exit");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

// Contract 3 (zod 4 env migration): every variable whose parse changed shape or
// whose default/coerce behaviour I reasoned about, pinned per input (absent,
// empty, typical, boundary). `.url()` fields are exercised here for the v4 form
// (DATABASE_URL / FRONTEND_URL); coerce + enum + int-min fields for the rest.
describe("backend config: zod 4 env coercions and defaults", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  async function load(extra: Record<string, string | undefined>) {
    vi.resetModules();
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.SESSION_SECRET = "a".repeat(32);
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return import("../../src/config/index.js");
  }

  async function loadFails(extra: Record<string, string | undefined>) {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(load(extra)).rejects.toThrow("exit");
    expect(mockExit).toHaveBeenCalledWith(1);
  }

  it("PORT is coerced to a number, defaults when absent", async () => {
    expect((await load({ PORT: undefined })).config.PORT).toBe(3001);
    expect((await load({ PORT: "8080" })).config.PORT).toBe(8080);
  });

  it("PORT rejects a non-numeric value", async () => {
    await loadFails({ PORT: "http" });
  });

  it("NODE_ENV defaults to development and rejects an unknown value", async () => {
    expect((await load({ NODE_ENV: undefined })).config.NODE_ENV).toBe("development");
    expect((await load({ NODE_ENV: "production" })).config.NODE_ENV).toBe("production");
    await loadFails({ NODE_ENV: "staging" });
  });

  it("FRONTEND_URL uses the v4 url() check: default, typical, malformed", async () => {
    expect((await load({ FRONTEND_URL: undefined })).config.FRONTEND_URL).toBe("http://localhost:3000");
    expect((await load({ FRONTEND_URL: "https://app.example.test" })).config.FRONTEND_URL).toBe("https://app.example.test");
    await loadFails({ FRONTEND_URL: "not a url" });
  });

  it("DATABASE_URL requires a URL and rejects a non-URL string", async () => {
    await loadFails({ DATABASE_URL: "not a url" });
  });

  // urlString() (lib/zod-formats) is the zod 3 `.url()` behavior: the check
  // only requires URL constructibility and the value is returned UNCHANGED.
  // The WHATWG URL parser accepts " http://x" and "h\nttps://x" (it strips
  // whitespace characters internally), and zod hands back the raw env value.
  it('BACKEND_URL=" http://x" is accepted with the value kept EXACTLY (no trim)', async () => {
    expect((await load({ BACKEND_URL: " http://x" })).config.BACKEND_URL).toBe(" http://x");
  });

  it("FRONTEND_URL with an embedded newline is accepted with the value kept EXACTLY (no tab/CR/LF stripping)", async () => {
    expect((await load({ FRONTEND_URL: "h\nttps://app.example.test" })).config.FRONTEND_URL).toBe(
      "h\nttps://app.example.test",
    );
  });

  // Fix A (sites 4 and 5): DATABASE_URL and REDIS_URL are urlString() (the zod
  // 3 `.url()` behavior). The z.url() revert trims and strips tab/CR/LF from
  // the OUTPUT, so these whitespace-bearing forms pin the raw value surviving.
  it('DATABASE_URL=" postgresql://u:p@h/db" (leading space) is kept EXACTLY (no trim)', async () => {
    expect((await load({ DATABASE_URL: " postgresql://u:p@h/db" })).config.DATABASE_URL).toBe(
      " postgresql://u:p@h/db",
    );
  });

  it("REDIS_URL with a leading space is kept EXACTLY (no trim)", async () => {
    expect((await load({ REDIS_URL: " redis://redis:6379" })).config.REDIS_URL).toBe(" redis://redis:6379");
  });

  it("REDIS_URL with an embedded tab is kept EXACTLY (no tab stripping)", async () => {
    expect((await load({ REDIS_URL: "redis://re\tdis:6379" })).config.REDIS_URL).toBe("redis://re\tdis:6379");
  });

  it("TRUSTED_PROXY_HOPS defaults to 0, accepts the 0 boundary and a positive int", async () => {
    expect((await load({ TRUSTED_PROXY_HOPS: undefined })).config.TRUSTED_PROXY_HOPS).toBe(0);
    expect((await load({ TRUSTED_PROXY_HOPS: "0" })).config.TRUSTED_PROXY_HOPS).toBe(0);
    expect((await load({ TRUSTED_PROXY_HOPS: "2" })).config.TRUSTED_PROXY_HOPS).toBe(2);
  });

  it("TRUSTED_PROXY_HOPS rejects a negative and a non-integer value", async () => {
    await loadFails({ TRUSTED_PROXY_HOPS: "-1" });
    await loadFails({ TRUSTED_PROXY_HOPS: "1.5" });
  });

  it("IDEMPOTENCY_TTL_DAYS accepts the 1 boundary and rejects 0 / non-integer", async () => {
    expect((await load({ IDEMPOTENCY_TTL_DAYS: "1" })).config.IDEMPOTENCY_TTL_DAYS).toBe(1);
    await loadFails({ IDEMPOTENCY_TTL_DAYS: "0" });
    await loadFails({ IDEMPOTENCY_TTL_DAYS: "1.5" });
  });
});
