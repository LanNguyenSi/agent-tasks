/**
 * Unit tests for lib/egress-guard.ts (shared SSRF egress guard).
 *
 * DNS is mocked. The only sockets opened are to a throwaway HTTP server on
 * 127.0.0.1 inside this process; the guard is exercised against it both as an
 * operator-allowlisted host (the allowed path) and as a refused target (the
 * server must see no request at all).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));

import {
  EgressBlockedError,
  EgressRequestError,
  assertPublicUrl,
  guardedFetch,
  isBlockedHostname,
  isPrivateAddress,
  type EgressPolicy,
} from "../../src/lib/egress-guard.js";

const PUBLIC_IP = "93.184.216.34";

const WEB: EgressPolicy = { label: "webhook", schemes: ["http:", "https:"] };
const STRICT: EgressPolicy = {
  label: "OIDC",
  schemes: ["https:"],
  publicMessage: "issuer URL must be a public https address",
};

beforeEach(() => {
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
});

// ── isPrivateAddress ─────────────────────────────────────────────────────────

describe("isPrivateAddress", () => {
  const privateAddresses: Array<[string, string]> = [
    ["IPv4 this-host 0.0.0.0", "0.0.0.0"],
    ["IPv4 0.0.0.0/8", "0.1.2.3"],
    ["IPv4 10/8", "10.0.0.5"],
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 loopback far end", "127.255.255.254"],
    ["IPv4 link-local / cloud metadata", "169.254.169.254"],
    ["IPv4 172.16/12 low end", "172.16.0.1"],
    ["IPv4 172.16/12 high end", "172.31.255.255"],
    ["IPv4 192.168/16", "192.168.1.1"],
    ["IPv4 CGNAT 100.64/10", "100.64.0.1"],
    ["IPv4 CGNAT high end", "100.127.255.255"],
    ["IPv4 192.0.0.0/24", "192.0.0.8"],
    ["IPv4 documentation 192.0.2.0/24", "192.0.2.1"],
    ["IPv4 6to4 relay anycast", "192.88.99.1"],
    ["IPv4 benchmarking 198.18/15", "198.19.0.1"],
    ["IPv4 documentation 198.51.100.0/24", "198.51.100.7"],
    ["IPv4 documentation 203.0.113.0/24", "203.0.113.9"],
    ["IPv4 multicast", "224.0.0.1"],
    ["IPv4 broadcast", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 link-local with zone id", "fe80::1%eth0"],
    ["IPv6 site-local fec0::/10", "fec0::1"],
    ["IPv6 unique-local fc00::/7 (fc)", "fc00::1"],
    ["IPv6 unique-local fc00::/7 (fd)", "fd12:3456::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv4-mapped loopback, dotted", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback, hex", "::ffff:7f00:1"],
    ["IPv4-mapped metadata, hex", "::ffff:a9fe:a9fe"],
    ["IPv4-mapped 10.0.0.1, hex", "::ffff:a00:1"],
    ["IPv4-mapped loopback, fully expanded", "0:0:0:0:0:ffff:7f00:1"],
    ["IPv4-translated (SIIT) loopback", "::ffff:0:7f00:1"],
    ["NAT64 loopback", "64:ff9b::7f00:1"],
    ["NAT64 metadata, dotted", "64:ff9b::169.254.169.254"],
    ["local-use NAT64 64:ff9b:1::/48", "64:ff9b:1::1"],
    ["IPv4-compatible metadata (deprecated)", "::a9fe:a9fe"],
    ["IPv4-compatible public address (::/96 is reserved)", "::808:808"],
    ["6to4 embedding loopback", "2002:7f00:1::1"],
    ["6to4 embedding metadata", "2002:a9fe:a9fe::"],
    ["Teredo 2001::/32", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["IPv6 documentation 2001:db8::/32", "2001:db8::1"],
    ["IPv6 discard-only 100::/64", "100::1"],
  ];
  it.each(privateAddresses)("flags %s", (_label, ip) => {
    expect(isPrivateAddress(ip), ip).toBe(true);
  });

  const publicAddresses: Array<[string, string]> = [
    ["public IPv4", PUBLIC_IP],
    ["1.1.1.1", "1.1.1.1"],
    ["just below 172.16/12", "172.15.0.1"],
    ["just above 172.16/12", "172.32.0.1"],
    ["just below CGNAT", "100.63.255.255"],
    ["just above CGNAT", "100.128.0.1"],
    ["public IPv6", "2606:4700:4700::1111"],
    ["IPv4-mapped public address", "::ffff:5db8:d822"],
    ["IPv4-mapped public address, dotted", "::ffff:93.184.216.34"],
    ["NAT64 embedding a public address, dotted", "64:ff9b::93.184.216.34"],
    ["public IPv6 with a zone id (the zone is ignored)", "2606:4700:4700::1111%eth0"],
    ["6to4 embedding a public address", "2002:5db8:d822::1"],
    ["NAT64 embedding a public address", "64:ff9b::5db8:d822"],
  ];
  it.each(publicAddresses)("allows %s", (_label, ip) => {
    expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it.each([
    ["empty string", ""],
    ["a hostname", "example.com"],
    ["dotted IPv4 with a 256 octet", "1.2.3.256"],
    ["IPv6 with two compressions", "1::2::3"],
  ])("treats %s as unsafe (not a valid IP literal)", (_label, value) => {
    expect(isPrivateAddress(value), value).toBe(true);
  });
});

describe("isBlockedHostname", () => {
  it.each(["localhost", "LOCALHOST", "localhost.", "app.localhost", "a.b.LocalHost."])(
    "blocks %s",
    (name) => {
      expect(isBlockedHostname(name)).toBe(true);
    },
  );
  it.each(["example.com", "localhost.example.com", "notlocalhost", "mylocalhost.com"])(
    "does not block %s",
    (name) => {
      expect(isBlockedHostname(name)).toBe(false);
    },
  );
});

// ── assertPublicUrl: every refused target form ───────────────────────────────

describe("assertPublicUrl", () => {
  // Written as the URL an admin would type; the WHATWG parser normalizes the
  // numeric host forms, which is what the guard sees.
  const refusedUrls: Array<[string, string]> = [
    ["IPv4 loopback", "https://127.0.0.1/"],
    ["IPv4 metadata endpoint", "https://169.254.169.254/latest/meta-data/"],
    ["IPv4 private 10/8", "https://10.1.2.3/"],
    ["IPv4 private 172.16/12", "https://172.20.0.2/"],
    ["IPv4 private 192.168/16", "https://192.168.0.10/"],
    ["IPv4 as one decimal number", "https://2130706433/"],
    ["IPv4 as hex number", "https://0x7f000001/"],
    ["IPv4 in dotted hex", "https://0x7f.0x0.0x0.0x1/"],
    ["IPv4 in dotted octal", "https://0177.0.0.1/"],
    ["IPv4 short form 127.1", "https://127.1/"],
    ["IPv4 zero", "https://0/"],
    ["IPv4 with a trailing dot", "https://127.0.0.1./"],
    ["IPv6 loopback", "https://[::1]/"],
    ["IPv6 unspecified", "https://[::]/"],
    ["IPv6 link-local", "https://[fe80::1]/"],
    ["IPv6 unique-local", "https://[fd00::1]/"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped IPv6 metadata", "https://[::ffff:169.254.169.254]/"],
    ["IPv4-mapped IPv6 in hex", "https://[::ffff:7f00:1]/"],
    ["IPv4-compatible IPv6 metadata", "https://[::169.254.169.254]/"],
    ["NAT64 loopback", "https://[64:ff9b::127.0.0.1]/"],
    ["6to4 loopback", "https://[2002:7f00:1::]/"],
    ["localhost", "https://localhost/"],
    ["localhost in capitals", "https://LOCALHOST/"],
    ["localhost with a trailing dot", "https://localhost./"],
    ["a subdomain of localhost", "https://idp.localhost/"],
  ];

  it.each(refusedUrls)("refuses %s without a DNS lookup", async (_label, url) => {
    await expect(assertPublicUrl(url, WEB)).rejects.toBeInstanceOf(EgressBlockedError);
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed URL", async () => {
    await expect(assertPublicUrl("not a url", WEB)).rejects.toThrow(/webhook URL is not a valid URL/);
  });

  it("refuses a scheme the policy does not list", async () => {
    await expect(assertPublicUrl("http://idp.example.com/", STRICT)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(assertPublicUrl("ftp://idp.example.com/", WEB)).rejects.toThrow(
      /webhook scheme not allowed: ftp:/,
    );
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("allows a name that resolves to a public address", async () => {
    await expect(assertPublicUrl("https://idp.example.com/", STRICT)).resolves.toBeUndefined();
    expect(dnsLookupMock).toHaveBeenCalledWith("idp.example.com", { all: true });
  });

  it("allows a public IP literal without a DNS lookup", async () => {
    await expect(assertPublicUrl(`https://${PUBLIC_IP}/`, STRICT)).resolves.toBeUndefined();
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a private address", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }]);
    await expect(assertPublicUrl("https://rebind.evil/", WEB)).rejects.toThrow(
      /webhook host resolves to a private address: rebind.evil -> 10.0.0.7/,
    );
  });

  it("refuses a name whose answer mixes a public and a private address", async () => {
    dnsLookupMock.mockResolvedValueOnce([
      { address: PUBLIC_IP, family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expect(assertPublicUrl("https://mixed.evil/", WEB)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it("refuses a name that resolves to nothing", async () => {
    dnsLookupMock.mockResolvedValueOnce([]);
    await expect(assertPublicUrl("https://void.example/", WEB)).rejects.toThrow(/did not resolve/);
  });

  it("refuses 'localhost' by name even when the resolver answers a public address", async () => {
    await expect(assertPublicUrl("https://localhost/", WEB)).rejects.toThrow(/private address/);
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("an allowlisted host skips the address checks, an unlisted one does not", async () => {
    const policy: EgressPolicy = { ...WEB, allowedPrivateHosts: ["127.0.0.1", "internal.corp"] };
    await expect(assertPublicUrl("http://127.0.0.1:9000/", policy)).resolves.toBeUndefined();
    await expect(assertPublicUrl("http://INTERNAL.corp/", policy)).resolves.toBeUndefined();
    expect(dnsLookupMock).not.toHaveBeenCalled();
    await expect(assertPublicUrl("http://10.0.0.5/", policy)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it("a policy publicMessage hides the detail from `message` and keeps it in `detail`", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "10.9.8.7", family: 4 }]);
    const err = await assertPublicUrl("https://sneaky.evil/", STRICT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressBlockedError);
    const blocked = err as EgressBlockedError;
    expect(blocked.message).toBe("issuer URL must be a public https address");
    expect(blocked.message).not.toMatch(/10\.9\.8\.7|sneaky/);
    expect(blocked.detail).toMatch(/sneaky\.evil -> 10\.9\.8\.7/);
  });
});

// ── guardedFetch against a local server ──────────────────────────────────────

describe("guardedFetch", () => {
  let server: Server;
  let port = 0;
  let hits: Array<{ method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }> = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits = [];
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const LOCAL: EgressPolicy = {
    label: "test",
    schemes: ["http:"],
    allowedPrivateHosts: ["127.0.0.1"],
  };

  it("allowlisted host: GET returns status, text and parsed json, and sends path and query", async () => {
    const res = await guardedFetch(`http://127.0.0.1:${port}/a/b?x=1`, {}, LOCAL);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    await expect(res.text()).resolves.toBe('{"ok":true}');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.method).toBe("GET");
    expect(hits[0]!.url).toBe("/a/b?x=1");
  });

  it("allowlisted host: POST sends the body with an explicit Content-Length and the given headers", async () => {
    const body = "grant_type=authorization_code&code=ü";
    await guardedFetch(
      `http://127.0.0.1:${port}/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      },
      LOCAL,
    );
    expect(hits[0]!.method).toBe("POST");
    expect(hits[0]!.body).toBe(body);
    expect(hits[0]!.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(hits[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(hits[0]!.headers["accept"]).toBe("application/json");
    expect(hits[0]!.headers["transfer-encoding"]).toBeUndefined();
  });

  it.each([
    [200, true],
    [204, true],
    [299, true],
    [400, false],
    [404, false],
    [500, false],
  ])("reports status %i as ok=%s", async (status, ok) => {
    handler = (_req, res) => {
      res.writeHead(status);
      res.end(status === 204 ? undefined : "body");
    };
    const res = await guardedFetch(`http://127.0.0.1:${port}/`, {}, LOCAL);
    expect(res.ok).toBe(ok);
    expect(res.status).toBe(status);
  });

  it("refuses a redirect instead of following it", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/second` });
      res.end();
    };
    const err = await guardedFetch(`http://127.0.0.1:${port}/first`, {}, LOCAL).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EgressRequestError);
    expect((err as EgressRequestError).reason).toBe("redirect");
    expect(hits.map((h) => h.url)).toEqual(["/first"]);
  });

  it.each([300, 301, 303, 307, 308, 399])("refuses a %i redirect", async (status) => {
    handler = (_req, res) => {
      res.writeHead(status, { Location: "http://169.254.169.254/" });
      res.end();
    };
    await expect(guardedFetch(`http://127.0.0.1:${port}/`, {}, LOCAL)).rejects.toBeInstanceOf(
      EgressRequestError,
    );
  });

  it("aborts a response larger than maxBytes", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(5000));
    };
    const err = await guardedFetch(`http://127.0.0.1:${port}/`, { maxBytes: 1000 }, LOCAL).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EgressRequestError);
    expect((err as EgressRequestError).reason).toBe("too_large");
  });

  it("accepts a response exactly at maxBytes", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(1000));
    };
    const res = await guardedFetch(`http://127.0.0.1:${port}/`, { maxBytes: 1000 }, LOCAL);
    await expect(res.text()).resolves.toHaveLength(1000);
  });

  it("times out a server that never answers", async () => {
    handler = () => {
      /* never respond */
    };
    const err = await guardedFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 100 }, LOCAL).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EgressRequestError);
    expect((err as EgressRequestError).reason).toBe("timeout");
  });

  it("refuses a non-allowlisted loopback literal and the server sees no request", async () => {
    const policy: EgressPolicy = { label: "test", schemes: ["http:"] };
    await expect(guardedFetch(`http://127.0.0.1:${port}/`, {}, policy)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(hits).toHaveLength(0);
  });

  it("refuses a scheme the policy does not list and the server sees no request", async () => {
    await expect(
      guardedFetch(`https://127.0.0.1:${port}/`, {}, LOCAL),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(hits).toHaveLength(0);
  });

  it("allowlist is exact: a different private host is still refused", async () => {
    await expect(guardedFetch(`http://127.0.0.2:${port}/`, {}, LOCAL)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(hits).toHaveLength(0);
  });

  it("refuses a name that resolves to loopback at connect time (rebinding), server sees no request", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const policy: EgressPolicy = { label: "test", schemes: ["http:"], publicMessage: "refused" };
    const err = await guardedFetch(`http://rebind.test:${port}/`, {}, policy).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EgressBlockedError);
    expect((err as EgressBlockedError).message).toBe("refused");
    expect((err as EgressBlockedError).detail).toMatch(/rebind\.test -> 127\.0\.0\.1/);
    expect(hits).toHaveLength(0);
  });

  it("refuses a name whose answer mixes a public and a private address, no connection is made", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: PUBLIC_IP, family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const policy: EgressPolicy = { label: "test", schemes: ["http:"] };
    await expect(guardedFetch(`http://mixed.test:${port}/`, {}, policy)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(hits).toHaveLength(0);
  });

  it("refuses a name that resolves to nothing at connect time", async () => {
    dnsLookupMock.mockResolvedValue([]);
    const policy: EgressPolicy = { label: "test", schemes: ["http:"] };
    await expect(guardedFetch(`http://void.test:${port}/`, {}, policy)).rejects.toThrow(
      /did not resolve/,
    );
    expect(hits).toHaveLength(0);
  });

  it("surfaces a resolver failure as an ordinary error", async () => {
    dnsLookupMock.mockRejectedValue(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
    const policy: EgressPolicy = { label: "test", schemes: ["http:"] };
    const err = await guardedFetch(`http://nx.test:${port}/`, {}, policy).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(EgressBlockedError);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});
