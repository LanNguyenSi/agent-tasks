import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { logger, withLogContext, setLogContext } from "../lib/logger.js";
import type { Actor } from "../types/auth.js";

/**
 * Generates a per-request `requestId` and runs the rest of the request
 * inside an AsyncLocalStorage scope. Every `logger.info(...)` call within
 * the request automatically picks up `requestId`, `method`, `path` — plus
 * any `actorId` / `verb` / `taskId` that downstream middleware enrich.
 *
 * Honors an inbound `X-Request-Id` header so callers (or upstream proxies)
 * can correlate their own request log with our backend log line; otherwise
 * we mint a fresh UUID. Echoed back in the response header.
 */
export const requestContextMiddleware: MiddlewareHandler = async (c, next) => {
  const inbound = c.req.header("x-request-id");
  // Length cap defends against header-stuffing — a 100-char ID is more than
  // enough for any sane tracing scheme and keeps the log line bounded.
  const requestId = inbound && inbound.length > 0 && inbound.length <= 100
    ? inbound
    : randomUUID();
  c.header("X-Request-Id", requestId);

  const startedAt = Date.now();

  await withLogContext(
    { requestId, method: c.req.method, path: c.req.path },
    async () => {
      // After downstream middleware runs, the actor context is set; copy
      // actorId/actorType into the log scope so the access line below and
      // any handler logs land with the actor stamped on them.
      await next();

      const actor = c.get("actor") as Actor | undefined;
      if (actor) {
        setLogContext({
          actorId: actor.type === "agent" ? actor.tokenId : actor.userId,
          actorType: actor.type,
        });
      }

      const durationMs = Date.now() - startedAt;
      const status = c.res.status;
      // 4xx is noisy on a public endpoint (bad tokens, malformed JSON);
      // demote to debug so prod logs aren't spammed by drive-by traffic.
      // 5xx and 2xx/3xx stay at info so the access trail is readable.
      const level = status >= 500 ? "error" : status >= 400 ? "debug" : "info";
      logger[level]({ status, durationMs }, "request");
    },
  );
};
