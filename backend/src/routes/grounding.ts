import { directDescriptorSchema } from "../services/grounding-direct-context.js";
import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../types/hono.js";
import { GroundingAttemptsService, groundingSessionSchema } from "../services/grounding-attempts.js";
import { GroundingAccessError, groundingIntentSchema } from "../services/grounding-context.js";
import { GroundingReceiptVerificationError } from "../services/grounding-receipt.js";

const issueSchema = z.object({ intent: groundingIntentSchema }).strict();
const ingestSchema = z.object({ session: groundingSessionSchema, receipt: z.string() }).strict();

/** Count actual streamed bytes, even if Content-Length lies or is absent. */
async function boundedJson(request: Request, limit: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new GroundingReceiptVerificationError("grounding_receipt_invalid");
  if (!request.body) throw new GroundingReceiptVerificationError("grounding_receipt_invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) { await reader.cancel(); throw new GroundingReceiptVerificationError("grounding_receipt_invalid"); }
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch { throw new GroundingReceiptVerificationError("grounding_receipt_invalid"); }
  finally { reader.releaseLock(); }
}

export function createGroundingRouter(service?: GroundingAttemptsService) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.use("/tasks/:id/grounding-attempts", async (c, next) => {
    if (!c.get("actor")) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  router.use("/tasks/:id/grounding-attempts/*", async (c, next) => {
    if (!c.get("actor")) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  router.onError((error, c) => {
    if (error instanceof GroundingAccessError) return c.json({ error: error.code }, error.status);
    if (error instanceof GroundingReceiptVerificationError) {
      const status = error.code === "grounding_verification_unavailable" ? 503
        : error.code === "grounding_receipt_invalid" ? 400
          : ["grounding_receipt_unsupported", "grounding_receipt_untrusted"].includes(error.code) ? 422 : 409;
      return c.json({ error: error.code, ...(error.detail ? { detail: error.detail } : {}) }, status);
    }
    return c.json({ error: "grounding_verification_unavailable" }, 503);
  });
  router.post("/tasks/:id/grounding-attempts", async c => {
    if (!service) return c.json({ error: "grounding_verification_unavailable" }, 503);
    await service.authorizeRouteIssue(c.req.param("id"), c.get("actor"));
    const parsed = issueSchema.safeParse(await boundedJson(c.req.raw, 1024));
    if (!parsed.success) throw new GroundingReceiptVerificationError("grounding_receipt_invalid");
    return c.json(await service.issueForRoute(c.req.param("id"), c.get("actor"), parsed.data.intent), 201);
  });
  router.post("/tasks/:id/grounding-attempts/direct", async c => {
    if (!service) return c.json({ error: "grounding_verification_unavailable" }, 503);
    await service.authorizeDirectIssue(c.req.param("id"), c.get("actor"));
    const parsed = directDescriptorSchema.safeParse(await boundedJson(c.req.raw, 1024));
    if (!parsed.success) throw new GroundingReceiptVerificationError("grounding_receipt_invalid");
    return c.json(await service.issueDirect(c.req.param("id"), c.get("actor"), parsed.data), 201);
  });
  router.post("/tasks/:id/grounding-attempts/:attemptId/receipt", async c => {
    if (!service) return c.json({ error: "grounding_verification_unavailable" }, 503);
    await service.authorizeRouteReceipt(c.req.param("id"), c.req.param("attemptId"), c.get("actor"));
    // JSON string escaping expands each receipt byte by at most six bytes.
    const parsed = ingestSchema.safeParse(await boundedJson(c.req.raw, 200000));
    if (!parsed.success) throw new GroundingReceiptVerificationError("grounding_receipt_invalid");
    return c.json(await service.ingestForRoute(c.req.param("id"), c.req.param("attemptId"), c.get("actor"), parsed.data.session, parsed.data.receipt));
  });
  return router;
}
