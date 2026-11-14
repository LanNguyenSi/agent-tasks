/**
 * Shared SSRF egress guard.
 *
 * Used by every place the backend makes an outbound request to an address an
 * admin (not the operator) controls: notification webhooks and OIDC discovery,
 * JWKS and token-endpoint calls. Two entry points:
 *
 *   - `assertPublicUrl`: resolve-then-check, for callers that hand the URL to
 *     their own HTTP client afterwards (the webhook sender). Residual: a
 *     DNS-rebinding answer that flips between the check and the connect.
 *   - `guardedFetch`: connects through a `lookup` that checks every address it
 *     resolves, and uses only those addresses, so the connection goes to what
 *     was checked and a rebinding answer cannot slip in between. Redirects are
 *     refused (a public URL must not bounce the request into an internal host).
 *
 * A refused target throws `EgressBlockedError`: `message` is what a caller may
 * show to a user (generic when the policy sets `publicMessage`), `detail` is
 * the internal reason (host and resolved address) for logs only.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export class EgressBlockedError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "EgressBlockedError";
    this.detail = detail;
  }
}

/**
 * A request that was allowed but did not complete in a way the guard accepts:
 * a redirect, a timeout or an oversized body. The message is authored here and
 * safe to show.
 */
export class EgressRequestError extends Error {
  readonly reason: "redirect" | "timeout" | "too_large";
  constructor(reason: "redirect" | "timeout" | "too_large", message: string) {
    super(message);
    this.name = "EgressRequestError";
    this.reason = reason;
  }
}

export interface EgressPolicy {
  /** Prefix for the internal detail text, e.g. "webhook". */
  label: string;
  /** URL protocols a caller may use, e.g. ["https:"]. */
  schemes: readonly string[];
  /**
   * Exact lowercase hostnames or IPs that skip the address checks (operator
   * opt-in for self-hosted deployments). Empty or absent: the guard is fully on.
   */
  allowedPrivateHosts?: readonly string[];
  /**
   * Headers `guardedFetch` sends unless the caller sets the same header (names
   * compare case-insensitively).
   */
  defaultHeaders?: Readonly<Record<string, string>>;
  /**
   * Generic text used as the error `message` for every refusal. When absent the
   * message equals the internal detail.
   */
  publicMessage?: string;
}

// ── Address classification ───────────────────────────────────────────────────

function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return true; // unparseable → treat as unsafe
  const octets = m.slice(1).map((n) => Number(n));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 documentation
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 documentation
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 documentation
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
  return false;
}

/**
 * Parse any IPv6 text form (compressed, uncompressed, dotted-quad tail, zone id)
 * into its eight 16-bit groups. Returns null when it is not a valid IPv6 text.
 */
function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const o = dotted[2]!.split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some((n) => Number.isNaN(n)) ? null : out;
}

function hextetsToIPv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIPv6(ip: string): boolean {
  const h = parseIPv6(ip);
  if (!h) return true; // unparseable → treat as unsafe
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
    number, number, number, number, number, number, number, number,
  ];
  const zeroTo = (n: number): boolean => h.slice(0, n).every((x) => x === 0);

  // `new URL()` normalizes a bracketed mapped literal to compressed HEX
  // (`[::ffff:169.254.169.254]` -> `::ffff:a9fe:a9fe`), so every embedded-IPv4
  // form is decoded from the groups, not matched as dotted text.
  if (zeroTo(5) && h5 === 0xffff) return isPrivateIPv4(hextetsToIPv4(h6, h7)); // ::ffff:0:0/96 mapped
  if (zeroTo(4) && h4 === 0xffff && h5 === 0) return isPrivateIPv4(hextetsToIPv4(h6, h7)); // ::ffff:0:0:0/96 translated
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isPrivateIPv4(hextetsToIPv4(h6, h7)); // 64:ff9b::/96 NAT64
  }
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 1) {
    // 64:ff9b:1::/48 local-use NAT64 (RFC 8215). A /96 prefix carries the IPv4 in
    // the last 32 bits, like 64:ff9b::/96, so an IPv6-only DNS64 deployment that
    // uses it keeps working for public targets. Any other layout (a shorter
    // prefix puts the IPv4 elsewhere) cannot be decoded here and is refused.
    if (h3 === 0 && h4 === 0 && h5 === 0) return isPrivateIPv4(hextetsToIPv4(h6, h7));
    return true;
  }
  if (zeroTo(6)) return true; // ::/96 unspecified, loopback ::1, deprecated IPv4-compatible
  if (h0 === 0x2002) return isPrivateIPv4(hextetsToIPv4(h1, h2)); // 2002::/16 6to4 embeds the IPv4
  if (h0 === 0x2001 && h1 === 0) return true; // 2001::/32 Teredo (obfuscated IPv4)
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (h0 === 0x2001 && h1 === 2 && h2 === 0) return true; // 2001:2::/48 benchmarking
  if (h0 === 0x2001 && (h1 & 0xfff0) === 0x10) return true; // 2001:10::/28 ORCHID (deprecated)
  if (h0 === 0x2001 && (h1 & 0xfff0) === 0x20) return true; // 2001:20::/28 ORCHIDv2
  if (h0 === 0x3fff && (h1 & 0xf000) === 0) return true; // 3fff::/20 documentation
  if (h0 === 0x5f00) return true; // 5f00::/16 SRv6 SIDs
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true; // 100::/64 discard-only
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h0 & 0xff00) === 0xfe00) return true; // fe00::/8 link-local fe80::/10, site-local fec0::/10
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True for any address an outbound request must NOT be allowed to reach. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not a valid IP literal → unsafe
}

