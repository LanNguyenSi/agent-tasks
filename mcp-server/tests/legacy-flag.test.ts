// rc-v1-C007 fix round, item 6d: resolveLegacyFlag used to accept only the
// exact string "1" with no signal when the env var was set to anything
// else (a truthy-looking typo like "true" or "yes" silently left the
// legacy verb set OFF, with nothing telling the operator their setting had
// no effect). This pins both paths: the exact-match behavior, and the
// one-line stderr warning on a near-miss.
//
// Round-2 fix (CRITICAL): resolveLegacyFlag moved out of index.ts into its
// own module (src/legacy-flag.ts) so index.ts's real entrypoint call
// (runStdioServer(...).catch(...)) needs no import-vs-invocation guard at
// all. The old guard (process.argv[1] === this module's own URL via
// import.meta.url) broke the npm bin path: node_modules/.bin/
// agent-tasks-mcp is a symlink, so process.argv[1] never equaled the
// realpath-resolved import.meta.url, and the published binary silently did
// nothing. See mcp-server/src/legacy-flag.ts's and src/index.ts's own
// comments, and tests/bin-spawn.test.ts for the end-to-end regression
// guard over the real symlink shape.

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveLegacyFlag } from "../src/legacy-flag.js";

describe("resolveLegacyFlag (rc-v1-C007 entrypoint flag)", () => {
  const ORIGINAL = process.env.AGENT_TASKS_MCP_LEGACY;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AGENT_TASKS_MCP_LEGACY;
    else process.env.AGENT_TASKS_MCP_LEGACY = ORIGINAL;
    vi.restoreAllMocks();
  });

  it('returns true for the exact string "1"', () => {
    process.env.AGENT_TASKS_MCP_LEGACY = "1";
    expect(resolveLegacyFlag()).toBe(true);
  });

  it("returns false, silently, when the env var is unset", () => {
    delete process.env.AGENT_TASKS_MCP_LEGACY;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveLegacyFlag()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns false and logs a one-line stderr warning for a truthy-looking typo ("true")', () => {
    process.env.AGENT_TASKS_MCP_LEGACY = "true";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveLegacyFlag()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [message] = spy.mock.calls[0];
    expect(String(message)).toContain("AGENT_TASKS_MCP_LEGACY");
    expect(String(message)).toContain("true");
  });

  it('returns false and logs a warning for any other non-"1" value ("0")', () => {
    process.env.AGENT_TASKS_MCP_LEGACY = "0";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveLegacyFlag()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
