/**
 * Tests for services/notification-webhook.ts — the outbound Signal push
 * delivery sidecar. Covers HMAC signing, retry on failure, audit logging
 * for both terminal outcomes, the non-throwing contract, and the SSRF egress
 * guard.
 *
 * Delivery goes through `guardedFetch` (lib/egress-guard.ts), a real node:http
 * client, not the global fetch. A global-fetch mock would therefore never see
 * the request, so the delivery cases below drive the real path against an
 * in-process node:http server on 127.0.0.1, opting that host in through
 * WEBHOOK_ALLOWED_PRIVATE_HOSTS exactly as a self-hosted receiver would, and
 * read the audited outcome back. The egress-guard unit tests
 * (tests/unit/egress-guard.test.ts) cover the guard's address classification.
 */
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";

const { mockLogAuditEvent, dnsLookupMock } = vi.hoisted(() => ({
  mockLogAuditEvent: vi.fn().mockResolvedValue(undefined),
  dnsLookupMock: vi.fn(),
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

// guardedFetch's connect-time checking `lookup` and assertPublicUrl's
// resolve-then-check both go through node:dns/promises.lookup.
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));

import {
  deliverSignalWebhook,
  signWebhookBody,
  isPrivateAddress,
  assertPublicWebhookUrl,
  type DeliverSignalWebhookInput,
} from "../../src/services/notification-webhook.js";

const PUBLIC = "93.184.216.34";
const RESPONSE_MAX_BYTES = 64 * 1024;

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

// ── delivery harness: a real server guardedFetch can reach ───────────────────

interface Hit {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let port = 0;
let hits: Hit[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;

function buildInput(overrides: Partial<DeliverSignalWebhookInput> = {}): DeliverSignalWebhookInput {
  return { ...baseInput, webhookUrl: `http://127.0.0.1:${port}/inbox`, ...overrides };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      hits.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([{ address: PUBLIC, family: 4 }]);
  hits = [];
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  };
});

afterEach(() => {
  delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
});

function lastAuditPayload(): Record<string, unknown> {
  const call = mockLogAuditEvent.mock.calls.at(-1);
  return (call?.[0] as { payload: Record<string, unknown> }).payload;
}

function audited(action: string): Record<string, unknown>[] {
  return mockLogAuditEvent.mock.calls
    .map((c) => c[0] as { action: string; payload: Record<string, unknown> })
    .filter((a) => a.action === action)
    .map((a) => a.payload);
}

/**
 * Run a delivery on the faked clock (the timer names below install fake timers
 * per test): the 2 s retry sleep and the 5 s per-attempt budget run in virtual
 * time, so a retry costs no wall-clock time. Virtual time advances in 50 ms
 * steps and each step first yields one real event-loop tick, so real socket I/O
 * with the in-process test server still progresses between the steps.
 */
async function deliver(input: DeliverSignalWebhookInput): Promise<void> {
  let settled = false;
  const settle = () => {
    settled = true;
  };
  const delivery = deliverSignalWebhook(input).then(settle, settle);
  for (let advanced = 0; advanced < 60_000 && !settled; advanced += 50) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(50);
  }
  await delivery;
}

