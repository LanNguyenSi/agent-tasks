/**
 * Route-wiring tests for POST /github (webhookRouter). Focused on the
 * delivery-id dedup wiring added for M2:
 * - first delivery (claim → true) dispatches the handler and returns
 *   { received, event }.
 * - duplicate delivery (claim → false) returns { received, event,
 *   duplicate: true } and does NOT dispatch.
 * - a request with no X-GitHub-Delivery header skips the claim entirely and
 *   still dispatches (defensive fallthrough).
 *
 * The handler logic itself is covered by webhook-handlers.test.ts; the helper
 * branches by webhook-idempotency.test.ts. This file asserts the route maps
 * the claim result to dispatch/skip correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const webhookMocks = vi.hoisted(() => ({
  claimWebhookDelivery: vi.fn(),
  handlePullRequestEvent: vi.fn().mockResolvedValue(undefined),
  handleIssuesEvent: vi.fn().mockResolvedValue(undefined),
  handlePullRequestReviewEvent: vi.fn().mockResolvedValue(undefined),
  updateProjectSyncAt: vi.fn().mockResolvedValue(undefined),
  verifyWebhookSignature: vi.fn().mockReturnValue(true),
}));

vi.mock("../../src/services/github-webhook.js", () => webhookMocks);

vi.mock("../../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { webhookRouter } from "../../src/routes/webhooks.js";

// Flush the fire-and-forget dispatch IIFE (it awaits a mocked handler that
// resolves immediately, so one macrotask turn is enough).
const flushDispatch = () => new Promise((resolve) => setImmediate(resolve));

const PR_BODY = JSON.stringify({
  action: "closed",
  pull_request: { number: 1, title: "x", html_url: "https://github.com/o/r/pull/1", merged: true },
  repository: { full_name: "o/r" },
});

function post(headers: Record<string, string>, body = PR_BODY) {
  return webhookRouter.request("/github", { method: "POST", headers, body });
}

beforeEach(() => {
  vi.clearAllMocks();
  webhookMocks.verifyWebhookSignature.mockReturnValue(true);
  webhookMocks.handlePullRequestEvent.mockResolvedValue(undefined);
});

describe("POST /github delivery-id dedup wiring", () => {
  it("first delivery (claim → true) dispatches the handler and returns received", async () => {
    webhookMocks.claimWebhookDelivery.mockResolvedValue(true);

    const res = await post({
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "delivery-1",
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, event: "pull_request" });
    expect(webhookMocks.claimWebhookDelivery).toHaveBeenCalledWith("delivery-1", "pull_request");

    await flushDispatch();
    expect(webhookMocks.handlePullRequestEvent).toHaveBeenCalledTimes(1);
  });

  it("duplicate delivery (claim → false) returns duplicate:true and does NOT dispatch", async () => {
    webhookMocks.claimWebhookDelivery.mockResolvedValue(false);

    const res = await post({
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "delivery-1",
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, event: "pull_request", duplicate: true });

    await flushDispatch();
    expect(webhookMocks.handlePullRequestEvent).not.toHaveBeenCalled();
  });

  it("missing X-GitHub-Delivery header skips the claim and still dispatches", async () => {
    webhookMocks.claimWebhookDelivery.mockResolvedValue(true);

    const res = await post({
      "X-GitHub-Event": "pull_request",
      "Content-Type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, event: "pull_request" });
    expect(webhookMocks.claimWebhookDelivery).not.toHaveBeenCalled();

    await flushDispatch();
    expect(webhookMocks.handlePullRequestEvent).toHaveBeenCalledTimes(1);
  });
});
