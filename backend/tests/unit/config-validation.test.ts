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