function useFakedTimeoutTimers(): void {
  // Only the two timer functions the sender uses; Date.now and setImmediate
  // stay real, so durationMs and the socket I/O above behave normally.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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

describe("deliverSignalWebhook: happy path (real guardedFetch path)", () => {
  beforeEach(() => {
    // guardedFetch blocks loopback by default; opt the test host in as a
    // self-hosted receiver would.
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
  });

  it("POSTs JSON with the expected headers and 1 attempt on 2xx", async () => {
    handler = (_req, res) => {
      res.writeHead(202);
      res.end("{}");
    };

    await deliverSignalWebhook(buildInput());

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.url).toBe("/inbox");
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.headers["user-agent"]).toBe("agent-tasks-webhook/1");
    expect(hit.headers["x-agenttasks-event"]).toBe("signal.review_needed");
    expect(hit.headers["x-agenttasks-signal-id"]).toBe("sig-abc");
    expect(hit.headers["x-agenttasks-signature"]).toBeUndefined();
    // The sender adds no other X-AgentTasks-* header.
    expect(
      Object.keys(hit.headers)
        .filter((h) => h.startsWith("x-agenttasks-"))
        .sort(),
    ).toEqual(["x-agenttasks-event", "x-agenttasks-signal-id"]);

    const body = JSON.parse(hit.body);
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

    expect(audited("signal.webhook_delivered")).toEqual([
      expect.objectContaining({
        signalId: "sig-abc",
        signalType: "review_needed",
        url: `http://127.0.0.1:${port}/inbox`,
        statusCode: 202,
        attempts: 1,
      }),
    ]);
  });

  it("adds X-AgentTasks-Signature when the project has a secret", async () => {
    await deliverSignalWebhook(buildInput({ webhookSecret: "topsecret" }));

    const hit = hits[0]!;
    expect(hit.headers["x-agenttasks-signature"]).toBe(
      signWebhookBody(hit.body, "topsecret"),
    );
    expect(hit.headers["x-agenttasks-signature"]).toBe(
      `sha256=${createHmac("sha256", "topsecret").update(hit.body).digest("hex")}`,
    );
  });
});

