/**
 * End-to-end wire-format test for the outbound Signal notification webhook.
 *
 * notification-webhook.test.ts covers the delivery sidecar with a mocked
 * fetch. This drives the full createSignal -> maybeDeliverSignalWebhook ->
 * deliverSignalWebhook path with REAL fetch against an in-process
 * node:http server, so a contract drift in the HTTP method, headers, body
 * shape, or HMAC encoding (the wire format social/automation receivers
 * actually consume) fails CI instead of landing silently.
 *
 * Prisma is mocked (no DB): signal.create returns a fixed row and
 * project.findUnique points the webhook URL at the test server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

const { mockSignalCreate, mockProjectFindUnique, mockLogAuditEvent } = vi.hoisted(() => ({
  mockSignalCreate: vi.fn(),
  mockProjectFindUnique: vi.fn(),
  mockLogAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    signal: { create: mockSignalCreate },
    project: { findUnique: mockProjectFindUnique },
  },
}));
vi.mock("../../src/services/audit.js", () => ({ logAuditEvent: mockLogAuditEvent }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { createSignal, type SignalContext } from "../../src/services/signal.js";
import { signWebhookBody } from "../../src/services/notification-webhook.js";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

const WEBHOOK_SECRET = "whsec_test_0123456789abcdef";
const SIGNAL_CREATED_AT = new Date("2026-06-15T00:00:00.000Z");

const context: SignalContext = {
  taskTitle: "Render policy_decisions bucket",
  taskStatus: "review",
  projectSlug: "agent-tasks",
  projectName: "agent-tasks",
  actor: { type: "agent", name: "Worker" },
};

describe("notification webhook — e2e against a real HTTP server", () => {
  let server: Server;
  let baseUrl: string;
  let received: Promise<CapturedRequest>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // The SSRF egress guard blocks loopback by default; this e2e binds a real
    // server on 127.0.0.1, so opt that host in explicitly (as a self-hoster would).
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
    let resolveReceived!: (r: CapturedRequest) => void;
    received = new Promise<CapturedRequest>((resolve) => {
      resolveReceived = resolve;
    });

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        // Reply 2xx so delivery succeeds on the first attempt (no retry).
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        resolveReceived({
          method: req.method,
          url: req.url,
          headers: req.headers,
          rawBody: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
    // Close the server so the port handle does not leak across tests.
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers a review_needed signal with the documented wire format", async () => {
    const signalId = "sig-e2e-1";
    const taskId = "task-e2e-1";
    const projectId = "proj-e2e-1";
    const webhookPath = "/hooks/agent-tasks";

    mockSignalCreate.mockResolvedValue({
      id: signalId,
      type: "review_needed",
      taskId,
      projectId,
      recipientAgentId: "agent-9",
      recipientUserId: null,
      context,
      createdAt: SIGNAL_CREATED_AT,
    });
    mockProjectFindUnique.mockResolvedValue({
      slug: "agent-tasks",
      notificationWebhookUrl: `${baseUrl}${webhookPath}`,
      notificationWebhookSecret: WEBHOOK_SECRET,
    });

    await createSignal({
      type: "review_needed",
      taskId,
      projectId,
      recipientAgentId: "agent-9",
      context,
    });

    // Delivery is fire-and-forget; await the request the server captured.
    // Clear the watchdog once the race settles so it can neither fire late
    // nor reject an already-settled promise.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const req = await Promise.race([
      received,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("webhook not received within 4s")), 4_000);
      }),
    ]).finally(() => clearTimeout(watchdog));

    // Method + path
    expect(req.method).toBe("POST");
    expect(req.url).toBe(webhookPath);

    // Headers (node lowercases header names)
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["user-agent"]).toBe("agent-tasks-webhook/1");
    expect(req.headers["x-agenttasks-event"]).toBe("signal.review_needed");
    expect(req.headers["x-agenttasks-signal-id"]).toBe(signalId);
    // Signature matches HMAC over the EXACT bytes the receiver got.
    expect(req.headers["x-agenttasks-signature"]).toBe(signWebhookBody(req.rawBody, WEBHOOK_SECRET));
    expect(req.headers["x-agenttasks-signature"]).toBe(
      `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(req.rawBody).digest("hex")}`,
    );
    // Pin the X-AgentTasks-* header set exactly so a stray/leaked custom
    // header gets the same drift coverage the body key-set has.
    expect(
      Object.keys(req.headers)
        .filter((h) => h.startsWith("x-agenttasks-"))
        .sort(),
    ).toEqual(["x-agenttasks-event", "x-agenttasks-signal-id", "x-agenttasks-signature"]);

    // Body: exactly the documented key set, no more, no less.
    const body = JSON.parse(req.rawBody);
    expect(Object.keys(body).sort()).toEqual(
      [
        "context",
        "createdAt",
        "projectId",
        "projectSlug",
        "recipientAgentId",
        "recipientUserId",
        "signalId",
        "taskId",
        "type",
      ],
    );
    expect(body).toMatchObject({
      signalId,
      type: "review_needed",
      taskId,
      projectId,
      projectSlug: "agent-tasks",
      recipientAgentId: "agent-9",
      recipientUserId: null,
      context,
    });
    // createdAt is ISO-8601 (round-trips through Date unchanged).
    expect(body.createdAt).toBe(SIGNAL_CREATED_AT.toISOString());
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
  }, 10_000);
});
