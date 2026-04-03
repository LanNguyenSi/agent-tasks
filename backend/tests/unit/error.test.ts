import { describe, expect, it, vi } from "vitest";
import { errorResponse, notFound, forbidden, conflict } from "../../src/middleware/error.js";

function makeContext(responseHolder: { status?: number; body?: unknown }) {
  return {
    json: (body: unknown, status?: number) => {
      responseHolder.status = status ?? 200;
      responseHolder.body = body;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
  };
}

describe("errorResponse", () => {
  it("returns correct error envelope", () => {
    const result: { status?: number; body?: unknown } = {};
    const ctx = makeContext(result);
    errorResponse(ctx as never, 404, "not_found", "Resource not found");
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: "not_found", message: "Resource not found" });
  });

  it("includes details when provided", () => {
    const result: { status?: number; body?: unknown } = {};
    const ctx = makeContext(result);
    errorResponse(ctx as never, 422, "validation_failed", "Invalid input", { field: "title" });
    expect(result.body).toMatchObject({ details: { field: "title" } });
  });
});

describe("notFound", () => {
  it("returns 404 with not_found error code", () => {
    const result: { status?: number; body?: unknown } = {};
    notFound(makeContext(result) as never);
    expect(result.status).toBe(404);
    expect((result.body as Record<string, string>).error).toBe("not_found");
  });
});

describe("forbidden", () => {
  it("returns 403 with forbidden error code", () => {
    const result: { status?: number; body?: unknown } = {};
    forbidden(makeContext(result) as never);
    expect(result.status).toBe(403);
    expect((result.body as Record<string, string>).error).toBe("forbidden");
  });

  it("uses custom message when provided", () => {
    const result: { status?: number; body?: unknown } = {};
    forbidden(makeContext(result) as never, "Custom forbidden message");
    expect((result.body as Record<string, string>).message).toBe("Custom forbidden message");
  });
});

describe("conflict", () => {
  it("returns 409 with conflict error code", () => {
    const result: { status?: number; body?: unknown } = {};
    conflict(makeContext(result) as never, "Task already claimed");
    expect(result.status).toBe(409);
    expect((result.body as Record<string, string>).error).toBe("conflict");
    expect((result.body as Record<string, string>).message).toBe("Task already claimed");
  });
});