describe("deliverSignalWebhook — retry behavior", () => {
  beforeEach(() => {
    useFakedTimeoutTimers();
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once on 5xx and audits success when the retry succeeds", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(503);
        res.end("busy");
      } else {
        res.writeHead(200);
        res.end("{}");
      }
    };

    await deliver(buildInput());

    expect(hits).toHaveLength(2);
    expect(audited("signal.webhook_delivered")).toEqual([
      expect.objectContaining({ attempts: 2, statusCode: 200 }),
    ]);
  });

  it("audits webhook_failed after both attempts return non-2xx", async () => {
    handler = (_req, res) => {
      res.writeHead(503);
      res.end("busy");
    };

    await deliver(buildInput());

    expect(hits).toHaveLength(2);
    // The whole audit event, not only its payload.
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "signal.webhook_failed",
        projectId: "proj-1",
        taskId: "task-1",
      }),
    );
    expect(audited("signal.webhook_failed")).toEqual([
      expect.objectContaining({ attempts: 2, statusCode: 503 }),
    ]);
    expect(audited("signal.webhook_delivered")).toHaveLength(0);
  });

  it("audits the LAST attempt's error as the final errMessage", async () => {
    // First attempt answers 503 (a status failure, no errMessage), the second
    // never delivers a response (the socket is destroyed), so only the second
    // attempt produces an error text and it is the one that gets audited.
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(503);
        res.end("busy");
      } else {
        res.socket?.destroy();
      }
    };

    await deliver(buildInput());

    expect(hits).toHaveLength(2);
    const [failed] = audited("signal.webhook_failed");
    expect(failed).toMatchObject({ attempts: 2 });
    expect(failed?.statusCode).toBeUndefined();
    expect(String(failed?.errMessage)).toMatch(/ECONNRESET|socket hang up/);
  });

  it("retries on a transport error then audits failed if both fail, and never throws", async () => {
    // 127.0.0.1 is allowlisted, so the guard lets the address through; nothing
    // listens on port 1, so every attempt fails fast with a transport error
    // (ECONNREFUSED) instead of a status code.
    await expect(deliver(buildInput({ webhookUrl: "http://127.0.0.1:1/inbox" }))).resolves.toBeUndefined();

    const [failed] = audited("signal.webhook_failed");
    expect(failed).toMatchObject({ attempts: 2 });
    // The audit names why: a transport error text, never empty.
    expect(typeof failed?.errMessage).toBe("string");
    expect(String(failed?.errMessage).length).toBeGreaterThan(0);
  });

  it("reduces a raw transport error to its code: no IP address, no port", async () => {
    // A Node transport error quotes what it failed to connect to ("connect
    // ECONNREFUSED 127.0.0.1:1"; a TLS error quotes certificate altnames), so
    // only the error code may reach the audit, never the address or the port.
    await deliver(buildInput({ webhookUrl: "http://127.0.0.1:1/inbox" }));

    const [failed] = audited("signal.webhook_failed");
    expect(failed).toMatchObject({ attempts: 2 });
    const errMessage = String(failed?.errMessage);
    expect(errMessage).toContain("ECONNREFUSED");
    expect(errMessage).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(errMessage).not.toMatch(/:\d+/);
  });

  it("treats a 4xx answer as a failed attempt, retried once", async () => {
    handler = (_req, res) => {
      res.writeHead(422);
      res.end("no");
    };

    await deliver(buildInput());

    expect(hits).toHaveLength(2);
    expect(audited("signal.webhook_failed")).toEqual([
      expect.objectContaining({ attempts: 2, statusCode: 422 }),
    ]);
    expect(audited("signal.webhook_delivered")).toHaveLength(0);
  });

  it("counts a timeout as a failed attempt after the per-attempt budget", async () => {
    handler = () => {
      /* never respond, guardedFetch aborts at TIMEOUT_MS (5 s) */
    };

    const delivery = deliverSignalWebhook(buildInput());
    // Two attempts at TIMEOUT_MS plus the RETRY_DELAY_MS between them: the
    // give-up audit lands at exactly 2 * TIMEOUT_MS + RETRY_DELAY_MS of virtual
    // time, so these two assertions pin both constants (5 s + 2 s + 5 s = 12 s).
    await vi.advanceTimersByTimeAsync(2 * 5_000 + 2_000 - 1);
    expect(audited("signal.webhook_failed")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    // Advance no time, just drain what the last timer set in motion.
    await vi.advanceTimersByTimeAsync(0);

    const [failed] = audited("signal.webhook_failed");
    expect(failed).toMatchObject({ attempts: 2 });
    expect(failed?.errMessage).toMatch(/timed out/);
    await expect(delivery).resolves.toBeUndefined();
  });

  it("never throws when the audit write itself rejects", async () => {
    mockLogAuditEvent.mockImplementationOnce(() => {
      throw new Error("audit blown up");
    });
    // logAuditEvent is voided in the implementation, so a throw there is the
    // implementation's own guard; the caller of deliverSignalWebhook still does
    // not see it.
    await expect(deliver(buildInput())).resolves.toBeUndefined();
  });
});

