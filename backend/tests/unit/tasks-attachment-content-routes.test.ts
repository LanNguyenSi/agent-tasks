/**
 * Route tests for the agent-read attachment endpoints:
 *   GET /tasks/:id/attachments            (metadata list)
 *   GET /tasks/:id/attachments/:attId/content  (text excerpt / base64)
 *
 * Mirrors tasks-attachments-routes.test.ts: hoisted Prisma mocks, mocked
 * team-access, actor injected via pre-middleware. The attachment-content
 * service is mocked so these tests focus on authz/IDOR/wiring;
 * readAttachmentContent itself is covered by attachment-content.test.ts.
 * storedFilePath (attachment-files) is left REAL so the URL→path mapping is
 * exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  attachmentFindUnique: vi.fn(),
  attachmentFindMany: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: prismaMocks.taskFindUnique },
    taskAttachment: {
      findUnique: prismaMocks.attachmentFindUnique,
      findMany: prismaMocks.attachmentFindMany,
    },
    taskArtifact: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    signal: { findFirst: vi.fn(), update: vi.fn() },
    workflow: { findFirst: vi.fn() },
    agentToken: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const contentMock = vi.hoisted(() => ({ readAttachmentContent: vi.fn() }));
vi.mock("../../src/services/attachment-content.js", () => ({
  readAttachmentContent: contentMock.readAttachmentContent,
  // Keep the real flag parser so the route's query→option mapping is exercised.
  parseIncludeBase64Flag: (v: unknown) => {
    const r = String(v ?? "").trim().toLowerCase();
    return r === "1" || r === "true" || r === "yes";
  },
}));

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(false),
  isProjectAdmin: vi.fn().mockResolvedValue(false),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);
vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn(),
  emitChangesRequestedSignal: vi.fn(),
  emitTaskApprovedSignal: vi.fn(),
}));
vi.mock("../../src/services/task-signal.js", () => ({ emitTaskAvailableSignal: vi.fn() }));
vi.mock("../../src/services/force-transition-signal.js", () => ({ emitForceTransitionedSignal: vi.fn() }));
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: vi.fn() }));
vi.mock("../../src/services/github-delegation.js", () => ({ findDelegationUser: vi.fn().mockResolvedValue(null) }));

import { taskRouter } from "../../src/routes/tasks.js";

const AGENT: Actor = { type: "agent", tokenId: "agent-1", teamId: "team-1", scopes: ["tasks:read"] };
const HUMAN: Actor = { type: "human", userId: "user-1", teamId: "team-1" };

function makeApp(actor: Actor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", taskRouter);
  return app;
}

const task = { id: "task-1", projectId: "proj-1" };

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  prismaMocks.taskFindUnique.mockResolvedValue(task);
  prismaMocks.attachmentFindMany.mockResolvedValue([]);
  contentMock.readAttachmentContent.mockResolvedValue({ status: "ready", encoding: "utf-8", text: "hi", excerpt: "hi" });
});

describe("GET /tasks/:id/attachments (list)", () => {
  it("returns attachment metadata for an agent with tasks:read", async () => {
    prismaMocks.attachmentFindMany.mockResolvedValue([
      { id: "a1", taskId: "task-1", name: "shot.png", type: "IMAGE", sizeBytes: 10 },
    ]);
    const res = await makeApp(AGENT).request("/tasks/task-1/attachments");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachments: unknown[] };
    expect(body.attachments).toHaveLength(1);
    expect(prismaMocks.attachmentFindMany.mock.calls[0]![0].where).toEqual({ taskId: "task-1" });
  });

  it("rejects an agent missing tasks:read with 403", async () => {
    const weak: Actor = { ...AGENT, scopes: [] };
    const res = await makeApp(weak).request("/tasks/task-1/attachments");
    expect(res.status).toBe(403);
    expect(prismaMocks.attachmentFindMany).not.toHaveBeenCalled();
  });

  it("403 for a non-member, 404 for a missing task", async () => {
    accessMocks.hasProjectAccess.mockResolvedValue(false);
    expect((await makeApp(HUMAN).request("/tasks/task-1/attachments")).status).toBe(403);
    accessMocks.hasProjectAccess.mockResolvedValue(true);
    prismaMocks.taskFindUnique.mockResolvedValue(null);
    expect((await makeApp(HUMAN).request("/tasks/missing/attachments")).status).toBe(404);
  });
});

describe("GET /tasks/:id/attachments/:attId/content", () => {
  it("reads an uploaded attachment, passing the resolved path + parsed options", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "a1",
      taskId: "task-1",
      name: "spec.md",
      url: "/uploads/abc.md",
      mimeType: "text/markdown",
      sizeBytes: 20,
      type: "DOCUMENT",
    });

    const res = await makeApp(AGENT).request(
      "/tasks/task-1/attachments/a1/content?includeBase64=true&textByteLimit=100",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachment: { id: string }; content: { status: string } };
    expect(body.attachment.id).toBe("a1");
    expect(body.content.status).toBe("ready");

    const [absPath, mime, opts] = contentMock.readAttachmentContent.mock.calls[0]!;
    // storedFilePath (real) resolves /uploads/abc.md to an absolute path.
    expect(typeof absPath).toBe("string");
    expect(absPath as string).toMatch(/abc\.md$/);
    expect(mime).toBe("text/markdown");
    expect(opts).toMatchObject({ includeBase64: true, textByteLimit: "100" });
  });

  it("passes null to the reader for a URL-pointer attachment (no bytes)", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "a2",
      taskId: "task-1",
      name: "link",
      url: "https://example.com/x",
      mimeType: "text/plain",
      type: "DOCUMENT",
    });
    contentMock.readAttachmentContent.mockResolvedValue({ status: "missing" });
    const res = await makeApp(AGENT).request("/tasks/task-1/attachments/a2/content");
    expect(res.status).toBe(200);
    expect(contentMock.readAttachmentContent.mock.calls[0]![0]).toBeNull();
  });

  it("returns 404 when the attachment belongs to another task (IDOR guard)", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({ id: "a1", taskId: "OTHER", url: "/uploads/abc.md" });
    const res = await makeApp(AGENT).request("/tasks/task-1/attachments/a1/content");
    expect(res.status).toBe(404);
    expect(contentMock.readAttachmentContent).not.toHaveBeenCalled();
  });

  it("rejects an agent missing tasks:read with 403", async () => {
    const weak: Actor = { ...AGENT, scopes: [] };
    const res = await makeApp(weak).request("/tasks/task-1/attachments/a1/content");
    expect(res.status).toBe(403);
    expect(prismaMocks.attachmentFindUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing task", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(null);
    const res = await makeApp(AGENT).request("/tasks/missing/attachments/a1/content");
    expect(res.status).toBe(404);
  });
});
