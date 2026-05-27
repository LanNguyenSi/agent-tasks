# Notification webhooks

Push-delivery for the Signal layer. When a project sets
`notificationWebhookUrl`, every successful Signal create also POSTs the
payload to that URL — in addition to (not instead of) the existing
`task_pickup` polling channel.

The intended consumer is a small bridge that turns the POST into something
the agent's environment can react to (Triologue room post, Slack message,
file drop, …). The bridge is your code; this doc specifies what you
receive and what guarantees you get.

## When it fires

Every successful `createSignal` triggers a delivery attempt. That covers
all seven Signal types — see [events.md](events.md) and
[signal-payload-design.md](signal-payload-design.md) for the catalog.

## Configuration

> **Operator note (SSRF):** the URL is fetched server-side by the
> agent-tasks backend. It is validated for URL shape only — there is no
> denylist for loopback (`http://127.0.0.1/...`), link-local
> (`http://169.254.169.254/...`), or RFC1918 ranges. Only team admins
> can write this field, so this is a trust-the-operator surface, not an
> internet-facing one. If your deployment has agent-tasks on a network
> that can reach internal services you don't want it POSTing to, run it
> behind an egress firewall or block those CIDRs at the host level. A
> server-side denylist may be added in a future release.

PATCH the project to set the URL and (optionally) a signing secret:

```bash
curl -X PATCH https://agent-tasks.example/api/projects/$PROJECT_ID \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "notificationWebhookUrl": "https://bridge.example/agent-tasks",
    "notificationWebhookSecret": "your-shared-secret"
  }'
```

Clearing: pass `""` or `null` for either field. Empty string is the
convention the UI uses for "clear this".

The secret is **never** returned on read. `GET /projects/:id` returns
`hasNotificationWebhookSecret: boolean` so the UI can show "•••• (set)"
without us round-tripping the value. To rotate, PATCH a new value.

## Request shape

### Headers

```
Content-Type: application/json
User-Agent: agent-tasks-webhook/1
X-AgentTasks-Event: signal.<type>          // e.g. signal.review_needed
X-AgentTasks-Signal-Id: <signalId>          // for dedup
X-AgentTasks-Signature: sha256=<hex>        // iff secret is configured
```

### Body

```jsonc
{
  "signalId": "uuid",          // unique per Signal — use this to dedup
  "type": "review_needed",     // see signal-payload-design.md for the union
  "taskId": "uuid",
  "projectId": "uuid",
  "projectSlug": "agent-tasks",
  "recipientAgentId": "uuid|null",
  "recipientUserId": "uuid|null",
  "context": {
    "taskTitle": "Fix bug",
    "taskStatus": "review",
    "projectSlug": "agent-tasks",
    "projectName": "agent-tasks",
    "branchName": "feat/x",
    "prUrl": "https://github.com/owner/repo/pull/42",
    "prNumber": 42,
    "actor": { "type": "human", "name": "Lan" },
    "reviewComment": "Please add tests",
    "assigneeName": "Reviewer Bot"
  },
  "createdAt": "2026-05-27T12:00:00.000Z"
}
```

The `context` object follows the same `SignalContext` shape that the
polling channel returns — see [signal-payload-design.md](signal-payload-design.md)
for type-specific fields.

## Signature verification

When the project has a secret configured, the request carries an
`X-AgentTasks-Signature` header containing `sha256=<hex>` where `<hex>`
is HMAC-SHA256 of the raw request body with the secret as the key.

Reconstruct and constant-time-compare:

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyAgentTasksWebhook(rawBody, header, secret) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"),
  );
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
```

**Important:** use the raw bytes the server sent, not the JSON-parsed
object re-serialized — whitespace and key ordering would differ and the
signature would not match. Most frameworks let you capture the raw body
before JSON parsing (Express `express.raw()`, Hono `c.req.raw.text()`,
…).

## Delivery semantics

- **At most once per Signal in the happy path.** Failure → one retry
  after 2 seconds → give up. There is no DLQ in v1; if the retry also
  fails, the delivery is dropped (audited, never replayed).
- **Per-attempt timeout: 5 seconds.** Connect + receive must complete
  within 5s or the attempt counts as failed.
- **Best-effort, never blocking.** The originating API request that
  produced the Signal does NOT wait for delivery and is never failed
  because of webhook trouble. The `Signal` row exists in the DB
  regardless of delivery outcome — agents that also poll
  `task_pickup` will still see it.
- **At-most-once, not exactly-once.** Because the originating request
  succeeded but the delivery retry could have ALSO succeeded on the
  server side (you never sent an ack back), consumers MUST dedup on
  `signalId` to be safe. If you POST to a downstream that has its own
  retry semantics, you may receive the same signal twice.
- **Order is not guaranteed.** Different signals dispatch concurrently;
  retries reorder. If your consumer cares about ordering, sort by
  `createdAt` inside a polling window.

## Observability

Every attempt outcome is audit-logged:

- `signal.webhook_delivered` — success (2xx), with `attempts` (1 or 2)
  and `durationMs`.
- `signal.webhook_failed` — final give-up after the retry, with
  `statusCode?` (last HTTP status if we got one) and `errorMessage?`
  (network/timeout text otherwise).

Both rows carry `signalId` so you can correlate against the originating
Signal. Query via `GET /api/projects/:id/audit?actionPrefix=signal.webhook_`.

Repeated failures of one URL are a strong signal that the receiver is
down or misconfigured; nothing in agent-tasks auto-disables the URL,
but a `failed`-row count spike is the metric to alert on.

## Receiver checklist

- [ ] Accept POST, return 2xx within 5 seconds. Defer real work to a
      background queue if needed.
- [ ] Verify `X-AgentTasks-Signature` against the raw body if you set a
      secret. Reject otherwise.
- [ ] Dedup on `signalId` (set with 24h TTL is fine — the same Signal
      row will not be delivered twice except via the retry path; this
      guard protects you from the rare case where the server's 2xx ack
      was lost and the retry succeeded).
- [ ] Filter on `X-AgentTasks-Event` if you only want a subset.
- [ ] Log unexpected `type` values and continue — new Signal types may
      be added (see "Future candidates" in signal-payload-design.md).

## Out of scope (v1)

- Per-recipient subscription / multiple URLs per project — set a fanout
  proxy as the URL if you need this.
- Per-event-type opt-in — all seven types are delivered. Filter on
  `X-AgentTasks-Event` at the receiver.
- Persistent DLQ / multi-attempt backoff — single retry only.
- Inbound webhook acks (the receiver does NOT call back into agent-tasks
  to ack — receipt is implicit in the 2xx response).
