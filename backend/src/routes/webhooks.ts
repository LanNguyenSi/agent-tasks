import { Hono } from "hono";
import {
  verifyWebhookSignature,
  handleIssuesEvent,
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  updateProjectSyncAt,
  claimWebhookDelivery,
  type GitHubIssuePayload,
  type GitHubPullRequestPayload,
  type GitHubPullRequestReviewPayload,
} from "../services/github-webhook.js";
import { logger } from "../lib/logger.js";

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const REQUIRE_WEBHOOK_SECRET = process.env.NODE_ENV === "production";

export const webhookRouter = new Hono();

webhookRouter.post("/github", async (c) => {
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const event = c.req.header("X-GitHub-Event") ?? "";
  const rawBody = await c.req.text();

  if (!WEBHOOK_SECRET) {
    if (REQUIRE_WEBHOOK_SECRET) {
      // In production: reject all unsigned payloads
      logger.error({ component: "webhook" }, "GITHUB_WEBHOOK_SECRET is not configured — rejecting request");
      return c.json({ error: "unauthorized", message: "Webhook secret not configured" }, 401);
    }
    // In development: warn and proceed (allows testing without secret)
    logger.warn({ component: "webhook" }, "GITHUB_WEBHOOK_SECRET not set — accepting unsigned payload (dev mode)");
  } else if (!verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRET)) {
    return c.json({ error: "unauthorized", message: "Invalid webhook signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON payload" }, 400);
  }

  // Dedup by GitHub delivery id (X-GitHub-Delivery). Claim before dispatch so
  // a concurrent or retried redelivery is blocked at the DB unique constraint
  // rather than dispatching a second time. Claiming happens after signature
  // verification so a forged/unsigned request cannot poison the dedup table.
  // Semantics are at-most-once: the claim is never released, so a delivery
  // whose dispatch fails is not auto-reprocessed (the handlers are not
  // idempotent — see claimWebhookDelivery). Real GitHub always sends this
  // header; the null branch is a defensive fallthrough without dedup.
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? null;

  if (deliveryId) {
    const fresh = await claimWebhookDelivery(deliveryId, event);
    if (!fresh) {
      logger.info(
        { component: "webhook", deliveryId, event },
        "duplicate webhook delivery — skipping",
      );
      return c.json({ received: true, event, duplicate: true });
    }
  }

  // Handle events asynchronously — respond immediately to GitHub (10s timeout)
  void (async () => {
    try {
      switch (event) {
        case "ping":
          // GitHub sends ping on webhook setup — just acknowledge
          break;

        case "push": {
          const p = payload as { repository?: { full_name?: string } };
          if (p.repository?.full_name) {
            await updateProjectSyncAt(p.repository.full_name);
          }
          break;
        }

        case "issues":
          await handleIssuesEvent(payload as GitHubIssuePayload);
          break;

        case "pull_request":
          await handlePullRequestEvent(payload as GitHubPullRequestPayload);
          break;

        case "pull_request_review":
          await handlePullRequestReviewEvent(payload as GitHubPullRequestReviewPayload);
          break;

        default:
          // Unknown event — silently ignore
          break;
      }
    } catch (err) {
      // The delivery stays claimed (at-most-once): re-running a partially
      // applied, non-idempotent handler would double-apply side effects. The
      // failed delivery is surfaced here for operator follow-up instead.
      logger.error(
        { err, errMessage: err instanceof Error ? err.message : String(err), component: "webhook", event, deliveryId },
        "error processing webhook event (delivery stays claimed, not reprocessed)",
      );
    }
  })();

  return c.json({ received: true, event });
});
