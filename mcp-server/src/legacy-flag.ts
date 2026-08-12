// rc-v1-C007: AGENT_TASKS_MCP_LEGACY=1 re-registers the v1 verbs tools.ts's
// buildTools prunes from the default registration (LEGACY_VERB_NAMES), for
// a caller still depending on one of them by name. Read here and forwarded
// as an explicit option so buildTools/createServer/runStdioServer stay
// testable in both modes without env stubbing.
//
// Round-2 fix (CRITICAL): this used to live in src/index.ts itself, called
// only from behind an `invokedDirectly` guard that compared import.meta.url
// (Node realpath-resolves the entrypoint's own URL) against
// pathToFileURL(process.argv[1]) (NOT realpath-resolved) -- purely so
// importing index.ts from a test would not also spawn a real stdio server.
// That guard silently broke the npm bin path: node_modules/.bin/
// agent-tasks-mcp is a SYMLINK, so process.argv[1] is the symlink path
// while import.meta.url is the resolved target; the two never matched,
// invokedDirectly was always false, and the published binary exited 0
// having done nothing (measured directly: a real npm pack -> install ->
// npx round trip in a sandbox produced zero output). Moving this function
// out to its own module removes the hazard class entirely: index.ts now
// has nothing that needs shielding from a bare import, so its own
// entrypoint call carries no guard at all (see index.ts's comment), and
// this module can be imported by tests with no server-spawning side
// effect regardless of how it is invoked.
export function resolveLegacyFlag(): boolean {
  const raw = process.env.AGENT_TASKS_MCP_LEGACY;
  // Only the literal string "1" turns the flag on. Anything else that is
  // still SET (a truthy-looking typo like "true" or "yes") silently stayed
  // off before this fix, with no signal to the operator that the flag they
  // set had no effect. One line to stderr, not a thrown error: the server
  // still starts in default mode, which is the safe fallback.
  if (raw !== undefined && raw !== "1") {
    // eslint-disable-next-line no-console
    console.error(
      `[agent-tasks-mcp] AGENT_TASKS_MCP_LEGACY is set to "${raw}", not "1"; the legacy verb set stays OFF. Set AGENT_TASKS_MCP_LEGACY=1 (exactly) to enable it.`,
    );
  }
  return raw === "1";
}
