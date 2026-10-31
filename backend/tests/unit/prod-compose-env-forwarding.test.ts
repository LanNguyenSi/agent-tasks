// Contract:
// docker-compose.prod.yml forwards LOG_LEVEL and REDIS_KEY_PREFIX as
// `${VAR:-default}`, with each default equal to the backend's own fallback
// (LOG_LEVEL -> "info" in production, backend/src/lib/logger.ts;
// REDIS_KEY_PREFIX -> "agent-tasks:", backend/src/services/cache.ts).
// Both consumers read the raw variable with `??`, so the file's usual
// `${VAR:-}` empty-default forward is wrong here: a forwarded "" would win
// over the fallback (pino outright refuses an empty level), and config's
// zod default only fires on undefined. The compose `:-` operator
// substitutes on unset AND empty, so the three .env inputs resolve to:
// unset -> code default, empty -> code default, set -> the operator value.
// These tests pin the forwarding form and the backend side per input; the
// compose substitution itself is verified with `docker compose config`.
//
// Run: npx vitest run tests/unit/prod-compose-env-forwarding.test.ts from
// backend/ (also part of `npm run test --workspace=backend`).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

// Parses exactly `${VAR:-default}` with a non-empty default; returns null
// for any other form, including the forbidden `${VAR:-}` and `${VAR-def}`.
function interpolation(value: unknown, variable: string): string | null {
  const m = typeof value === "string" ? /^\$\{([A-Z_]+):-([^}]+)\}$/.exec(value) : null;
  return m && m[1] === variable ? m[2] : null;
}

function backendEnvironment(): Record<string, unknown> {
  const doc = load(fs.readFileSync(path.join(REPO_ROOT, "docker-compose.prod.yml"), "utf8"));
  if (typeof doc !== "object" || doc === null) throw new Error("compose file is not a mapping");
  const services = (doc as { services?: unknown }).services;
  if (typeof services !== "object" || services === null) throw new Error("no services mapping");
  const backend = (services as { backend?: unknown }).backend;
  if (typeof backend !== "object" || backend === null) throw new Error("no backend service");
  const env = (backend as { environment?: unknown }).environment;
  if (typeof env !== "object" || env === null) throw new Error("no backend environment mapping");
  return env as Record<string, unknown>;
}

describe("prod compose forwards LOG_LEVEL and REDIS_KEY_PREFIX", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  function backendBootEnv() {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.SESSION_SECRET = "a".repeat(32);
    process.env.NODE_ENV = "production";
  }

  it("pins the `${VAR:-code default}` forwarding form in the compose file", () => {
    const env = backendEnvironment();
    expect(interpolation(env.LOG_LEVEL, "LOG_LEVEL")).toBe("info");
    expect(interpolation(env.REDIS_KEY_PREFIX, "REDIS_KEY_PREFIX")).toBe("agent-tasks:");
  });

  it("keeps the fallbacks the compose defaults are written against", () => {
    const loggerSrc = fs.readFileSync(path.join(REPO_ROOT, "backend/src/lib/logger.ts"), "utf8");
    expect(loggerSrc).toMatch(/process\.env\.LOG_LEVEL \?\? \(isProd \? "info" : "debug"\)/);
    const cacheSrc = fs.readFileSync(path.join(REPO_ROOT, "backend/src/services/cache.ts"), "utf8");
    expect(cacheSrc).toMatch(/process\.env\.REDIS_KEY_PREFIX \?\? "agent-tasks:"/);
  });

  it("unset in .env: the backend answer equals the compose default", async () => {
    const env = backendEnvironment();
    backendBootEnv();
    delete process.env.LOG_LEVEL;
    const { logger } = await import("../../src/lib/logger.js");
    expect(logger.level).toBe(interpolation(env.LOG_LEVEL, "LOG_LEVEL"));
    delete process.env.REDIS_KEY_PREFIX;
    const { config } = await import("../../src/config/index.js");
    expect(config.REDIS_KEY_PREFIX).toBe(interpolation(env.REDIS_KEY_PREFIX, "REDIS_KEY_PREFIX"));
  });

  it("empty in .env must never reach the backend: empty would beat the fallback", async () => {
    // Pins WHY the compose default may not be empty. If an empty value
    // ever did arrive (a `${VAR:-}` forward), config keeps "" (the zod
    // default only fires on undefined) and pino rejects the import. The
    // compose `:-` operator (asserted in the form test) is what stops
    // this: it substitutes the default for an empty .env value too.
    backendBootEnv();
    process.env.REDIS_KEY_PREFIX = "";
    const { config } = await import("../../src/config/index.js");
    expect(config.REDIS_KEY_PREFIX).toBe("");
    vi.resetModules();
    backendBootEnv();
    process.env.LOG_LEVEL = "";
    await expect(import("../../src/lib/logger.js")).rejects.toThrow(/level/);
  });

  it("set in .env: the operator value wins over the default", async () => {
    const env = backendEnvironment();
    // The expressions reference the operator variables, so compose passes
    // any non-empty value through unchanged.
    expect(String(env.LOG_LEVEL)).toContain("${LOG_LEVEL:-");
    expect(String(env.REDIS_KEY_PREFIX)).toContain("${REDIS_KEY_PREFIX:-");
    backendBootEnv();
    process.env.LOG_LEVEL = "warn";
    const { logger } = await import("../../src/lib/logger.js");
    expect(logger.level).toBe("warn");
    process.env.REDIS_KEY_PREFIX = "team-a:";
    const { config } = await import("../../src/config/index.js");
    expect(config.REDIS_KEY_PREFIX).toBe("team-a:");
  });
});
