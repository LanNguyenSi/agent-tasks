// rc-v1-C007 fix round, item 6d: resolveLegacyFlag used to accept only the
// exact string "1" with no signal when the env var was set to anything
// else (a truthy-looking typo like "true" or "yes" silently left the
// legacy verb set OFF, with nothing telling the operator their setting had
// no effect). This pins both paths: the exact-match behavior, and the
// one-line stderr warning on a near-miss.
//
// index.ts's real entrypoint call (runStdioServer(...).catch(...)) is
// guarded behind an `invokedDirectly` check (process.argv[1] === this
// module's own URL) specifically so importing it here, for
// resolveLegacyFlag alone, does not also spawn a real stdio server or
// throw on a missing AGENT_TASKS_TOKEN.

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveLegacyFlag } from "../src/index.js";

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