describe("deliverSignalWebhook: egress guard on the real path", () => {
  beforeEach(() => {
    useFakedTimeoutTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses the loopback test host with no allowlist and the server sees no request", async () => {
    // WEBHOOK_ALLOWED_PRIVATE_HOSTS is unset (afterEach clears it) → 127.0.0.1 is
    // a private address → refused before any socket is opened.
    await deliver(buildInput());

    // Sanity only: a refusal happens before a socket opens, so no hit is
    // possible here either way; the errMessage below is what is asserted.
    expect(hits).toHaveLength(0);
    expect(audited("signal.webhook_failed")).toEqual([
      expect.objectContaining({ errMessage: expect.stringMatching(/private address/) }),
    ]);
    expect(audited("signal.webhook_delivered")).toHaveLength(0);
  });

  it("refuses a metadata URL and audits failure with no request", async () => {
    await deliver(buildInput({ webhookUrl: "http://169.254.169.254/latest/meta-data/" }));

    // Sanity only (see the loopback case): the refusal precedes any socket.
    expect(hits).toHaveLength(0);
    expect(audited("signal.webhook_failed")).toEqual([
      expect.objectContaining({
        url: "http://169.254.169.254/latest/meta-data/",
        errMessage: expect.stringMatching(/private address/),
      }),
    ]);
    expect(audited("signal.webhook_delivered")).toHaveLength(0);
  });

  it("delivers to an allowlisted private host and refuses the same host when unlisted", async () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
    await deliver(buildInput());
    expect(hits).toHaveLength(1);
    expect(audited("signal.webhook_delivered")).toHaveLength(1);

    // Same host, no allowlist → refused.
    delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
    hits = [];
    mockLogAuditEvent.mockClear();
    await deliver(buildInput());
    expect(hits).toHaveLength(0);
    expect(audited("signal.webhook_failed")).toHaveLength(1);
  });

  it("refuses a 3xx as a failed attempt, retried once, and never requests the Location target", async () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
    handler = (_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/final` });
      res.end();
    };

    await deliver(buildInput({ webhookUrl: `http://127.0.0.1:${port}/redirect` }));

    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.url === "/redirect")).toBe(true);
    expect(hits.some((h) => h.url === "/final")).toBe(false);
    const [failed] = audited("signal.webhook_failed");
    expect(failed).toMatchObject({ attempts: 2 });
    expect(failed?.errMessage).toMatch(/redirect/);
    // A refused redirect never yields a response, so there is no status code.
    expect(failed?.statusCode).toBeUndefined();
  });

  it("counts an oversized receiver body as a failed attempt (cap is RESPONSE_MAX_BYTES)", async () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(RESPONSE_MAX_BYTES + 1000));
    };

    await deliver(buildInput());

    expect(hits).toHaveLength(2);
    const [failed] = audited("signal.webhook_failed");
    expect(failed).toMatchObject({ attempts: 2 });
    expect(failed?.errMessage).toMatch(/too large/);
    expect(audited("signal.webhook_delivered")).toHaveLength(0);
  });

  it("still judges a within-cap body by status (large 2xx ack is a success)", async () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(40 * 1024));
    };

    await deliver(buildInput());

    expect(hits).toHaveLength(1);
    expect(audited("signal.webhook_delivered")).toEqual([expect.objectContaining({ attempts: 1, statusCode: 200 })]);
  });

  it("fails a rebinding answer (public at check, private at connect) and never reaches the server", async () => {
    // assertPublicWebhookUrl's check passes `{ all: true }` (no family/hints);
    // guardedFetch's connect-time checking `lookup` passes `{ all, family, hints }`.
    // The attacker answers the check with a public address and the connect with a
    // private one, exactly the DNS-rebinding answer the old resolve-then-fetch
    // path let through.
    dnsLookupMock.mockImplementation((host: string, opts: unknown) => {
      const isConnect =
        !!opts && typeof opts === "object" && ("family" in opts || "hints" in opts);
      return Promise.resolve(
        isConnect ? [{ address: "10.0.0.7", family: 4 }] : [{ address: PUBLIC, family: 4 }],
      );
    });

    // What discriminates old from new is the errMessage: the old code passed the
    // check (a public answer) and then let its own HTTP client resolve again, so
    // it never saw the private connect-time answer and reported a connection
    // error or a delivered POST; guardedFetch refuses at connect time, so the
    // audit names the private address it refused. (hits stays 0 as a sanity
    // check only: undici resolves names through its own connector, so the old
    // code did not reach this in-process server either.)
    await deliver(buildInput({ webhookUrl: `http://rebind.evil:${port}/inbox` }));

    expect(hits).toHaveLength(0);
    const [failed] = audited("signal.webhook_failed");
    expect(failed).toMatchObject({ attempts: 2 });
    expect(failed?.errMessage).toMatch(/resolves to a private address: rebind\.evil -> 10\.0\.0\.7/);
    expect(audited("signal.webhook_delivered")).toHaveLength(0);
  });
});

