import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";

/**
 * Shared request-validator wrapper. Every route uses this instead of calling
 * `zValidator` directly, so the failed-validation wire body is fixed in ONE
 * place.
 *
 * WHY IT EXISTS (contract): the base stack (zod 3 + @hono/zod-validator 0.4.3)
 * had no hook, so a failed validation returned the raw safeParse result —
 * `c.json({ success: false, error: ZodError }, 400)`. With zod 3 the ZodError's
 * `issues` are enumerable, so the JSON body was
 *   { success: false, error: { issues: [...], name: "ZodError" } }.
 * With zod 4 `ZodError.issues` is NON-enumerable, so spreading the error loses
 * `issues` (clients such as mcp-server/src/errors.ts read `body.error.issues`).
 * This hook rebuilds the exact base body from the zod 4 error: top-level keys
 * exactly `success`, `error`; `error` keys exactly `issues`, `name`; `issues`
 * being the zod 4 issue array (each keeps `code`, `path`, `message` plus zod 4's
 * own per-issue fields such as `expected`/`values`). On success it returns
 * `undefined` so the validator proceeds to the handler (the `c.req.valid(...)`
 * path is unchanged).
 */
export function zValidate<T extends ZodType, Target extends "json" | "query" | "param" | "header" | "form" | "cookie">(
  target: Target,
  schema: T,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { issues: result.error.issues, name: "ZodError" },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    // Success: return undefined so the validator calls the next handler.
    return undefined;
  });
}
