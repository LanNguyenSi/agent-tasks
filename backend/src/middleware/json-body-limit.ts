import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

// App-wide ceiling on request bodies (hardening, 769df3c4). Before this,
// only the multipart attachment-upload route (routes/tasks.ts) enforced a
// `bodyLimit`; every JSON write endpoint — including POST /tasks create,
// PATCH /tasks/:id, and POST /tasks/:id/respec — was otherwise unbounded at
// the transport level, ahead of any per-field zod cap.
//
// Sizing: the largest legitimate JSON payload this API accepts is bounded by
// TEMPLATE_DATA_FIELD_MAX_CHARS (lib/confidence.ts) — nine templateData
// string fields at 50,000 chars each is 450,000 chars (up to ~1.8MB in the
// worst case of 4-byte UTF-8 code points, though realistic specs are
// overwhelmingly ASCII/near-ASCII) — plus title/description/labels/etc. and
// JSON structural overhead (quotes, escaping, key names). 1 MiB is
// comfortably above that sum so a legitimate large-but-valid spec still
// passes, while still bounding a single request far below what an
// unconstrained client could otherwise send.
export const JSON_BODY_LIMIT_BYTES = 1_048_576; // 1 MiB

// The multipart attachment-upload route sets its OWN (larger, content-aware)
// bodyLimit — see ATTACHMENT_BODY_LIMIT_BYTES in services/attachment-files.ts,
// applied at routes/tasks.ts. That route is exempt here so the two limits
// don't fight each other; its own middleware keeps governing unchanged.
export const ATTACHMENT_UPLOAD_PATH_RE = /^\/api\/tasks\/[^/]+\/attachments\/upload$/;

const enforceJsonBodyLimit = bodyLimit({
  maxSize: JSON_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      {
        error: "payload_too_large",
        message: `Request body exceeds the ${JSON_BODY_LIMIT_BYTES}-byte limit`,
      },
      413,
    ),
});

/**
 * Global request-body-size gate, mounted on `"*"` in app.ts ahead of every
 * router. Skips the multipart attachment-upload path (its own route-level
 * `bodyLimit` governs there instead) and otherwise rejects any body over
 * `JSON_BODY_LIMIT_BYTES` with a 413 before it reaches route/zod validation.
 */
export const jsonBodyLimit: MiddlewareHandler = async (c, next) => {
  if (ATTACHMENT_UPLOAD_PATH_RE.test(c.req.path)) {
    return next();
  }
  return enforceJsonBodyLimit(c, next);
};
