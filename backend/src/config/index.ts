import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  SESSION_SECRET: z.string().min(32),
  // 32-byte key (hex or base64) used to encrypt OIDC client secrets at rest.
  // Required as soon as any SsoConnection exists; optional otherwise.
  SSO_ENCRYPTION_KEY: z.string().default(""),
  BACKEND_URL: z.string().url().default("http://localhost:3001"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  // Optional Redis URL for shared caches. When unset, backing services
  // fall back to in-memory — local dev and single-instance deploys keep
  // working identically. Set this when running more than one backend
  // pod behind a load balancer so GitHub API cache hits stay shared.
  REDIS_URL: z.string().url().optional(),
  // Key prefix for Redis-backed caches, so cross-environment deploys
  // sharing a redis instance don't collide. Unused when REDIS_URL is
  // absent.
  REDIS_KEY_PREFIX: z.string().default("agent-tasks:"),
});

function loadConfig() {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid configuration:", result.error.flatten());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
export type Config = typeof config;

export const hasGitHubOAuthConfigured =
  config.GITHUB_CLIENT_ID.length > 0 && config.GITHUB_CLIENT_SECRET.length > 0;
