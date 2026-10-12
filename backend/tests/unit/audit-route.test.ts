/**
 * Route tests for GET /projects/:projectId/audit: the optional server-side
 * `actionPrefix` filter is validated before any query runs and is forwarded to
 * getAuditLogs only when present.
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

function request(query: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", { type: "human", userId: "u1", teamId: "t1" } as AppVariables["actor"]);
    await next();
  });
  app.route("/api", auditRouter);
  return app.request(`/api/projects/p1/audit${query}`);
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
