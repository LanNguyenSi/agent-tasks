import { describe, expect, it, vi } from "vitest";

// Mock Prisma before importing auth middleware
vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    agentToken: { findUnique: vi.fn(), update: vi.fn() },
    teamMember: { findUnique: vi.fn() },
  },
}));

vi.mock("../../src/services/session.js", () => ({
  verifySessionToken: vi.fn(),
  extractSessionCookie: vi.fn(),
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
  },
}));

import { hashToken } from "../../src/middleware/auth.js";

describe("hashToken", () => {
  it("produces a consistent hash for the same input", () => {
    const hash1 = hashToken("test-token");
    const hash2 = hashToken("test-token");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });

  it("returns a 64-char hex string (SHA-256)", () => {
    const hash = hashToken("at_abc123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
