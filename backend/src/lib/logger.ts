import { AsyncLocalStorage } from "node:async_hooks";
import { pino } from "pino";

// Per-request context that gets merged onto every log line emitted within the
// request's async scope. Populated by the request-context middleware
// (requestId, method, path) and progressively enriched by the auth middleware
// (actorId, actorType) and the MCP route (verb). Route handlers call
// `setLogContext({ taskId, projectId })` to surface IDs that aren't visible
// from the path.
type LogContext = {
  requestId?: string;
  method?: string;
  path?: string;
  actorId?: string;
  actorType?: "human" | "agent";
  // MCP tool name (e.g. "task_pickup"), populated only when the JSON-RPC
  // body's `method` is `tools/call`. Other JSON-RPC methods (initialize,
  // tools/list, notifications/initialized) go into `rpcMethod` so dashboards
  // can keep tool traffic separate from protocol traffic.
  verb?: string;
  rpcMethod?: string;
  taskId?: string;
  projectId?: string;
};

const als = new AsyncLocalStorage<LogContext>();

const isProd = process.env.NODE_ENV === "production";

// Pino serializes its mixin output into every line. Returning the live ALS
// store means every `logger.info(...)` call automatically picks up the
// current request's fields without callers passing them through.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }),
  mixin: () => als.getStore() ?? {},
});

/** Run `fn` inside a fresh log-context scope seeded with `seed`. */
export function withLogContext<T>(seed: LogContext, fn: () => T): T {
  return als.run({ ...seed }, fn);
}

/** Merge fields into the current scope's context. No-op outside a scope. */
export function setLogContext(fields: Partial<LogContext>): void {
  const store = als.getStore();
  if (store) Object.assign(store, fields);
}

/** Read a snapshot of the current log context (for tests / debugging). */
export function getLogContext(): LogContext {
  return { ...(als.getStore() ?? {}) };
}
