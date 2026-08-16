import type { NextConfig } from "next";
import { buildCsp } from "./src/lib/csp";

const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: apiOrigin,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            // Report-only for now: verified clean (zero console violations)
            // across the dashboard and a task detail page against a
            // production build (`next build` + `next start`) before this
            // shipped. Flip the key to `Content-Security-Policy` to enforce
            // once report-only has run clean in production for a burn-in
            // period -- tracked as a follow-up task, not done in this PR.
            key: "Content-Security-Policy-Report-Only",
            value: buildCsp({
              apiOrigin,
              // next dev only; a production build always sets NODE_ENV=production.
              allowDevEval: process.env.NODE_ENV !== "production",
            }),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
