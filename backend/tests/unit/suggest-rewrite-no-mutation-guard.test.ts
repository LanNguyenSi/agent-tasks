/**
 * Regression guard (review round-2 finding 5): POST /tasks/:id/suggest-rewrite
 * must never call a mutating Prisma verb.
 *
 * ADR-0011 / task fc4f2dc7: this endpoint is advisory-only -- it reads the
 * task and its live confidence findings, asks an LLM for a suggestion, and
 * returns it. Applying a suggestion is a SEPARATE, explicit PATCH
 * /tasks/:id the caller makes after a human reviews the diff; this handler
 * itself must structurally be incapable of writing.
 *
 * The route-level test (tasks-suggest-rewrite-route.test.ts) already proves
 * this INCIDENTALLY -- prismaMocks only stubs `task.findUnique`, so a stray
 * mutating call would throw "not a function" and fail those tests. This
 * guard makes the guarantee MECHANICAL instead of incidental: it scans the
 * literal source of the handler body at CI time and fails if any Prisma
 * write verb (`create`/`update`/`updateMany`/`upsert`/`delete`/`deleteMany`)
 * appears in it, independent of whether any test happens to exercise that
 * code path. Modeled on url-guard-regression.test.ts's scan-then-allowlist
 * pattern.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasksRouteFile = path.resolve(__dirname, "../../src/routes/tasks.ts");

const ROUTE_START_MARKER = 'taskRouter.post("/tasks/:id/suggest-rewrite"';
// The very next top-level route registration in tasks.ts after
// suggest-rewrite (PATCH /tasks/:id, per the file's current ordering) --
// used only to find where the handler body ENDS. If tasks.ts is reordered
// so this comment moves, the extraction below fails loudly (empty/negative
// slice) rather than silently scanning nothing.
const NEXT_ROUTE_MARKER = "// ── Update task";

const MUTATING_PRISMA_VERB =
  /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;

function extractHandlerBody(source: string): string {
  const start = source.indexOf(ROUTE_START_MARKER);
  expect(start, `could not find '${ROUTE_START_MARKER}' in tasks.ts`).toBeGreaterThanOrEqual(0);

  const end = source.indexOf(NEXT_ROUTE_MARKER, start);
  expect(end, `could not find '${NEXT_ROUTE_MARKER}' after the suggest-rewrite route`).toBeGreaterThan(start);

  return source.slice(start, end);
}

describe("suggest-rewrite handler contains no mutating Prisma verb", () => {
  it("the extracted handler body is non-trivial (sanity check on the extraction itself)", () => {
    const body = extractHandlerBody(readFileSync(tasksRouteFile, "utf-8"));
    // Guards against a silent extraction bug (e.g. markers matching but
    // slicing an empty/near-empty range) making the real assertion below
    // vacuously pass.
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("getLlmRewriteClient");
    expect(body).toContain("suggestRewrite");
  });

  it("never calls .create/.update/.upsert/.delete (or their *Many variants) on any Prisma model", () => {
    const body = extractHandlerBody(readFileSync(tasksRouteFile, "utf-8"));
    const match = body.match(MUTATING_PRISMA_VERB);
    expect(match, match ? `found forbidden mutating call: ${match[0]}` : undefined).toBeNull();
  });
});
