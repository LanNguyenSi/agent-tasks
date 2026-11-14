/**
 * OIDC egress guard: discover() and exchangeCode() run through the REAL guarded
 * transport (lib/egress-guard.ts). DNS is mocked and `node:https` is replaced by
 * a fake socket layer that calls the `lookup` the guard passes to it, exactly
 * like net.connect does, and only "connects" to the addresses that lookup
 * returned. No real network access.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dnsLookupMock, httpsRequestMock, httpRequestMock, loggerWarnMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
  httpsRequestMock: vi.fn(),
  // Safety net: the guard is https-only for OIDC, so nothing may reach node:http.
  // A scheme regression would otherwise open a real socket.
  httpRequestMock: vi.fn(() => {
    throw new Error("node:http must not be used by the OIDC client");
  }),
  loggerWarnMock: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));
vi.mock("node:https", () => ({ request: httpsRequestMock }));
vi.mock("node:http", () => ({ request: httpRequestMock }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { warn: loggerWarnMock, error: vi.fn(), info: vi.fn() },
}));

import {
  OidcTargetRefusedError,
  discover,
  exchangeCode,
  type OidcDiscovery,
} from "../../src/services/oidc.js";

const PUBLIC_IP = "93.184.216.34";
const GENERIC_ISSUER_MESSAGE = "issuer URL must be a public https address";

interface FakeRoute {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Make the fake connection fail with this error instead of answering. */
  error?: Error;
}

let routes: Map<string, FakeRoute>;
/** Addresses the fake socket layer was handed by the guard's lookup, per request. */
let connectedTo: string[][];
/** Ask the guard's lookup for a single address (all:false) instead of the list. */
let lookupAll = true;
/** Whether each lookup answer had the shape the guard was asked for (list vs single). */
let lookupShapesMatched: boolean[];

function fakeHttpsRequest(options: {
  host: string;
  path: string;
  lookup?: (
    host: string,
    opts: { all?: boolean; family?: number },
    cb: (err: Error | null, address?: unknown, family?: number) => void,
  ) => void;
}): EventEmitter & { write: () => void; end: () => void; destroy: () => void } {
  const req = Object.assign(new EventEmitter(), {
    write: () => undefined,
    destroy: () => undefined,
    end: () => {
      const answer = (): void => {
        const route = routes.get(`${options.host}${options.path}`);
        if (!route) {
          req.emit("error", Object.assign(new Error("no route"), { code: "ENOTFOUND" }));
          return;
        }
        if (route.error) {
          req.emit("error", route.error);
          return;
        }
        const res = Object.assign(new EventEmitter(), {
          statusCode: route.status,
          headers: route.headers ?? {},
          resume: () => undefined,
        });
        req.emit("response", res);
        if (route.body !== undefined) res.emit("data", Buffer.from(route.body));
        res.emit("end");
      };
      if (!options.lookup) {
        // Would be an IP literal / allowlisted host: connect without a lookup.
        connectedTo.push([options.host]);
        setImmediate(answer);
        return;
      }
      options.lookup(options.host, { all: lookupAll, family: 0 }, (err, address) => {
        if (err) {
          req.emit("error", err);
          return;
        }
        lookupShapesMatched.push(Array.isArray(address) === lookupAll);
        const list = Array.isArray(address)
          ? (address as Array<{ address: string }>).map((a) => a.address)
          : [address as string];
        connectedTo.push(list);
        answer();
      });
    },
  });
  return req;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  // Safety net: the OIDC client must never use the global fetch (it is the
  // unguarded transport). A call fails loudly instead of touching the network.
  globalThis.fetch = vi.fn(() => {
    throw new Error("global fetch must not be used by the OIDC client");
  }) as unknown as typeof fetch;
  routes = new Map();
  connectedTo = [];
  lookupShapesMatched = [];
  lookupAll = true;
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
  httpsRequestMock.mockReset();
  loggerWarnMock.mockReset();
  httpsRequestMock.mockImplementation(fakeHttpsRequest);
});

afterEach(() => {
  expect(httpRequestMock).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  globalThis.fetch = realFetch;
});

function discoveryDoc(issuer: string, overrides: Partial<OidcDiscovery> = {}): string {
  return JSON.stringify({
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    ...overrides,
  });
}

