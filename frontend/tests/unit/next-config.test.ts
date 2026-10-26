/**
 * next.config.mjs -- the legacy `/teams` -> `/projects` redirect rule
 * (UI/IA stage 3). The rule object itself is pinned here; the query-string
 * passthrough Next applies to a destination without its own query
 * (`/teams?teamId=t1` -> `Location: /projects?teamId=t1`) is a property of
 * Next's redirect handling and is proven against `next start` with
 * `curl -sI` (see the task record). Importing the config follows the
 * pattern in csp.test.ts.
 */
import { describe, it, expect } from "vitest";

import nextConfig from "../../next.config.mjs";

type RedirectRule = { source: string; destination: string; permanent: boolean };

describe("next.config.mjs redirects", () => {
  it("redirects the legacy /teams list URL to /projects", async () => {
    // `redirects` is optional on NextConfig; this config defines it (next
    // assertion pins that: deleting redirects() fails typecheck, too).
    const redirects = (await nextConfig.redirects!()) as RedirectRule[];
    const rule = redirects.find((r) => r.source === "/teams");
    expect(rule).toBeDefined();
    expect(rule).toMatchObject({ destination: "/projects", permanent: false });
  });

  it("redirects /teams exactly, leaving /teams/<rest> (e.g. /teams/tokens) alone", async () => {
    const redirects = (await nextConfig.redirects!()) as RedirectRule[];
    // A source without a trailing wildcard or :param captures matches the
    // path exactly; a rule that would also swallow /teams/tokens is a bug.
    for (const rule of redirects) {
      expect(rule.source).not.toMatch(/[*:?]/);
    }
  });
});
