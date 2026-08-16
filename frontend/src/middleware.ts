import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, resolveApiOrigin } from "./lib/csp";

/**
 * Random per-request base64 value for the CSP script-src nonce. Uses the
 * Web Crypto API (global in both the Edge and Node.js middleware runtimes)
 * rather than node:crypto, so this doesn't force middleware onto the
 * Node.js runtime.
 */
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const apiOrigin = resolveApiOrigin();

const CSP_HEADER_NAME = "Content-Security-Policy-Report-Only";

export async function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const csp = await buildCsp({
    apiOrigin,
    nonce,
    // next dev only; a production build always sets NODE_ENV=production.
    allowDevEval: process.env.NODE_ENV !== "production",
  });

  // Next's own App Router renderer (server/app-render/app-render.js,
  // parseRequestHeaders()) reads the nonce it applies to its own
  // RSC-streaming inline scripts (`self.__next_f.push(...)`) out of the
  // *request* header, not the response header: it checks
  // `content-security-policy` and `content-security-policy-report-only`
  // on the incoming request and extracts a `'nonce-...'` token from
  // script-src (falling back to default-src). This follows Next's
  // documented CSP pattern (forward the header on both requestHeaders and
  // the response). On Next 15.5.21, one measurement showed the nonce was
  // picked up even without this requestHeaders.set line -- but it's kept
  // here defensively against version drift, since it's the documented
  // pattern and costs nothing to keep.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_HEADER_NAME, csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Report-only for now: verified clean (zero console violations) across
  // the dashboard and a task detail page against a production build
  // (`next build` + `next start`) before this shipped. Switch to the
  // `Content-Security-Policy` key (both here and above) to enforce once
  // report-only has run clean in production for a burn-in period --
  // tracked as a follow-up task, not done here.
  response.headers.set(CSP_HEADER_NAME, csp);
  return response;
}

export const config = {
  matcher: [
    // Every response except Next's own static/image assets and the app's
    // static icon route: those aren't navigable documents and don't run
    // scripts, so a CSP on them is a no-op that would just add header
    // overhead to every asset request.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)",
  ],
};