/**
 * Names that mean "this machine" by definition (RFC 6761), checked without DNS
 * so a resolver that answers them with a public address cannot make them pass.
 * A trailing dot and letter case do not matter.
 */
export function isBlockedHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

// ── Target checks ────────────────────────────────────────────────────────────

function blocked(policy: EgressPolicy, detail: string): EgressBlockedError {
  return new EgressBlockedError(policy.publicMessage ?? detail, detail);
}

function isAllowlisted(host: string, policy: EgressPolicy): boolean {
  return (policy.allowedPrivateHosts ?? []).includes(host.toLowerCase());
}

/**
 * Everything that can be decided without DNS: URL shape, scheme, IP literals,
 * "localhost" names. Returns the parsed URL, the bracket-free host and whether
 * the host is an operator-allowlisted one (address checks skipped).
 */
function checkTarget(
  rawUrl: string,
  policy: EgressPolicy,
): { parsed: URL; host: string; allowlisted: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw blocked(policy, `${policy.label} URL is not a valid URL`);
  }
  if (!policy.schemes.includes(parsed.protocol)) {
    throw blocked(policy, `${policy.label} scheme not allowed: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isAllowlisted(host, policy)) {
    return { parsed, host, allowlisted: true };
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw blocked(policy, `${policy.label} host is a private address: ${host}`);
    }
  } else if (isBlockedHostname(host)) {
    throw blocked(policy, `${policy.label} host is a private address: ${host}`);
  }
  return { parsed, host, allowlisted: false };
}

/**
 * Reject a URL whose scheme is not allowed, or whose host is / resolves to a
 * non-public address. Resolve-then-check: see the module comment for the
 * rebinding residual; use `guardedFetch` where the request is made here.
 */
export async function assertPublicUrl(rawUrl: string, policy: EgressPolicy): Promise<void> {
  const { host, allowlisted } = checkTarget(rawUrl, policy);
  if (allowlisted || isIP(host)) {
    return;
  }
  const records = await dnsLookup(host, { all: true });
  if (records.length === 0) {
    throw blocked(policy, `${policy.label} host did not resolve: ${host}`);
  }
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw blocked(
        policy,
        `${policy.label} host resolves to a private address: ${host} -> ${address}`,
      );
    }
  }
}

// ── Guarded fetch ────────────────────────────────────────────────────────────

export interface GuardedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Whole-request budget in ms (connect, headers and body). Default 10 s. */
  timeoutMs?: number;
  /** Response body cap in bytes. Default 1 MiB. */
  maxBytes?: number;
}

export interface GuardedResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * A `lookup` for the socket layer: resolves every address, refuses the whole
 * name if ANY of them is non-public (a mixed answer is how rebinding hides a
 * private record), and hands back only addresses it has checked.
 */
function checkingLookup(policy: EgressPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, family: options.family, hints: options.hints }).then(
      (records: LookupAddress[]) => {
        if (records.length === 0) {
          callback(blocked(policy, `${policy.label} host did not resolve: ${hostname}`), "", 4);
          return;
        }
        for (const { address } of records) {
          if (isPrivateAddress(address)) {
            callback(
              blocked(
                policy,
                `${policy.label} host resolves to a private address: ${hostname} -> ${address}`,
              ),
              "",
              4,
            );
            return;
          }
        }
        if (options.all) {
          (callback as (e: null, a: LookupAddress[]) => void)(null, records);
        } else {
          callback(null, records[0]!.address, records[0]!.family);
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, "", 4),
    );
  };
}

/**
 * Outbound request that cannot reach a non-public address (see module comment).
 * Redirects are refused, not followed: any 3xx rejects. Unlike `fetch` it bounds
 * time and response size.
 */
export function guardedFetch(
  rawUrl: string,
  init: GuardedFetchInit,
  policy: EgressPolicy,
): Promise<GuardedResponse> {
  return new Promise<GuardedResponse>((resolve, reject) => {
    let target: ReturnType<typeof checkTarget>;
    try {
      target = checkTarget(rawUrl, policy);
    } catch (err) {
      reject(err);
      return;
    }
    const { parsed, host, allowlisted } = target;
    const body = init.body;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const sent = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
    for (const [name, value] of Object.entries(policy.defaultHeaders ?? {})) {
      if (!sent.has(name.toLowerCase())) headers[name] = value;
    }
    if (body !== undefined) {
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
    const doRequest = parsed.protocol === "https:" ? httpsRequest : httpRequest;

    const req = doRequest({
      host,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: init.method ?? "GET",
      headers,
      // A fresh connection per call, so every request passes the lookup check.
      agent: false,
      // Skipped only for an operator-allowlisted host.
      ...(allowlisted ? {} : { lookup: checkingLookup(policy) }),
    });

    // Settle exactly once: a request destroyed on purpose (timeout, oversized
    // body, redirect) can still emit "end"/"error" afterwards.
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (err: Error): void => {
      settle(() => reject(err));
      req.destroy();
    };
    const timer = setTimeout(() => {
      fail(new EgressRequestError("timeout", `${policy.label} request timed out`));
    }, timeoutMs);

    req.on("error", fail);
    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        fail(
          new EgressRequestError("redirect", `${policy.label} request refused a redirect (${status})`),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          fail(new EgressRequestError("too_large", `${policy.label} response too large`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        settle(() =>
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
          }),
        );
      });
    });

    if (body !== undefined) req.write(body);
    req.end();
  });
}