function routeFor(issuer: string, doc: string, jwks = '{"keys":[]}'): void {
  const host = new URL(issuer).hostname;
  routes.set(`${host}/.well-known/openid-configuration`, { status: 200, body: doc });
  routes.set(`${host}/jwks`, { status: 200, body: jwks });
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

async function refusal(promise: Promise<unknown>): Promise<OidcTargetRefusedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OidcTargetRefusedError);
  return err as OidcTargetRefusedError;
}

describe("discover: allowed target", () => {
  it("fetches discovery and JWKS from a public https issuer, connecting only to the checked address", async () => {
    const issuer = "https://egress-ok.example.com";
    routeFor(issuer, discoveryDoc(issuer));

    const result = await discover(issuer);

    expect(result.discovery.issuer).toBe(issuer);
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    expect(connectedTo).toEqual([[PUBLIC_IP], [PUBLIC_IP]]);
    // all:true asks for the address list.
    expect(lookupShapesMatched).toEqual([true, true]);
  });

  it("single-address lookup form (all:false) also connects to the checked address", async () => {
    lookupAll = false;
    const issuer = "https://egress-single.example.com";
    routeFor(issuer, discoveryDoc(issuer));
    await discover(issuer);
    expect(connectedTo).toEqual([[PUBLIC_IP], [PUBLIC_IP]]);
    // all:false asks for one address, not a list.
    expect(lookupShapesMatched).toEqual([true, true]);
  });
});

describe("discover: request shape", () => {
  const sentOptions = (call: number): { agent: unknown; headers: Record<string, string>; method: string; lookup: unknown } =>
    httpsRequestMock.mock.calls[call]![0] as never;

  it("never uses a shared agent (a fresh, lookup-checked connection per request) and installs the checking lookup", async () => {
    const issuer = "https://shape-agent.example.com";
    routeFor(issuer, discoveryDoc(issuer));
    await discover(issuer);
    for (const call of [0, 1]) {
      expect(sentOptions(call).agent).toBe(false);
      expect(typeof sentOptions(call).lookup).toBe("function");
    }
  });

  it("sends Accept and User-Agent on the discovery and JWKS GETs", async () => {
    const issuer = "https://shape-headers.example.com";
    routeFor(issuer, discoveryDoc(issuer));
    await discover(issuer);
    for (const call of [0, 1]) {
      expect(sentOptions(call).method).toBe("GET");
      expect(sentOptions(call).headers).toEqual({
        Accept: "application/json",
        "User-Agent": "agent-tasks",
      });
    }
  });

  it("the token POST keeps its own headers, adds the User-Agent and sends Accept once", async () => {
    routes.set("shape-token.example.com/token", {
      status: 200,
      body: JSON.stringify({ id_token: "idtok", token_type: "Bearer", access_token: "a" }),
    });
    await exchangeCode({
      discovery: {
        issuer: "https://shape-token.example.com",
        authorization_endpoint: "https://shape-token.example.com/auth",
        token_endpoint: "https://shape-token.example.com/token",
        jwks_uri: "https://shape-token.example.com/jwks",
      },
      clientId: "c",
      clientSecret: "s",
      code: "x",
      redirectUri: "https://app.example.com/cb",
      codeVerifier: "v",
    });
    expect(sentOptions(0).method).toBe("POST");
    expect(sentOptions(0).headers).toMatchObject({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "agent-tasks",
    });
    expect(Object.keys(sentOptions(0).headers).filter((k) => k.toLowerCase() === "accept")).toHaveLength(1);
  });
});

