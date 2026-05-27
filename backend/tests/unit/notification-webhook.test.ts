/**
 * Tests for services/notification-webhook.ts — the outbound Signal push
 * delivery sidecar. Covers HMAC signing, retry on failure, audit logging
 * for both terminal outcomes, and the non-throwing contract.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockLogAuditEvent } = vi.hoisted(() => ({
  mockLogAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/audit.js", () => ({
  logAuditEvent: mockLogAuditEvent,
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import {
  deliverSignalWebhook,
  signWebhookBody,
  type DeliverSignalWebhookInput,
} from "../../src/services/notification-webhook.js";
import { createHmac } from "node:crypto";

const baseInput: DeliverSignalWebhookInput = {
  signalId: "sig-abc",
  signalType: "review_needed",
  taskId: "task-1",
  projectId: "proj-1",
  projectSlug: "agent-tasks",
  recipientAgentId: "agent-1",
  recipientUserId: null,
  context: {
    taskTitle: "Fix bug",
    taskStatus: "review",
    projectSlug: "agent-tasks",
    projectName: "agent-tasks",
    actor: { type: "agent", name: "Worker" },
  },
  createdAt: new Date("2026-05-27T12:00:00Z"),
  webhookUrl: "https://hooks.example/inbox",
};

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Fake timers so the 2s retry sleep doesn't actually wait in tests.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

function okResponse(status = 200) {
  return new Response("", { status });
}

describe("signWebhookBody", () => {
  it("produces a sha256= HMAC matching node:crypto", () => {
    const body = '{"signalId":"sig-abc"}';
    const secret = "shh";
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(signWebhookBody(body, secret)).toBe(expected);
  });

  it("produces different signatures for different secrets", () => {
    const body = '{"x":1}';
    expect(signWebhookBody(body, "a")).not.toBe(signWebhookBody(body, "b"));
  });
});

describe("deliverSignalWebhook — happy path", () => {
  it("POSTs JSON with the expected headers and 1 attempt on 2xx", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(202));

    await deliverSignalWebhook(baseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hooks.example/inbox");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["User-Agent"]).toBe("agent-tasks-webhook/1");
    expect(init.headers["X-AgentTasks-Event"]).toBe("signal.review_needed");
    expect(init.headers["X-AgentTasks-Signal-Id"]).toBe("sig-abc");
    expect(init.headers["X-AgentTasks-Signature"]).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      signalId: "sig-abc",
      type: "review_needed",
      taskId: "task-1",
      projectId: "proj-1",
      projectSlug: "agent-tasks",
      recipientAgentId: "agent-1",
      recipientUserId: null,
      context: expect.objectContaining({ taskTitle: "Fix bug" }),
      createdAt: "2026-05-27T12:00:00.000Z",
    });

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "signal.webhook_delivered",
        projectId: "proj-1",
        taskId: "task-1",
        payload: expect.objectContaining({
          signalId: "sig-abc",
          signalType: "review_needed",
          url: "https://hooks.example/inbox",
          statusCode: 202,
          attempts: 1,
        }),
      }),
    );
  });

  it("adds X-AgentTasks-Signature when the project has a secret", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(200));

    await deliverSignalWebhook({ ...baseInput, webhookSecret: "topsecret" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["X-AgentTasks-Signature"]).toBe(
      signWebhookBody(init.body as string, "topsecret"),
    );
  });
});

describe("deliverSignalWebhook — retry behavior", () => {
  it("retries once on 5xx and audits success when the retry succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(503))
      .mockResolvedValueOnce(okResponse(200));

    const promise = deliverSignalWebhook(baseInput);
    // Advance past the 2s retry-sleep.
    await vi.advanceTimersByTimeAsync(2_500);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "signal.webhook_delivered",
        payload: expect.objectContaining({ attempts: 2, statusCode: 200 }),
      }),
    );
  });

  it("audits webhook_failed after both attempts return non-2xx", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(500))
      .mockResolvedValueOnce(okResponse(503));

    const promise = deliverSignalWebhook(baseInput);
    await vi.advanceTimersByTimeAsync(2_500);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "signal.webhook_failed",
        payload: expect.objectContaining({
          attempts: 2,
          statusCode: 503,
        }),
      }),
    );
    // No `_delivered` audit on the failure path.
    expect(mockLogAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "signal.webhook_delivered" }),
    );
  });

  it("retries on network error then audits failed if both throw", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const promise = deliverSignalWebhook(baseInput);
    await vi.advanceTimersByTimeAsync(2_500);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "signal.webhook_failed",
        payload: expect.objectContaining({
          attempts: 2,
          errMessage: "ETIMEDOUT",
        }),
      }),
    );
  });
});

describe("deliverSignalWebhook — non-throwing contract", () => {
  it("never throws when fetch itself rejects on both attempts", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));

    const promise = deliverSignalWebhook(baseInput);
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(promise).resolves.toBeUndefined();
  });

  it("never throws when the audit write itself rejects", async () => {
    fetchMock.mockResolvedValueOnce(okResponse(200));
    mockLogAuditEvent.mockImplementationOnce(() => {
      throw new Error("audit blown up");
    });

    // logAuditEvent is voided in the implementation, so a throw here is a
    // bug in the implementation rather than something we need to swallow.
    // The contract is: caller of deliverSignalWebhook does not see it.
    await expect(deliverSignalWebhook(baseInput)).resolves.toBeUndefined();
  });
});
