import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { logger, withLogContext } from "../lib/logger.js";

// Allowed shape for an inbound X-Request-Id. Restricting to a sane charset
// blocks header-injection attempts (CR/LF/quote/control chars) on both the
// log line and the echoed response header.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

// Endpoints whose 200s are pure noise: they fire on every health probe (k8s
// liveness/readiness, docker-compose, uptime monitors). The middleware still
// wraps them in an ALS scope so any error inside the handler logs cleanly —
// only the per-request access summary is suppressed.
const SILENT_ACCESS_PATHS = new Set(["/api/health"]);

/**
 * Generates a per-request `requestId` and runs the rest of the request
 * inside an AsyncLocalStorage scope. Every `logger.info(...)` call within
 * the request automatically picks up `requestId`, `method`, `path` — plus
 * any `actorId` / `actorType` (stamped by the auth middleware), `verb`
 * (stamped by the MCP route), and `taskId` / `projectId` (stamped by the
 * task router) that downstream middleware enrich.
 *
 * Honors an inbound `X-Request-Id` header so callers (or upstream proxies)
 * can correlate their own request log with our backend log line; otherwise
 * we mint a fresh UUID. Echoed back in the response header.
 */
export const requestContextMiddleware: MiddlewareHandler = async (c, next) => {
  const inbound = c.req.header("x-request-id");
  const requestId = inbound && REQUEST_ID_PATTERN.test(inbound)
    ? inbound
    : randomUUID();
  c.header("X-Request-Id", requestId);

  const startedAt = Date.now();

  await withLogContext(
    { requestId, method: c.req.method, path: c.req.path },
    async () => {
      await next();

      if (SILENT_ACCESS_PATHS.has(c.req.path) && c.res.status < 500) {
        return;
      }

      const durationMs = Date.now() - startedAt;
      const status = c.res.status;
      // Status-class routing keeps prod info logs readable while preserving
      // security-relevant signal:
      //   5xx       → error (real problems)
      //   401/403   → warn  (auth/authz failures — needed for brute-force
      //                       detection and security audits)
      //   other 4xx → debug (404/422 drive-by traffic; toggled on via
      //                       LOG_LEVEL=debug when you actually need them)
      //   2xx/3xx   → info  (the access trail callers grep)
      const level =
        status >= 500
          ? "error"
          : status === 401 || status === 403
            ? "warn"
            : status >= 400
              ? "debug"
              : "info";
      logger[level]({ status, durationMs }, "request");
    },
  );
};