describe("discover: refused issuer", () => {
  const refusedIssuers: Array<[string, string]> = [
    ["IPv4 loopback", "https://127.0.0.1"],
    ["IPv4 metadata endpoint", "https://169.254.169.254"],
    ["IPv4 private", "https://10.0.0.5:8443"],
    ["IPv4 as one decimal number", "https://2130706433"],
    ["IPv4 as hex number", "https://0x7f000001"],
    ["IPv4 in dotted octal", "https://0177.0.0.1"],
    ["IPv6 loopback", "https://[::1]"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]"],
    ["localhost", "https://localhost"],
    ["localhost with a trailing dot", "https://localhost."],
    ["a subdomain of localhost", "https://idp.localhost"],
    ["plain http to a public name", "http://plain-http.example.com"],
    ["a non-http scheme", "ftp://idp.example.com"],
  ];

  it.each(refusedIssuers)("refuses %s with the generic message and no network use", async (_l, issuer) => {
    const err = await refusal(discover(issuer));
    expect(err.message).toBe(GENERIC_ISSUER_MESSAGE);
    expect(err.endpoint).toBe("issuer");
    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(dnsLookupMock).not.toHaveBeenCalled();
  });

  it("refuses an issuer name that resolves to a private address; message carries no address or host", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "10.20.30.40", family: 4 }]);
    const issuer = "https://rebind-private.example.com";
    routeFor(issuer, discoveryDoc(issuer));

    const err = await refusal(discover(issuer));

    expect(err.message).toBe(GENERIC_ISSUER_MESSAGE);
    expect(err.message).not.toMatch(/10\.20\.30\.40|rebind-private/);
    expect(err.detail).toMatch(/rebind-private\.example\.com -> 10\.20\.30\.40/);
    expect(connectedTo).toEqual([]);
  });

  it("logs the refusal detail server-side once, while the thrown error stays generic", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "10.20.30.40", family: 4 }]);
    const issuer = "https://logged-refusal.example.com";
    routeFor(issuer, discoveryDoc(issuer));

    const err = await refusal(discover(issuer));

    expect(err.message).not.toMatch(/10\.20\.30\.40/);
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    const [fields] = loggerWarnMock.mock.calls[0]! as [Record<string, unknown>];
    // Exact field set: nothing beyond the label, endpoint and detail reaches the log.
    expect(fields).toEqual({ component: "oidc", endpoint: "issuer", detail: expect.any(String) });
    expect(String(fields.detail)).toMatch(/logged-refusal\.example\.com -> 10\.20\.30\.40/);
  });

  it("does not log anything for a request that was allowed", async () => {
    const issuer = "https://no-log.example.com";
    routeFor(issuer, discoveryDoc(issuer));
    await discover(issuer);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("refuses an issuer name whose DNS answer mixes a public and a private address", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: PUBLIC_IP, family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    const issuer = "https://mixed-answer.example.com";
    routeFor(issuer, discoveryDoc(issuer));

    const err = await refusal(discover(issuer));

    expect(err.message).toBe(GENERIC_ISSUER_MESSAGE);
    expect(connectedTo).toEqual([]);
  });

  it("refuses a private address that comes second in the answer just like one that comes first", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: "192.168.1.1", family: 4 },
      { address: PUBLIC_IP, family: 4 },
    ]);
    const issuer = "https://private-first.example.com";
    routeFor(issuer, discoveryDoc(issuer));
    await refusal(discover(issuer));
    expect(connectedTo).toEqual([]);
  });

  it("does not cache a refusal: a later public answer for the same issuer succeeds", async () => {
    const issuer = "https://recovers.example.com";
    routeFor(issuer, discoveryDoc(issuer));
    dnsLookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await refusal(discover(issuer));

    await expect(discover(issuer)).resolves.toBeDefined();
  });
});

describe("discover: refused advertised endpoints", () => {
  it("refuses a jwks_uri that points at the metadata endpoint", async () => {
    const issuer = "https://jwks-metadata.example.com";
    routeFor(issuer, discoveryDoc(issuer, { jwks_uri: "https://169.254.169.254/latest/meta-data/" }));

    const err = await refusal(discover(issuer));

    expect(err.endpoint).toBe("jwks");
    expect(loggerWarnMock.mock.calls[0]![0]).toMatchObject({ endpoint: "jwks" });
    expect(err.message).not.toMatch(/169\.254/);
    expect(err.message).toMatch(/not a public https address/);
    // The discovery request went out; the JWKS request never did.
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a jwks_uri that is plain http", async () => {
    const issuer = "https://jwks-http.example.com";
    routeFor(issuer, discoveryDoc(issuer, { jwks_uri: "http://public.example.com/jwks" }));
    const err = await refusal(discover(issuer));
    expect(err.endpoint).toBe("jwks");
  });

  it("refuses a jwks_uri whose host resolves to a private address after the discovery fetch", async () => {
    const issuer = "https://jwks-rebind.example.com";
    routeFor(issuer, discoveryDoc(issuer, { jwks_uri: "https://jwks-internal.example.com/jwks" }));
    dnsLookupMock.mockImplementation(async (host: string) =>
      host === "jwks-internal.example.com"
        ? [{ address: "172.17.0.2", family: 4 }]
        : [{ address: PUBLIC_IP, family: 4 }],
    );

    const err = await refusal(discover(issuer));

    expect(err.endpoint).toBe("jwks");
    expect(err.message).not.toMatch(/172\.17|jwks-internal/);
    expect(err.detail).toMatch(/jwks-internal\.example\.com -> 172\.17\.0\.2/);
  });
});

