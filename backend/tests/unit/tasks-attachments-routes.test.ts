/**
 * Route tests for the /tasks/:id/attachments file endpoints (upload, raw
 * serve, delete). Mirrors tasks-artifacts-routes.test.ts: hoisted Prisma mocks,
 * mocked team-access + audit, an actor injected via pre-middleware. Filesystem
 * access (node:fs/promises) is mocked so no bytes ever touch disk.
 *
 * Multipart note: requests pass a real global FormData as `body` and do NOT set
 * Content-Type by hand — Hono/undici injects the multipart boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../src/types/hono.js";
import type { Actor } from "../../src/types/auth.js";
import {
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_BODY_LIMIT_BYTES,
  uploadDir,
} from "../../src/services/attachment-files.js";

const prismaMocks = vi.hoisted(() => ({
  taskFindUnique: vi.fn(),
  taskDelete: vi.fn(),
  attachmentFindUnique: vi.fn(),
  attachmentFindMany: vi.fn(),
  attachmentCreate: vi.fn(),
  attachmentDelete: vi.fn(),
  attachmentCount: vi.fn(),
  attachmentAggregate: vi.fn(),
  projectFindUnique: vi.fn(),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    task: { findUnique: prismaMocks.taskFindUnique, delete: prismaMocks.taskDelete },
    project: { findUnique: prismaMocks.projectFindUnique },
    taskAttachment: {
      findUnique: prismaMocks.attachmentFindUnique,
      findMany: prismaMocks.attachmentFindMany,
      create: prismaMocks.attachmentCreate,
      delete: prismaMocks.attachmentDelete,
      count: prismaMocks.attachmentCount,
      aggregate: prismaMocks.attachmentAggregate,
    },
    // Imported by the tasks module at load time but unused by these routes.
    taskArtifact: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    signal: { findFirst: vi.fn(), update: vi.fn() },
    workflow: { findFirst: vi.fn() },
    agentToken: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:fs/promises", () => fsMocks);

const accessMocks = vi.hoisted(() => ({
  hasProjectAccess: vi.fn().mockResolvedValue(true),
  hasProjectRole: vi.fn().mockResolvedValue(false),
  isProjectAdmin: vi.fn().mockResolvedValue(false),
  requireProjectWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../src/services/team-access.js", () => accessMocks);

const auditMock = vi.hoisted(() => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/audit.js", () => auditMock);

// Silence signal emitters wired at module load.
vi.mock("../../src/services/review-signal.js", () => ({
  emitReviewSignal: vi.fn(),
  emitChangesRequestedSignal: vi.fn(),
  emitTaskApprovedSignal: vi.fn(),
}));
vi.mock("../../src/services/task-signal.js", () => ({ emitTaskAvailableSignal: vi.fn() }));
vi.mock("../../src/services/force-transition-signal.js", () => ({ emitForceTransitionedSignal: vi.fn() }));
vi.mock("../../src/services/github-merge.js", () => ({ performPrMerge: vi.fn() }));
vi.mock("../../src/services/github-delegation.js", () => ({
  findDelegationUser: vi.fn().mockResolvedValue(null),
}));

import { taskRouter } from "../../src/routes/tasks.js";

const AGENT: Actor = { type: "agent", tokenId: "agent-1", teamId: "team-1", scopes: ["tasks:read", "tasks:update"] };
const HUMAN: Actor = { type: "human", userId: "user-1", teamId: "team-1" };
const OTHER_HUMAN: Actor = { type: "human", userId: "user-2", teamId: "team-1" };

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

// Minimal valid magic-byte headers.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]);

function uploadForm(file: File, name?: string): FormData {
  const fd = new FormData();
  fd.append("file", file);
  if (name !== undefined) fd.append("name", name);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.hasProjectAccess.mockResolvedValue(true);
  accessMocks.hasProjectRole.mockResolvedValue(false);
  accessMocks.requireProjectWrite.mockResolvedValue(true);
  fsMocks.mkdir.mockResolvedValue(undefined);
  fsMocks.writeFile.mockResolvedValue(undefined);
  fsMocks.unlink.mockResolvedValue(undefined);
  fsMocks.readFile.mockResolvedValue(Buffer.from(PNG));
  prismaMocks.taskFindUnique.mockResolvedValue(task);
  prismaMocks.taskDelete.mockResolvedValue(task);
  prismaMocks.attachmentFindMany.mockResolvedValue([]);
  // Default: no per-project overrides, no existing attachments (cap checks pass).
  prismaMocks.projectFindUnique.mockResolvedValue({ attachmentCountCap: null, attachmentBytesCap: null });
  prismaMocks.attachmentCount.mockResolvedValue(0);
  prismaMocks.attachmentAggregate.mockResolvedValue({ _sum: { sizeBytes: null } });
});

describe("POST /tasks/:id/attachments/upload", () => {
  it("stores an image and records IMAGE metadata", async () => {
    prismaMocks.attachmentCreate.mockResolvedValue({
      id: "att-1",
      taskId: "task-1",
      name: "shot.png",
      url: "/uploads/uuid.png",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
      type: "IMAGE",
    });

    const file = new File([PNG], "shot.png", { type: "image/png" });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });

    expect(res.status).toBe(201);
    expect(fsMocks.mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    // The file lands inside UPLOAD_DIR under a uuid name.
    expect((fsMocks.writeFile.mock.calls[0]![0] as string).startsWith(uploadDir())).toBe(true);
    const data = prismaMocks.attachmentCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      taskId: "task-1",
      mimeType: "image/png",
      type: "IMAGE",
      sizeBytes: PNG.byteLength,
      createdByUserId: "user-1",
    });
    expect(data.url).toMatch(/^\/uploads\/[0-9a-f-]+\.png$/);
    expect(auditMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.attachment.uploaded", taskId: "task-1" }),
    );
  });

  it("stores a text file and records DOCUMENT metadata, using the provided display name", async () => {
    prismaMocks.attachmentCreate.mockResolvedValue({ id: "att-2", taskId: "task-1", type: "DOCUMENT" });
    const file = new File([Buffer.from("col1,col2\n1,2\n")], "data.csv", { type: "text/csv" });

    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file, "My data"),
    });

    expect(res.status).toBe(201);
    const data = prismaMocks.attachmentCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({ name: "My data", mimeType: "text/csv", type: "DOCUMENT" });
    expect(data.url).toMatch(/\.csv$/);
  });

  it("rejects a disallowed type (svg) with 400 and writes nothing", async () => {
    const file = new File([Buffer.from("<svg></svg>")], "x.svg", { type: "image/svg+xml" });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });
    expect(res.status).toBe(400);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
  });

  it("rejects a content/Content-Type mismatch (declared png, bytes are gif) with 400", async () => {
    const file = new File([GIF], "fake.png", { type: "image/png" });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });
    expect(res.status).toBe(400);
    expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
  });

  it("rejects a file over the 5 MiB cap with 413", async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61); // 'a' bytes, valid utf-8
    const file = new File([big], "big.txt", { type: "text/plain" });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });
    expect(res.status).toBe(413);
    expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
  });

  it("rejects a request with no file field (400)", async () => {
    const fd = new FormData();
    fd.append("name", "no file here");
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", { method: "POST", body: fd });
    expect(res.status).toBe(400);
  });

  it("forbids a non-member human (no write access) with 403", async () => {
    accessMocks.requireProjectWrite.mockResolvedValue(false);
    const file = new File([PNG], "shot.png", { type: "image/png" });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });
    expect(res.status).toBe(403);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(auditMock.logAuditEvent).not.toHaveBeenCalled();
  });

  it("forbids agents (upload is human-only) with 403", async () => {
    const file = new File([PNG], "shot.png", { type: "image/png" });
    const res = await makeApp(AGENT).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });
    expect(res.status).toBe(403);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(auditMock.logAuditEvent).not.toHaveBeenCalled();
  });

  it("returns 404 when the task does not exist", async () => {
    prismaMocks.taskFindUnique.mockResolvedValue(null);
    const file = new File([PNG], "shot.png", { type: "image/png" });
    const res = await makeApp(HUMAN).request("/tasks/missing/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });
    expect(res.status).toBe(404);
  });

  describe("per-task aggregate caps", () => {
    it("creates an attachment when below both the count and bytes caps (under-cap, 201)", async () => {
      // Project cap is 2; only 1 attachment exists and aggregate is small.
      prismaMocks.projectFindUnique.mockResolvedValue({ attachmentCountCap: 2, attachmentBytesCap: null });
      prismaMocks.attachmentCount.mockResolvedValue(1);
      prismaMocks.attachmentAggregate.mockResolvedValue({ _sum: { sizeBytes: 4 } });
      prismaMocks.attachmentCreate.mockResolvedValue({
        id: "att-2",
        taskId: "task-1",
        name: "shot2.png",
        url: "/uploads/uuid2.png",
        mimeType: "image/png",
        sizeBytes: PNG.byteLength,
        type: "IMAGE",
      });

      const file = new File([PNG], "shot2.png", { type: "image/png" });
      const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
        method: "POST",
        body: uploadForm(file),
      });

      expect(res.status).toBe(201);
      expect(prismaMocks.attachmentCreate).toHaveBeenCalledOnce();
    });

    it("returns 429 and does NOT create when the count cap is reached (at-cap)", async () => {
      // Project cap is 1; 1 attachment already exists — next POST must be rejected.
      prismaMocks.projectFindUnique.mockResolvedValue({ attachmentCountCap: 1, attachmentBytesCap: null });
      prismaMocks.attachmentCount.mockResolvedValue(1);

      const file = new File([PNG], "overflow.png", { type: "image/png" });
      const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
        method: "POST",
        body: uploadForm(file),
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/count cap/);
      expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
    });

    it("returns 413 and does NOT create when the bytes cap would be exceeded (at-cap)", async () => {
      // Project bytes cap is 10 bytes; 8 bytes already consumed, PNG is > 2 bytes → over cap.
      prismaMocks.projectFindUnique.mockResolvedValue({ attachmentCountCap: null, attachmentBytesCap: 10 });
      prismaMocks.attachmentCount.mockResolvedValue(1); // below count cap
      prismaMocks.attachmentAggregate.mockResolvedValue({ _sum: { sizeBytes: 8 } });

      const file = new File([PNG], "big.png", { type: "image/png" });
      const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
        method: "POST",
        body: uploadForm(file),
      });

      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/size cap/);
      expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
    });

    it("allows an upload that exactly fills the bytes cap (boundary, 201)", async () => {
      // existingSum 0 + PNG (10 bytes) === cap 10 → not over → allowed. Pins the
      // comparison as `>` (strictly over) rather than `>=`.
      prismaMocks.projectFindUnique.mockResolvedValue({ attachmentCountCap: null, attachmentBytesCap: PNG.byteLength });
      prismaMocks.attachmentCount.mockResolvedValue(0);
      prismaMocks.attachmentAggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });
      prismaMocks.attachmentCreate.mockResolvedValue({
        id: "att-boundary",
        taskId: "task-1",
        name: "exact.png",
        url: "/uploads/exact.png",
        mimeType: "image/png",
        sizeBytes: PNG.byteLength,
        type: "IMAGE",
      });

      const file = new File([PNG], "exact.png", { type: "image/png" });
      const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
        method: "POST",
        body: uploadForm(file),
      });

      expect(res.status).toBe(201);
      expect(prismaMocks.attachmentCreate).toHaveBeenCalledOnce();
    });

    it("treats a non-positive per-project cap as 'use the env default' (0 does not block)", async () => {
      // A per-project cap of 0 must fall back to the env defaults (20 / 50 MiB),
      // not block every upload. Existing usage is well below those defaults.
      prismaMocks.projectFindUnique.mockResolvedValue({ attachmentCountCap: 0, attachmentBytesCap: 0 });
      prismaMocks.attachmentCount.mockResolvedValue(1);
      prismaMocks.attachmentAggregate.mockResolvedValue({ _sum: { sizeBytes: 4 } });
      prismaMocks.attachmentCreate.mockResolvedValue({
        id: "att-zero-cap",
        taskId: "task-1",
        name: "ok.png",
        url: "/uploads/ok.png",
        mimeType: "image/png",
        sizeBytes: PNG.byteLength,
        type: "IMAGE",
      });

      const file = new File([PNG], "ok.png", { type: "image/png" });
      const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
        method: "POST",
        body: uploadForm(file),
      });

      expect(res.status).toBe(201);
      expect(prismaMocks.attachmentCreate).toHaveBeenCalledOnce();
    });
  });
});

describe("GET /tasks/:id/attachments/:attachmentId/raw", () => {
  it("streams an uploaded image inline with nosniff", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-1",
      taskId: "task-1",
      name: "shot.png",
      url: "/uploads/uuid.png",
      mimeType: "image/png",
      type: "IMAGE",
    });
    fsMocks.readFile.mockResolvedValue(Buffer.from(PNG));

    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-1/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; /);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("serves text with an attachment disposition", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-2",
      taskId: "task-1",
      name: "notes.txt",
      url: "/uploads/uuid.txt",
      mimeType: "text/plain",
      type: "DOCUMENT",
    });
    fsMocks.readFile.mockResolvedValue(Buffer.from("hi"));

    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-2/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("returns 404 for a URL-pointer attachment (no bytes on disk)", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-3",
      taskId: "task-1",
      name: "link",
      url: "https://example.com/x",
      type: "DOCUMENT",
    });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-3/raw");
    expect(res.status).toBe(404);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it("returns 404 when the attachment belongs to another task (IDOR guard)", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-1",
      taskId: "OTHER",
      url: "/uploads/uuid.png",
      type: "IMAGE",
    });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-1/raw");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the backing file is gone", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-1",
      taskId: "task-1",
      url: "/uploads/uuid.png",
      mimeType: "image/png",
      type: "IMAGE",
    });
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"));
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-1/raw");
    expect(res.status).toBe(404);
  });

  it("rejects an agent missing tasks:read with 403", async () => {
    const weak: Actor = { ...AGENT, scopes: ["tasks:update"] };
    const res = await makeApp(weak).request("/tasks/task-1/attachments/att-1/raw");
    expect(res.status).toBe(403);
    expect(prismaMocks.attachmentFindUnique).not.toHaveBeenCalled();
  });
});

describe("DELETE /tasks/:id/attachments/:attachmentId", () => {
  it("lets the uploader delete and unlinks the backing file", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-1",
      taskId: "task-1",
      url: "/uploads/uuid.png",
      createdByUserId: "user-1",
      name: "shot.png",
    });

    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(prismaMocks.attachmentDelete).toHaveBeenCalledWith({ where: { id: "att-1" } });
    expect(fsMocks.unlink).toHaveBeenCalledTimes(1);
    expect(auditMock.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.attachment.deleted" }),
    );
  });

  it("refuses a non-creator who is not a project admin (403)", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-1",
      taskId: "task-1",
      url: "/uploads/uuid.png",
      createdByUserId: "user-1",
    });
    accessMocks.hasProjectRole.mockResolvedValue(false);

    const res = await makeApp(OTHER_HUMAN).request("/tasks/task-1/attachments/att-1", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(prismaMocks.attachmentDelete).not.toHaveBeenCalled();
    expect(fsMocks.unlink).not.toHaveBeenCalled();
    expect(auditMock.logAuditEvent).not.toHaveBeenCalled();
  });

  it("lets a project admin delete someone else's attachment", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-1",
      taskId: "task-1",
      url: "/uploads/uuid.png",
      createdByUserId: "user-1",
    });
    accessMocks.hasProjectRole.mockResolvedValue(true);

    const res = await makeApp(OTHER_HUMAN).request("/tasks/task-1/attachments/att-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(prismaMocks.attachmentDelete).toHaveBeenCalled();
  });

  it("does not unlink for a URL-pointer attachment", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-9",
      taskId: "task-1",
      url: "https://example.com/x",
      createdByUserId: "user-1",
    });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-9", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(fsMocks.unlink).not.toHaveBeenCalled();
  });

  it("forbids agents from deleting (403)", async () => {
    const res = await makeApp(AGENT).request("/tasks/task-1/attachments/att-1", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(prismaMocks.attachmentDelete).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/attachments (URL pointer)", () => {
  it("rejects javascript: and data: URLs with 400", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4="]) {
      const res = await makeApp(HUMAN).request("/tasks/task-1/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", url }),
      });
      expect(res.status).toBe(400);
      expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
    }
  });

  it("accepts an https URL pointer and stores type DOCUMENT", async () => {
    prismaMocks.attachmentCreate.mockResolvedValue({ id: "p1", taskId: "task-1", type: "DOCUMENT" });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Doc", url: "https://example.com/doc" }),
    });
    expect(res.status).toBe(201);
    expect(prismaMocks.attachmentCreate.mock.calls[0]![0].data).toMatchObject({ type: "DOCUMENT" });
  });

  it("returns 429 and does NOT create when the count cap is reached for a URL pointer", async () => {
    // Project cap is 1; 1 attachment already exists — count-only check must block.
    prismaMocks.projectFindUnique.mockResolvedValue({ attachmentCountCap: 1, attachmentBytesCap: null });
    prismaMocks.attachmentCount.mockResolvedValue(1);

    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Extra link", url: "https://example.com/extra" }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/count cap/);
    expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
  });
});

describe("POST /tasks/:id/attachments/upload — body + failure handling", () => {
  it("returns 400 for a non-multipart body", async () => {
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ not: "multipart" }),
    });
    expect(res.status).toBe(400);
    expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
  });

  it("returns 413 via bodyLimit when the whole request exceeds the body cap", async () => {
    const huge = Buffer.alloc(ATTACHMENT_BODY_LIMIT_BYTES + 1, 0x61);
    const file = new File([huge], "huge.txt", { type: "text/plain" });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });
    expect(res.status).toBe(413);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    expect(prismaMocks.attachmentCreate).not.toHaveBeenCalled();
  });

  it("unlinks the orphan file when the metadata write fails", async () => {
    prismaMocks.attachmentCreate.mockRejectedValue(new Error("db down"));
    const file = new File([PNG], "shot.png", { type: "image/png" });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/upload", {
      method: "POST",
      body: uploadForm(file),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1);
    expect(fsMocks.unlink).toHaveBeenCalledWith(fsMocks.writeFile.mock.calls[0]![0]);
  });
});

describe("path-traversal safety at the route level", () => {
  it("GET raw returns 404 and reads nothing for a traversal url", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-x",
      taskId: "task-1",
      url: "/uploads/../secrets.env",
      mimeType: "image/png",
      type: "IMAGE",
      name: "x",
    });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-x/raw");
    expect(res.status).toBe(404);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it("DELETE removes the row but never unlinks an out-of-dir path", async () => {
    prismaMocks.attachmentFindUnique.mockResolvedValue({
      id: "att-x",
      taskId: "task-1",
      url: "/uploads/../secrets.env",
      createdByUserId: "user-1",
    });
    const res = await makeApp(HUMAN).request("/tasks/task-1/attachments/att-x", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(prismaMocks.attachmentDelete).toHaveBeenCalled();
    expect(fsMocks.unlink).not.toHaveBeenCalled();
  });
});

describe("DELETE /tasks/:id — attachment file cleanup", () => {
  it("unlinks uploaded files but not URL pointers when a task is deleted", async () => {
    prismaMocks.attachmentFindMany.mockResolvedValue([
      { url: "/uploads/a.png" },
      { url: "https://example.com/x" },
    ]);
    const res = await makeApp(HUMAN).request("/tasks/task-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(prismaMocks.taskDelete).toHaveBeenCalledWith({ where: { id: "task-1" } });
    expect(fsMocks.unlink).toHaveBeenCalledTimes(1);
  });
});
