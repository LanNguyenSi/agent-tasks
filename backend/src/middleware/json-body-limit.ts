import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

// App-wide ceiling on request bodies (hardening, 769df3c4). Before this,
// only the multipart attachment-upload route (routes/tasks.ts) enforced a
// `bodyLimit`; every JSON write endpoint — POST /tasks create, PATCH
// /tasks/:id, POST /tasks/:id/respec, POST /tasks/:id/artifacts, and the
// batch-import endpoint — was otherwise unbounded at the transport level,
// ahead of any per-field zod cap.
//
// Sizing (default ceiling, `JSON_BODY_LIMIT_BYTES`):
// zod's `.max()` counts UTF-16 code units (`String.prototype.length`), not
// bytes. The worst-case byte blowup per counted unit is a 3-byte-in-UTF-8
// BMP character (e.g. most CJK/Cyrillic/etc. code points) that still costs
// only 1 UTF-16 unit — astral characters cost 2 units for 4 bytes, i.e. a
// SMALLER 2 bytes/unit, so they are not the worst case. That puts the worst
// realistic templateData payload at:
//   9 fields x TEMPLATE_DATA_FIELD_MAX_CHARS (50,000, lib/confidence.ts)
//   x 3 bytes/unit = 1,350,000 bytes (~1.29 MiB)
// Separately, POST /tasks/:id/artifacts allows inline `content` up to
// ARTIFACT_MAX_BYTES (1,048,576 — a UTF-8 BYTE cap, enforced twice: once as
// a zod `.max()` char-count ceiling, once as a runtime `Buffer.byteLength`
// check in the route handler). A body-limit ceiling that sat AT that same
// number, as this ceiling originally did, collides with it: the artifact's
// own JSON envelope (the `content` key, quoting/escaping, the sibling
// type/name/description/mimeType fields) always adds bytes on top of the
// raw content, so a maximal, perfectly legitimate artifact could get 413'd
// by this middleware before ever reaching the route's own, more precise,
// content-only check. `JSON_BODY_LIMIT_BYTES` must clear ARTIFACT_MAX_BYTES
// with real headroom, not sit exactly at it.
//
// 2 MiB (2,097,152 bytes) covers both: comfortably above the ~1.29 MiB
// templateData worst case, and leaves ~1 MiB of envelope headroom above the
// 1,048,576-byte artifact-content ceiling.
//
// The batch-import endpoint (POST /projects/:projectId/tasks/import, up to
// 200 tasks) also falls under this default ceiling, and is a DELIBERATE,
// not merely incidental, fit: 2 MiB / 200 tasks is ~10KB average per task —
// generous for a realistic import (title + a real but modest description),
// but a batch where every one of 200 tasks maxes out every templateData
// field AND its description (~500KB/task, ~100MB total) is intentionally
// NOT accommodated. That shape — 200 fully-maxed-out specs in one call — is
// not a realistic import and is treated the same as any other oversized
// request: rejected here, before the batch's own per-item zod validation
// even runs.
export const JSON_BODY_LIMIT_BYTES = 2_097_152; // 2 MiB

// GitHub's own documented webhook payload ceiling (see GitHub's webhook
// payload-size docs) — deliberately much larger than JSON_BODY_LIMIT_BYTES.
// POST /api/webhooks/github is UNAUTHENTICATED by design (GitHub signs the
// payload; we verify the HMAC signature inside the route, not via
// authMiddleware) — see routes/webhooks.ts. That makes it the one route
// where "no limit at all" would be a real unauthenticated-DoS surface, so it
// gets its OWN explicit, generous ceiling rather than either sharing the
// tight default (which would silently drop legitimate large PR/issue
// payloads before signature verification even runs) or being fully exempt.
export const WEBHOOK_BODY_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MiB

// The multipart attachment-upload route sets its OWN (larger, content-aware)
// bodyLimit — see ATTACHMENT_BODY_LIMIT_BYTES in services/attachment-files.ts,
// applied at routes/tasks.ts. That route is exempt here entirely so the two
// limits don't fight each other; its own middleware keeps governing
// unchanged, on top of the auth gate every /api/tasks/* path already has.
export const ATTACHMENT_UPLOAD_PATH_RE = /^\/api\/tasks\/[^/]+\/attachments\/upload$/;

// GitHub webhook routes — see WEBHOOK_BODY_LIMIT_BYTES above for why these
// get their own (larger) ceiling instead of the default.
export const WEBHOOK_PATH_RE = /^\/api\/webhooks\//;

const enforceDefaultLimit = bodyLimit({
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

const enforceWebhookLimit = bodyLimit({
  maxSize: WEBHOOK_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      {
        error: "payload_too_large",
        message: `Request body exceeds the ${WEBHOOK_BODY_LIMIT_BYTES}-byte webhook limit`,
      },
      413,
    ),
});

/**
 * Global request-body-size gate, mounted on `"*"` in app.ts ahead of every
 * router. Three regimes, in order:
 *  - the multipart attachment-upload path: exempt, its own route-level
 *    `bodyLimit` governs instead;
 *  - GitHub webhook paths: a separate, much larger ceiling
 *    (`WEBHOOK_BODY_LIMIT_BYTES`) — this endpoint is unauthenticated, so it
 *    still needs SOME bound, just not the tight JSON default;
 *  - everything else: `JSON_BODY_LIMIT_BYTES`, rejected with a 413 before
 *    the request reaches route/zod validation.
 */
export const jsonBodyLimit: MiddlewareHandler = async (c, next) => {
  if (ATTACHMENT_UPLOAD_PATH_RE.test(c.req.path)) {
    return next();
  }
  if (WEBHOOK_PATH_RE.test(c.req.path)) {
    return enforceWebhookLimit(c, next);
  }
  return enforceDefaultLimit(c, next);
};
