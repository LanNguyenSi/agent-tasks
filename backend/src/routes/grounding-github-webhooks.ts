import { Hono } from "hono";
import { verifyWebhookSignature } from "../services/github-webhook.js";
import { GroundingGithubWebhookError, type GroundingGithubWebhookService } from "../services/grounding-github-webhook.js";
import { GroundingAccessError } from "../services/grounding-context.js";

/** Configured router only; the legacy exported webhookRouter stays dormant or active at its caller's choice. */
export function createGroundingGithubWebhookRouter(options: { service: Pick<GroundingGithubWebhookService, "handle">; secret?: string; requireSecret?: boolean }) {
  const router = new Hono();
  const secret = options.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const requireSecret = options.requireSecret ?? process.env.NODE_ENV === "production";
  router.post("/github", async c => {
    const rawBody = await c.req.text();
    const signature = c.req.header("X-Hub-Signature-256") ?? null;
    if ((!secret && requireSecret) || (secret && !verifyWebhookSignature(rawBody, signature, secret))) return c.json({ error: "unauthorized", message: "Invalid or missing webhook signature" }, 401);
    try {
      const result = await options.service.handle({ deliveryId: c.req.header("X-GitHub-Delivery") ?? "", event: c.req.header("X-GitHub-Event") ?? "", rawBody });
      return c.json(result);
    } catch (error) {
      if (error instanceof GroundingGithubWebhookError) return c.json({ error: error.code }, error.status);
      if (error instanceof GroundingAccessError) return c.json({ error: error.code }, error.status);
      return c.json({ error: "grounding_webhook_pending" }, 503);
    }
  });
  return router;
}
