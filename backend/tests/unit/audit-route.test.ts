/**
 * Route tests for GET /projects/:projectId/audit: the optional server-side
 * `actionPrefix` filter is validated before any query runs and is forwarded to
 * getAuditLogs only when present. Also covers `limit`/`offset` validation on
 * that handler and on GET /projects/:projectId/audit/github-delegation: the
 * digits-only rule, the defaults, the 200 cap and the access-check-first
 * order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));

const accessMocks = vi.hoisted(() => ({ hasProjectAccess: vi.fn().mockResolvedValue(true) }));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const auditMocks = vi.hoisted(() => ({ getAuditLogs: vi.fn().mockResolvedValue([]) }));
vi.mock("../../src/services/audit.js", () => auditMocks);

import { auditRouter } from "../../src/routes/audit.js";

function request(query: string, path = "/api/projects/p1/audit") {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId: "u1", teamId: "t1" } as AppVariables["actor"]);
    await next();
  });
  app.route("/api", auditRouter);
  return app.request(`${path}${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  auditMocks.getAuditLogs.mockResolvedValue([]);
});

describe("GET /projects/:projectId/audit actionPrefix", () => {
  it("does not pass a prefix when the parameter is absent", async () => {
    const res = await request("");
    expect(res.status).toBe(200);
    expect(auditMocks.getAuditLogs).toHaveBeenCalledWith({ projectId: "p1", limit: 50, offset: 0 });
  });

  it("forwards a valid prefix to the query", async () => {
    const res = await request("?actionPrefix=signal.webhook_&limit=20");
    expect(res.status).toBe(200);
    expect(auditMocks.getAuditLogs).toHaveBeenCalledWith({
      projectId: "p1",
      actionPrefix: "signal.webhook_",
      limit: 20,
      offset: 0,
    });
  });

  it.each([
    ["empty", "?actionPrefix="],
    ["a SQL wildcard", "?actionPrefix=task%25"],
    ["a space", "?actionPrefix=task%20x"],
    ["a quote", "?actionPrefix=task%27"],
    ["over 100 characters", `?actionPrefix=${"a".repeat(101)}`],
  ])("rejects %s with 400 and runs no query", async (_label, query) => {
    const res = await request(query);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("actionPrefix");
    expect(auditMocks.getAuditLogs).not.toHaveBeenCalled();
  });

  it("still checks project access before validating the prefix", async () => {
    accessMocks.hasProjectAccess.mockResolvedValueOnce(false);
    const res = await request("?actionPrefix=%25");
    expect(res.status).toBe(403);
    expect(auditMocks.getAuditLogs).not.toHaveBeenCalled();
  });
});

const PAGINATION_HANDLERS = [
  ["audit", "/api/projects/p1/audit", { projectId: "p1" }],
  [
    "audit/github-delegation",
    "/api/projects/p1/audit/github-delegation",
    { projectId: "p1", actionPrefix: "github." },
  ],
] as const;

describe.each(PAGINATION_HANDLERS)(
  "limit/offset validation on GET /projects/:projectId/%s",
  (_label, path, queryBase) => {
    it("defaults to limit 50 and offset 0 when the parameters are absent", async () => {
      const res = await request("", path);
      expect(res.status).toBe(200);
      expect(auditMocks.getAuditLogs).toHaveBeenCalledWith({ ...queryBase, limit: 50, offset: 0 });
    });

    it("passes valid values through and answers with the numbers used", async () => {
      const res = await request("?limit=20&offset=5", path);
      expect(res.status).toBe(200);
      expect(auditMocks.getAuditLogs).toHaveBeenCalledWith({ ...queryBase, limit: 20, offset: 5 });
      await expect(res.json()).resolves.toMatchObject({ limit: 20, offset: 5 });
    });

    it("caps a larger valid limit at 200 without an error", async () => {
      const res = await request("?limit=500", path);
      expect(res.status).toBe(200);
      expect(auditMocks.getAuditLogs).toHaveBeenCalledWith({ ...queryBase, limit: 200, offset: 0 });
    });

    it("keeps today's accepted limit=0 (empty page, not an error)", async () => {
      const res = await request("?limit=0", path);
      expect(res.status).toBe(200);
      expect(auditMocks.getAuditLogs).toHaveBeenCalledWith({ ...queryBase, limit: 0, offset: 0 });
    });

    it("keeps today's accepted offset=0", async () => {
      const res = await request("?offset=0", path);
      expect(res.status).toBe(200);
      expect(auditMocks.getAuditLogs).toHaveBeenCalledWith({ ...queryBase, limit: 50, offset: 0 });
    });

    it.each([
      ["non-numeric", "abc"],
      ["negative", "-1"],
      ["fractional", "1.5"],
      ["empty", ""],
      ["exponent", "1e3"],
    ])("rejects a %s limit with 400 and runs no query", async (_kind, value) => {
      const res = await request(`?limit=${encodeURIComponent(value)}`, path);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("bad_request");
      expect(body.message).toContain("limit");
      expect(auditMocks.getAuditLogs).not.toHaveBeenCalled();
    });

    it.each([
      ["non-numeric", "abc"],
      ["negative", "-1"],
      ["fractional", "1.5"],
      ["empty", ""],
      ["exponent", "1e3"],
    ])("rejects a %s offset with 400 and runs no query", async (_kind, value) => {
      const res = await request(`?offset=${encodeURIComponent(value)}`, path);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("bad_request");
      expect(body.message).toContain("offset");
      expect(auditMocks.getAuditLogs).not.toHaveBeenCalled();
    });

    it.each([
      ["just above the int32 range", "2147483648"],
      ["400-digit", "9".repeat(400)],
    ])("rejects a %s offset with 400 and runs no query", async (_kind, value) => {
      const res = await request(`?offset=${value}`, path);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("bad_request");
      expect(body.message).toContain("offset");
      expect(auditMocks.getAuditLogs).not.toHaveBeenCalled();
    });

    it("accepts the largest int32 offset and clamps a 400-digit limit to 200", async () => {
      const res = await request(`?offset=2147483647&limit=${"9".repeat(400)}`, path);
      expect(res.status).toBe(200);
      expect(auditMocks.getAuditLogs).toHaveBeenCalledWith({ ...queryBase, limit: 200, offset: 2147483647 });
    });

    it("answers 403 before validating the parameters when access is denied", async () => {
      // not Once(): if a mutant skips the access check the value must not
      // leak into the next test
      accessMocks.hasProjectAccess.mockResolvedValue(false);
      const res = await request("?limit=abc&offset=-1", path);
      expect(res.status).toBe(403);
      expect(auditMocks.getAuditLogs).not.toHaveBeenCalled();
    });
  },
);