describe("isPrivateAddress (SSRF egress guard, M8)", () => {
  it("flags loopback / private / link-local / metadata / IPv6-internal", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback (dotted)
      "::ffff:7f00:1", // IPv4-mapped loopback (URL-normalized hex)
      "::ffff:a9fe:a9fe", // IPv4-mapped 169.254.169.254 metadata (hex)
      "::ffff:a00:1", // IPv4-mapped 10.0.0.1 (hex)
      "64:ff9b::7f00:1", // NAT64 127.0.0.1
      "::a9fe:a9fe", // IPv4-compatible 169.254.169.254 (deprecated, hex)
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows genuinely public addresses (incl. the 172.16/12 boundaries)", () => {
    for (const ip of [
      "93.184.216.34",
      "1.1.1.1",
      "8.8.8.8",
      "172.15.0.1", // just below 172.16/12
      "172.32.0.1", // just above 172.16/12
      "2606:4700:4700::1111",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("assertPublicWebhookUrl (SSRF egress guard, M8)", () => {
  it("rejects a literal private / loopback / metadata host without a DNS lookup", async () => {
    await expect(assertPublicWebhookUrl("http://127.0.0.1/x")).rejects.toThrow(/private address/);
    await expect(
      assertPublicWebhookUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/private address/);
    await expect(assertPublicWebhookUrl("http://[::1]/x")).rejects.toThrow(/private address/);
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("rejects an IPv4-mapped IPv6 metadata/loopback literal (URL-normalized hex form)", async () => {
    // new URL() normalizes [::ffff:169.254.169.254] to the compressed hex
    // ::ffff:a9fe:a9fe, so this drives the form the real flow produces — not the
    // dotted literal. Without decoding the hex tail this would slip the guard.
    await expect(
      assertPublicWebhookUrl("http://[::ffff:169.254.169.254]/latest/meta-data/"),
    ).rejects.toThrow(/private address/);
    await expect(assertPublicWebhookUrl("http://[::ffff:127.0.0.1]/x")).rejects.toThrow(
      /private address/,
    );
    // IPv4-compatible (deprecated) form, also URL-normalized to hex.
    await expect(assertPublicWebhookUrl("http://[::169.254.169.254]/x")).rejects.toThrow(
      /private address/,
    );
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) scheme", async () => {
    await expect(assertPublicWebhookUrl("ftp://example.com/x")).rejects.toThrow(/scheme not allowed/);
  });

  it("rejects a hostname that resolves to a private address (DNS rebinding)", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }]);
    await expect(assertPublicWebhookUrl("https://rebind.evil/x")).rejects.toThrow(
      /resolves to a private address/,
    );
  });

  it("allows a hostname that resolves to a public address", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicWebhookUrl("https://hooks.example/inbox")).resolves.toBeUndefined();
  });

  it("permits an explicitly allowlisted private host (operator opt-in)", async () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1, internal.local";
    try {
      await expect(assertPublicWebhookUrl("http://127.0.0.1:9000/x")).resolves.toBeUndefined();
      expect(dnsLookupMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
    }
  });

  it("matches the allowlist case-insensitively; an allowlisted localhost beats the name block", async () => {
    // Both the env entry and the URL host are lowercased before comparison, and
    // the allowlist check runs before the `localhost` name block, so an
    // allowlisted localhost (in any case) wins and is permitted.
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "LOCALHOST";
    try {
      await expect(assertPublicWebhookUrl("http://localhost:9000/x")).resolves.toBeUndefined();
      // WHATWG lowercases the URL host, so capitals in the URL are equivalent.
      await expect(assertPublicWebhookUrl("http://LOCALHOST:9000/x")).resolves.toBeUndefined();
      expect(dnsLookupMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
    }
  });

  it("does not exempt localhost under an allowlist that only lists a different host", async () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = "127.0.0.1";
    try {
      // `localhost` is not `127.0.0.1`; it stays blocked by name.
      await expect(assertPublicWebhookUrl("http://LOCALHOST:9000/x")).rejects.toThrow(
        /private address/,
      );
    } finally {
      delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
    }
  });
});
