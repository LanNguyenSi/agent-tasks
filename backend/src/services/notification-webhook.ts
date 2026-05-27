/**
 * Outbound Signal Webhook Delivery
 *
 * Push-delivery sidecar for the Signal layer. When a project has
 * `notificationWebhookUrl` configured, every successful Signal create
 * (see services/signal.ts) fires `deliverSignalWebhook` asynchronously.
 *
 * Semantics:
 *   - Best-effort. Never throws, never blocks the originating request.
 *   - At most one retry on non-2xx / network error / timeout, after 2s.
 *   - Per-attempt timeout 5s.
 *   - HMAC-SHA256 signature header iff project has a secret configured.
 *   - Both success and final failure are audited.
 *
 * Receiver contract is described in docs/notification-webhooks.md.
 */
import { createHmac } from "node:crypto";
import { logger } from "../lib/logger.js";
import { logAuditEvent } from "./audit.js";
import type { SignalContext, SignalType } from "./signal.js";

const TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 2_000;
const USER_AGENT = "agent-tasks-webhook/1";

export interface WebhookSignalPayload {
  signalId: string;
  type: SignalType;
  taskId: string;
  projectId: string;
  projectSlug: string;
  recipientAgentId: string | null;
  recipientUserId: string | null;
  context: SignalContext;
  createdAt: string; // ISO-8601
}

export interface DeliverSignalWebhookInput {
  signalId: string;
  signalType: SignalType;
  taskId: string;
  projectId: string;
  projectSlug: string;
  recipientAgentId: string | null;
  recipientUserId: string | null;
  context: SignalContext;
  createdAt: Date;
  webhookUrl: string;
  webhookSecret?: string | null;
}

interface AttemptResult {
  ok: boolean;
  statusCode?: number;
  errorMessage?: string;
}

/**
 * Compute HMAC-SHA256 over the raw body using the project's secret.
 * Receivers should reconstruct this and constant-time-compare against
 * the `X-AgentTasks-Signature` header value (after stripping `sha256=`).
 */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function attemptDelivery(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<AttemptResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Drain the body so the connection can be reused/closed cleanly.
    // We don't act on the response content beyond the status code.
    try {
      await res.text();
    } catch {
      // ignore drain errors
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, statusCode: res.status };
    }
    return { ok: false, statusCode: res.status };
  } catch (err) {
    return { ok: false, errorMessage: (err as Error).message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deliver a single Signal payload to the project's notification webhook.
 *
 * Fire-and-forget by convention: the caller voids the returned promise.
 * The function never throws — internal failures (including synchronous
 * throws from the audit/logger layer) are swallowed so a misbehaving
 * sidecar can never corrupt the originating Signal-create request.
 */
export async function deliverSignalWebhook(input: DeliverSignalWebhookInput): Promise<void> {
  try {
    const payload: WebhookSignalPayload = {
      signalId: input.signalId,
      type: input.signalType,
      taskId: input.taskId,
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      recipientAgentId: input.recipientAgentId,
      recipientUserId: input.recipientUserId,
      context: input.context,
      createdAt: input.createdAt.toISOString(),
    };
    const body = JSON.stringify(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-AgentTasks-Event": `signal.${input.signalType}`,
      "X-AgentTasks-Signal-Id": input.signalId,
    };
    if (input.webhookSecret) {
      headers["X-AgentTasks-Signature"] = signWebhookBody(body, input.webhookSecret);
    }

    const startedAt = Date.now();
    let attempts = 0;
    let last: AttemptResult = { ok: false, errorMessage: "no attempt made" };

    for (let i = 0; i < 2; i++) {
      attempts++;
      last = await attemptDelivery(input.webhookUrl, headers, body);
      if (last.ok) break;
      if (i === 0) await sleep(RETRY_DELAY_MS);
    }

    const durationMs = Date.now() - startedAt;

    if (last.ok) {
      safeAudit({
        action: "signal.webhook_delivered",
        projectId: input.projectId,
        taskId: input.taskId,
        payload: {
          signalId: input.signalId,
          signalType: input.signalType,
          url: input.webhookUrl,
          statusCode: last.statusCode,
          attempts,
          durationMs,
        },
      });
      return;
    }

    safeWarn(
      {
        component: "notification-webhook",
        signalId: input.signalId,
        signalType: input.signalType,
        projectId: input.projectId,
        url: input.webhookUrl,
        attempts,
        statusCode: last.statusCode,
        errMessage: last.errorMessage,
      },
      "signal webhook delivery failed after retry",
    );
    safeAudit({
      action: "signal.webhook_failed",
      projectId: input.projectId,
      taskId: input.taskId,
      payload: {
        signalId: input.signalId,
        signalType: input.signalType,
        url: input.webhookUrl,
        statusCode: last.statusCode,
        errorMessage: last.errorMessage,
        attempts,
        durationMs,
      },
    });
  } catch {
    // Outermost guard: even if construction of the payload throws (e.g.
    // a JSON.stringify cycle on context), we eat the error so the
    // void-caller contract is preserved.
  }
}

// `logAuditEvent` is documented as fire-and-forget, but `void` only
// swallows promise rejections — a synchronous throw inside the function
// still escapes. Wrap to handle both modes uniformly.
function safeAudit(args: Parameters<typeof logAuditEvent>[0]): void {
  try {
    void logAuditEvent(args);
  } catch {
    // ignore — audit is supplementary, must not crash delivery
  }
}

function safeWarn(obj: Record<string, unknown>, msg: string): void {
  try {
    logger.warn(obj, msg);
  } catch {
    // ignore — a broken logger must not crash delivery
  }
}
