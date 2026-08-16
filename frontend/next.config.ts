import type { NextConfig } from "next";
import { resolveApiOrigin } from "./src/lib/csp";

// The Content-Security-Policy header is set in src/middleware.ts, not here.
// It needs a fresh nonce per request (see csp.ts's module doc for why the
// RSC-streaming inline scripts Next.js itself injects require one), and
// next.config.ts's headers() is evaluated once at build/start time, so it
// cannot carry a per-request value.
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: resolveApiOrigin(),
  },
};

export default nextConfig;
