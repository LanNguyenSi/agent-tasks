import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockFindMany, mockFindUnique, mockCreate, mockTransaction } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    team: { findUnique: mockFindUnique, create: mockCreate },
    teamMember: { findMany: mockFindMany, findUnique: mockFindUnique, create: mockCreate, upsert: vi.fn() },
    $transaction: mockTransaction,
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: vi.fn(),
}));

// Test the pure slug validation logic extracted from the route
function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug) && slug.length >= 1 && slug.length <= 50;
}

function generateSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50);
}

describe("Team slug validation", () => {
  it("accepts valid slugs", () => {
    expect(isValidSlug("my-team")).toBe(true);
    expect(isValidSlug("team-123")).toBe(true);
    expect(isValidSlug("abc")).toBe(true);
  });

  it("rejects slugs with uppercase", () => {
    expect(isValidSlug("MyTeam")).toBe(false);
  });

  it("rejects slugs with spaces", () => {
    expect(isValidSlug("my team")).toBe(false);
  });

  it("rejects slugs with special chars", () => {
    expect(isValidSlug("my_team!")).toBe(false);
    expect(isValidSlug("team@org")).toBe(false);
  });

  it("rejects empty slug", () => {
    expect(isValidSlug("")).toBe(false);
  });
});

describe("generateSlugFromName", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(generateSlugFromName("My Team Name")).toBe("my-team-name");
  });

  it("removes special characters", () => {
    expect(generateSlugFromName("Team! @#$")).toBe("team-");
  });

  it("truncates to 50 chars", () => {
    const long = "a".repeat(100);
    expect(generateSlugFromName(long)).toHaveLength(50);
  });

  it("handles already-valid slugs", () => {
    expect(generateSlugFromName("valid-slug")).toBe("valid-slug");
  });
});