describe("exchangeCode: refused token endpoint", () => {
  const baseParams = {
    clientId: "client-id",
    clientSecret: "very-secret",
    code: "auth-code",
    redirectUri: "https://app.example.com/callback",
    codeVerifier: "verifier",
  };
  const discovery = (token_endpoint: string): OidcDiscovery => ({
    issuer: "https://idp.example.com",
    authorization_endpoint: "https://idp.example.com/auth",
    token_endpoint,
    jwks_uri: "https://idp.example.com/jwks",
  });

  it.each([
    ["metadata endpoint", "https://169.254.169.254/token"],
    ["loopback", "https://127.0.0.1:8080/token"],
    ["localhost", "https://localhost/token"],
    ["plain http", "http://idp.example.com/token"],
  ])("refuses a token_endpoint at the %s and never sends the client secret", async (_l, endpoint) => {
    const err = await refusal(exchangeCode({ ...baseParams, discovery: discovery(endpoint) }));
    expect(err.endpoint).toBe("token");
    expect(loggerWarnMock.mock.calls[0]![0]).toMatchObject({ endpoint: "token" });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("refuses a token_endpoint whose host resolves to a private address", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "10.1.1.1", family: 4 }]);
    routes.set("tokens.example.com/token", { status: 200, body: "{}" });
    const err = await refusal(
      exchangeCode({ ...baseParams, discovery: discovery("https://tokens.example.com/token") }),
    );
    expect(err.message).not.toMatch(/10\.1\.1\.1|tokens\.example/);
    expect(connectedTo).toEqual([]);
  });

  it("exchanges against a public token_endpoint through the guarded transport", async () => {
    routes.set("idp-token.example.com/token", {
      status: 200,
      body: JSON.stringify({ id_token: "idtok", access_token: "a", token_type: "Bearer" }),
    });
    const tokens = await exchangeCode({
      ...baseParams,
      discovery: discovery("https://idp-token.example.com/token"),
    });
    expect(tokens.id_token).toBe("idtok");
    expect(connectedTo).toEqual([[PUBLIC_IP]]);
  });
});

describe("discover: redirects and transport failures", () => {
  it("refuses a redirect from the discovery endpoint", async () => {
    const issuer = "https://redirects.example.com";
    routes.set("redirects.example.com/.well-known/openid-configuration", {
      status: 302,
      headers: { location: "https://169.254.169.254/" },
    });
    await expect(discover(issuer)).rejects.toThrow(/refused a redirect \(302\)/);
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect from the JWKS endpoint", async () => {
    const issuer = "https://jwks-redirects.example.com";
    routes.set("jwks-redirects.example.com/.well-known/openid-configuration", {
      status: 200,
      body: discoveryDoc(issuer),
    });
    routes.set("jwks-redirects.example.com/jwks", { status: 301 });
    await expect(discover(issuer)).rejects.toThrow(/refused a redirect \(301\)/);
  });

  it("reduces a transport failure to its error code, without the address or raw message", async () => {
    const issuer = "https://refuses-connection.example.com";
    routes.set("refuses-connection.example.com/.well-known/openid-configuration", {
      status: 0,
      error: Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443"), {
        code: "ECONNREFUSED",
      }),
    });
    const err = await rejectionOf(discover(issuer));
    expect(err.message).toBe("OIDC request failed (ECONNREFUSED)");
    expect(err.message).not.toMatch(/93\.184/);
  });

  it("a transport failure without a code yields the bare generic message", async () => {
    const issuer = "https://no-code.example.com";
    routes.set("no-code.example.com/.well-known/openid-configuration", {
      status: 0,
      error: new Error("socket hang up 10.0.0.1"),
    });
    const err = await rejectionOf(discover(issuer));
    expect(err.message).toBe("OIDC request failed");
  });
});
