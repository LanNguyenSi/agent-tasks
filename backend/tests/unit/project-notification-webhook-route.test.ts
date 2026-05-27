/**
 * Route tests for project notification-webhook settings:
 *   - PATCH /projects/:id accepts notificationWebhookUrl + notificationWebhookSecret
 *   - PATCH normalizes empty string to null (UI clear path)
 *   - PATCH audits URL changes (plaintext) and secret changes (set/unset bool only)
 *   - GET /projects/:id redacts the secret and exposes hasNotificationWebhookSecret
 *   - POST /projects returns a redacted project
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const { prismaMocks, mockLogAuditEvent } = vi.hoisted(() => ({
  prismaMocks: {
    projectFindUnique: vi.fn(),
    projectUpdate: vi.fn(),
    projectCreate: vi.fn(),
  },
  mockLogAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: prismaMocks.projectFindUnique,
      update: prismaMocks.projectUpdate,
      create: prismaMocks.projectCreate,
      findMany: vi.fn(),
    },
    teamMember: { findUnique: vi.fn() },
  },
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: mockLogAuditEvent,
}));

vi.mock("../../src/services/team-access.js", () => ({
  isProjectAdmin: vi.fn().mockResolvedValue(true),
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  getProjectMembership: vi.fn().mockResolvedValue({ source: "team" }),
  resolveTeamId: vi.fn().mockResolvedValue({ ok: true, teamId: "team-A" }),
  resolveTeamIdErrorBody: vi.fn(),
}));

vi.mock("../../src/services/board-default.js", () => ({
  ensureDefaultBoardForProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/gates/index.js", () => ({
  computeEffectiveGates: vi.fn().mockReturnValue([]),
}));

import { projectRouter } from "../../src/routes/projects.js";

const HUMAN: Actor = { type: "human", userId: "u-admin" };

function makeApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", HUMAN);
    await next();
  });
  app.route("/", projectRouter);
  return app;
}

const baseProject = {
  id: "proj-1",
  teamId: "team-A",
  name: "Test Project",
  slug: "test",
  description: null,
  githubRepo: null,
  githubSyncAt: null,
  taskTemplate: null,
  confidenceThreshold: 60,
  requireDistinctReviewer: false,
  soloMode: true,
  governanceMode: "AUTONOMOUS",
  requireGroundingForDebug: false,
  notificationWebhookUrl: null,
  notificationWebhookSecret: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /projects/:id — notification webhook fields", () => {
  it("accepts notificationWebhookUrl and persists it via prisma.update", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue(baseProject);
    prismaMocks.projectUpdate.mockResolvedValue({
      ...baseProject,
      notificationWebhookUrl: "https://hooks.example/inbox",
    });

    const res = await makeApp().request("/projects/proj-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notificationWebhookUrl: "https://hooks.example/inbox" }),
    });

    expect(res.status).toBe(200);
    expect(prismaMocks.projectUpdate).toHaveBeenCalledWith({
      where: { id: "proj-1" },
      data: expect.objectContaining({
        notificationWebhookUrl: "https://hooks.example/inbox",
      }),
    });
  });

  it("normalizes empty string URL to null so the UI can clear the value", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      ...baseProject,
      notificationWebhookUrl: "https://old.example",
    });
    prismaMocks.projectUpdate.mockResolvedValue({
      ...baseProject,
      notificationWebhookUrl: null,
    });

    const res = await makeApp().request("/projects/proj-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notificationWebhookUrl: "" }),
    });

    expect(res.status).toBe(200);
    expect(prismaMocks.projectUpdate).toHaveBeenCalledWith({
      where: { id: "proj-1" },
      data: expect.objectContaining({ notificationWebhookUrl: null }),
    });
  });

  it("audits a URL change in plaintext (operators need to see destinations)", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      ...baseProject,
      notificationWebhookUrl: "https://old.example",
    });
    prismaMocks.projectUpdate.mockResolvedValue({
      ...baseProject,
      notificationWebhookUrl: "https://new.example",
    });

    await makeApp().request("/projects/proj-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notificationWebhookUrl: "https://new.example" }),
    });

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.updated",
        payload: {
          changes: expect.objectContaining({
            notificationWebhookUrl: {
              from: "https://old.example",
              to: "https://new.example",
            },
          }),
        },
      }),
    );
  });

  it("audits a secret CHANGE as set→set without leaking the raw secret values", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      ...baseProject,
      notificationWebhookSecret: "old-secret",
    });
    prismaMocks.projectUpdate.mockResolvedValue({
      ...baseProject,
      notificationWebhookSecret: "new-secret",
    });

    await makeApp().request("/projects/proj-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notificationWebhookSecret: "new-secret" }),
    });

    const auditCall = mockLogAuditEvent.mock.calls.find(
      (c) => c[0].action === "project.updated",
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0].payload as { changes: Record<string, unknown> };
    expect(payload.changes.notificationWebhookSecret).toEqual({
      from: "set",
      to: "set",
    });
    // Make absolutely sure no plaintext secret leaked into the audit
    // payload from any field.
    expect(JSON.stringify(payload)).not.toContain("old-secret");
    expect(JSON.stringify(payload)).not.toContain("new-secret");
  });

  it("does NOT emit an audit entry if the secret is unchanged", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      ...baseProject,
      notificationWebhookSecret: "same",
    });
    prismaMocks.projectUpdate.mockResolvedValue({
      ...baseProject,
      notificationWebhookSecret: "same",
    });

    await makeApp().request("/projects/proj-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notificationWebhookSecret: "same" }),
    });

    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects a malformed webhook URL with 400 before touching the DB", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue(baseProject);

    const res = await makeApp().request("/projects/proj-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notificationWebhookUrl: "not-a-url" }),
    });

    expect(res.status).toBe(400);
    expect(prismaMocks.projectUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /projects/:id — secret redaction", () => {
  it("returns hasNotificationWebhookSecret:true and does NOT echo the raw secret", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      ...baseProject,
      notificationWebhookUrl: "https://hooks.example",
      notificationWebhookSecret: "super-secret",
    });

    const res = await makeApp().request("/projects/proj-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: Record<string, unknown> };

    expect(body.project.notificationWebhookUrl).toBe("https://hooks.example");
    expect(body.project.hasNotificationWebhookSecret).toBe(true);
    expect(body.project.notificationWebhookSecret).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });

  it("returns hasNotificationWebhookSecret:false when no secret is set", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue({
      ...baseProject,
      notificationWebhookUrl: "https://hooks.example",
      notificationWebhookSecret: null,
    });

    const res = await makeApp().request("/projects/proj-1");
    const body = (await res.json()) as { project: Record<string, unknown> };
    expect(body.project.hasNotificationWebhookSecret).toBe(false);
  });
});

describe("PATCH response — also redacts", () => {
  it("does not echo the secret in the PATCH response, even right after writing it", async () => {
    prismaMocks.projectFindUnique.mockResolvedValue(baseProject);
    prismaMocks.projectUpdate.mockResolvedValue({
      ...baseProject,
      notificationWebhookUrl: "https://hooks.example",
      notificationWebhookSecret: "freshly-set",
    });

    const res = await makeApp().request("/projects/proj-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        notificationWebhookUrl: "https://hooks.example",
        notificationWebhookSecret: "freshly-set",
      }),
    });
    const body = (await res.json()) as { project: Record<string, unknown> };

    expect(body.project.notificationWebhookSecret).toBeUndefined();
    expect(body.project.hasNotificationWebhookSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("freshly-set");
  });
});
