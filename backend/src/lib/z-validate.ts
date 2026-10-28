import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";

/**
 * Shared request-validator wrapper. Every route uses this instead of calling
 * `zValidator` directly, so the failed-validation wire body is fixed in ONE
 * place.
 *
 * WHY IT EXISTS (contract): the base stack (zod 3 + @hono/zod-validator 0.4.3)
 * had no hook, so a failed validation returned the raw safeParse result via
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
 *
 * One opt-in addition lives here too, so the body is still built in this one
 * file: `zValidate(target, schema, { message: true })` adds a top-level
 * `message` (the first issue's message, or "Invalid request body") next to
 * `success` and `error`. The web client reads that field to show a rejection;
 * `error.issues` and `error.name` are unchanged, and routes that do not pass
 * the option keep exactly the two top-level keys.
 *
 * The hook uses the Hono context (`c.json(...)`) rather than a raw `new
 * Response(...)`: a raw Response discards headers the request pipeline already
 * set with `c.header()` (for example a request-id middleware), whereas building
 * the 400 through `c` keeps them.
 */
export function zValidate<T extends ZodType, Target extends "json" | "query" | "param" | "header" | "form" | "cookie">(
  target: Target,
  schema: T,
  options: { message?: boolean } = {},
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues;
      const error = { issues, name: "ZodError" };
      if (options.message) {
        return c.json({ success: false, error, message: issues[0]?.message ?? "Invalid request body" }, 400);
      }
      return c.json({ success: false, error }, 400);
    }
    // Success: return undefined so the validator calls the next handler.
    return undefined;
  });
}
