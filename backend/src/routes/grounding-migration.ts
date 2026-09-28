import { Hono } from "hono";
import type { AppVariables } from "../types/hono.js";
import { GroundingAccessError } from "../services/grounding-context.js";
import { GroundingReceiptVerificationError } from "../services/grounding-receipt.js";
import { GroundingMigrationService, groundingMigrationRequestSchema } from "../services/grounding-migration.js";

async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !request.body) throw new Error("invalid body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > 16384) { await reader.cancel(); throw new Error("body too large"); }
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } finally { reader.releaseLock(); }
}

export function createGroundingMigrationRouter(service?: GroundingMigrationService) {
  const router = new Hono<{ Variables: AppVariables }>();
  router.onError((error, c) => {
    if (error instanceof GroundingAccessError) return c.json({ error: error.code }, error.status);
    if (error instanceof GroundingReceiptVerificationError) return c.json({ error: error.code }, 503);
    return c.json({ error: "grounding_verification_unavailable" }, 503);
  });
  router.post("/tasks/:id/grounding-migration", async c => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    if (actor.type !== "human") return c.json({ error: "forbidden" }, 403);
    if (!service) return c.json({ error: "grounding_verification_unavailable" }, 503);
    let input: unknown;
    try { input = await body(c.req.raw); } catch { return c.json({ error: "invalid_migration_request" }, 400); }
    const parsed = groundingMigrationRequestSchema.safeParse(input);
    if (!parsed.success) return c.json({ error: "invalid_migration_request" }, 400);
    return c.json(await service.execute(c.req.param("id"), actor, parsed.data));
  });
  return router;
}
