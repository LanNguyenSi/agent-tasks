import { Hono } from "hono";
import {
  verifyWebhookSignature,
  handleIssuesEvent,
  handlePullRequestEvent,
  updateProjectSyncAt,
  type GitHubIssuePayload,
  type GitHubPullRequestPayload,
} from "../services/github-webhook.js";

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";

export const webhookRouter = new Hono();

webhookRouter.post("/github", async (c) => {
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const event = c.req.header("X-GitHub-Event") ?? "";
  const rawBody = await c.req.text();

  // Verify signature if secret is configured
  if (WEBHOOK_SECRET && !verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRET)) {
    return c.json({ error: "unauthorized", message: "Invalid webhook signature" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON payload" }, 400);
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

        default:
          // Unknown event — silently ignore
          break;
      }
    } catch (err) {
      console.error(`[webhook] Error processing ${event} event:`, err);
    }
  })();

  return c.json({ received: true, event });
});
