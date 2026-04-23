import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { appErrorHandler } from "../../src/lib/error-handler.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../../src/lib/errors.js";

function buildFixture(): Hono {
  const app = new Hono();
  app.get("/notfound", () => {
    throw new NotFoundError();
  });
  app.get("/forbidden", () => {
    throw new ForbiddenError("nope");
  });
  app.get("/conflict", () => {
    throw new ConflictError("already exists");
  });
  app.get("/unauthorized", () => {
    throw new UnauthorizedError();
  });
  app.get("/validation", () => {
    throw new ValidationError("bad input");
  });
  app.get("/custom-app", () => {
    throw new AppError(418, "teapot");
  });
  app.get("/zod", (c) => {
    z.object({ name: z.string() }).parse({ name: 42 });
    return c.text("unreachable");
  });
  app.get("/boom", () => {
    throw new Error("db connection lost");
  });
  app.onError(appErrorHandler);
  return app;
}

async function invoke(path: string): Promise<{ status: number; body: unknown }> {
  const res = await buildFixture().fetch(new Request(`http://test${path}`));
  return { status: res.status, body: await res.json() };
}

describe("appErrorHandler", () => {
  it("maps NotFoundError → 404 not_found", async () => {
    const { status, body } = await invoke("/notfound");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found", message: "Resource not found" });
  });

  it("maps ForbiddenError → 403 forbidden with custom message", async () => {
    const { status, body } = await invoke("/forbidden");
    expect(status).toBe(403);
    expect(body).toEqual({ error: "forbidden", message: "nope" });
  });

  it("maps ConflictError → 409 conflict", async () => {
    const { status, body } = await invoke("/conflict");
    expect(status).toBe(409);
    expect(body).toEqual({ error: "conflict", message: "already exists" });
  });

  it("maps UnauthorizedError → 401 unauthorized", async () => {
    const { status, body } = await invoke("/unauthorized");
    expect(status).toBe(401);
    expect(body).toEqual({ error: "unauthorized", message: "Unauthorized" });
  });

  it("maps ValidationError → 400 validation_error", async () => {
    const { status, body } = await invoke("/validation");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "validation_error", message: "bad input" });
  });

  it("maps bare AppError to its declared statusCode", async () => {
    const { status, body } = await invoke("/custom-app");
    expect(status).toBe(418);
    expect(body).toEqual({ error: "internal_error", message: "teapot" });
  });

  it("maps ZodError → 400 with per-issue details", async () => {
    const { status, body } = await invoke("/zod");
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: "validation_error",
      message: "Validation failed",
    });
    const details = (body as { details: Array<{ path: string; message: string }> }).details;
    expect(details).toHaveLength(1);
    expect(details[0].path).toBe("name");
    expect(details[0].message).toMatch(/string/i);
  });

  it("untyped Error falls through to generic 500 without leaking internals", async () => {
    const { status, body } = await invoke("/boom");
    expect(status).toBe(500);
    expect(body).toEqual({
      error: "internal_error",
      message: "An unexpected error occurred",
    });
    // No `details`, no stack, no leaked message.
    expect(body).not.toHaveProperty("details");
  });
});
