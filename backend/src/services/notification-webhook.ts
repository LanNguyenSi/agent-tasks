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
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
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

// ── SSRF egress guard ────────────────────────────────────────────────────────
//
// The webhook URL is project-admin-configured, so a careless or malicious admin
// could point delivery at an internal service or the cloud metadata endpoint
// (169.254.169.254). Before sending we reject any URL whose host is, or
// resolves to, a private / loopback / link-local / metadata address, and we
// refuse to follow redirects (a public URL must not 3xx into an internal one).
//
// Residual: this resolves-then-connects, so a DNS-rebinding attacker who flips
// the record between the check and the connect is not fully blocked — a narrow
// attack against an already-privileged admin input; closing it needs a
// pinned-IP dispatcher (follow-up).

function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return true; // unparseable → treat as unsafe
  const octets = m.slice(1).map((n) => Number(n));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
  return false;
}

// Extract the IPv4 embedded in an IPv4-mapped (`::ffff:a.b.c.d`), NAT64
// (`64:ff9b::a.b.c.d`), or IPv4-translated (`::ffff:0:a.b.c.d`) IPv6 address.
// Critically, `new URL()` normalizes a bracketed mapped literal to the
// COMPRESSED HEX form (e.g. `[::ffff:169.254.169.254]` -> `::ffff:a9fe:a9fe`,
// `[::ffff:127.0.0.1]` -> `::ffff:7f00:1`), so matching only the dotted-quad
// form leaves a metadata/loopback bypass — we must also decode the trailing two
// hextets. Returns null when there is no embedded IPv4. The prefix anchors keep
// this from firing on an arbitrary v6 that merely ends in two hextets.
function embeddedIPv4(v6: string): string | null {
  const dotted = v6.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) return dotted[1];
  // The bare `::` prefix also covers the deprecated IPv4-compatible `::a.b.c.d`
  // form (`[::169.254.169.254]` normalizes to `::a9fe:a9fe`); `::/96` is
  // reserved space, so decoding its low 32 bits can only ever over-block.
  const hex = v6.match(/^(?:::ffff:|::ffff:0:|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** True for any address an outbound webhook must NOT be allowed to reach. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) {
    const v6 = ip.toLowerCase();
    const v4 = embeddedIPv4(v6);
    if (v4) return isPrivateIPv4(v4);
    if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
    if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(v6)) return true; // fc00::/7 unique-local
    if (/^ff/.test(v6)) return true; // ff00::/8 multicast
    return false;
  }
  return true; // not a valid IP literal → unsafe
}

/**
 * Reject a webhook URL whose scheme is not http(s), or whose host is / resolves
 * to a non-public address. Throws a descriptive error; the caller turns the
 * throw into a failed (un-sent) delivery attempt.
 */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("webhook URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`webhook scheme not allowed: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Operator opt-in: a self-hosted deployment may legitimately target an
  // internal host. WEBHOOK_ALLOWED_PRIVATE_HOSTS is a comma-separated allowlist
  // of exact hostnames/IPs that bypass the private-address rejection. Empty by
  // default, so the guard is fully on unless an operator opts a host in.
  const allowlist = (process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.includes(host.toLowerCase())) {
    return;
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`webhook host is a private address: ${host}`);
    }
    return;
  }

  const records = await dnsLookup(host, { all: true });
  if (records.length === 0) {
    throw new Error(`webhook host did not resolve: ${host}`);
  }
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new Error(`webhook host resolves to a private address: ${host} -> ${address}`);
    }
  }
}

async function attemptDelivery(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<AttemptResult> {
  try {
    await assertPublicWebhookUrl(url);
  } catch (err) {
    // SSRF egress guard rejected the target — never send.
    return { ok: false, errorMessage: (err as Error).message };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Never follow redirects: a public URL must not bounce the request into
      // an internal host. undici rejects the fetch promise on a 3xx, which we
      // treat as a failed attempt.
      redirect: "error",
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
    // Loop always runs ≥1 iteration; `last` is assigned before any read.
    let last!: AttemptResult;

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
        // `errMessage` matches the house style used by services/audit.ts
        // and the safeWarn payload above. Receivers that grep audit JSON
        // can rely on a single key name across both log + audit surfaces.
        errMessage: last.errorMessage,
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
