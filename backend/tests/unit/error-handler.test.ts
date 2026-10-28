import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { zValidate } from "../../src/lib/z-validate.js";
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
  app.get("/http-400", () => {
    throw new HTTPException(400, { message: "Malformed JSON in request body" });
  });
  app.get("/http-400-bare", () => {
    throw new HTTPException(400);
  });
  app.get("/http-404", () => {
    throw new HTTPException(404, { message: "no such thing" });
  });
  app.get("/http-418", () => {
    throw new HTTPException(418, { message: "teapot" });
  });
  app.get("/http-with-res", () => {
    throw new HTTPException(401, {
      message: "ignored",
      res: new Response("Unauthorized", { headers: { "WWW-Authenticate": "Bearer" } }),
    });
  });
  app.get("/http-500", () => {
    throw new HTTPException(500, { message: "internal detail" });
  });
  app.post("/validated", zValidate("json", z.object({ name: z.string() })), (c) => c.json(c.req.valid("json")));
  app.get("/prisma-nul", () => {
    throw new Prisma.PrismaClientUnknownRequestError(
      'Invalid `prisma.team.findUnique()` invocation: Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "22021", message: "invalid byte sequence for encoding \\"UTF8\\": 0x00" }) })',
      { clientVersion: "test" },
    );
  });
  app.get("/prisma-unknown-other", () => {
    throw new Prisma.PrismaClientUnknownRequestError('PostgresError { code: "40001", message: "could not serialize access" }', {
      clientVersion: "test",
    });
  });
  app.get("/prisma-raw-nul", () => {
    throw new Prisma.PrismaClientKnownRequestError("raw query failed", {
      code: "P2010",
      clientVersion: "test",
      meta: { code: "22021", message: "invalid byte sequence" },
    });
  });
  app.get("/prisma-raw-other", () => {
    throw new Prisma.PrismaClientKnownRequestError("raw query failed", {
      code: "P2010",
      clientVersion: "test",
      meta: { code: "25P02", message: "transaction aborted" },
    });
  });
  app.get("/prisma-known-22021-code", () => {
    throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test", meta: { code: "22021" } });
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

  it("keeps an HTTPException 4xx status in the { error, message } shape", async () => {
    expect(await invoke("/http-400")).toEqual({
      status: 400,
      body: { error: "validation_error", message: "Malformed JSON in request body" },
    });
    expect(await invoke("/http-404")).toEqual({
      status: 404,
      body: { error: "not_found", message: "no such thing" },
    });
    expect(await invoke("/http-418")).toEqual({
      status: 418,
      body: { error: "bad_request", message: "teapot" },
    });
  });

  it("gives an HTTPException without a message a default message", async () => {
    expect(await invoke("/http-400-bare")).toEqual({
      status: 400,
      body: { error: "validation_error", message: "Bad request" },
    });
  });

  it("returns the response an HTTPException carries as given", async () => {
    const res = await buildFixture().fetch(new Request("http://test/http-with-res"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await res.text()).toBe("Unauthorized");
  });

  it("does not turn an HTTPException 5xx into a client error or leak its message", async () => {
    const { status, body } = await invoke("/http-500");
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal_error", message: "An unexpected error occurred" });
  });

  it("answers 400 in the same shape for a malformed JSON body behind zValidate", async () => {
    const res = await buildFixture().fetch(
      new Request("http://test/validated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"name":',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_error", message: "Malformed JSON in request body" });
  });

  it("maps Postgres 22021 (NUL byte) from Prisma to 400 without leaking the database message", async () => {
    for (const path of ["/prisma-nul", "/prisma-raw-nul"]) {
      const { status, body } = await invoke(path);
      expect(status).toBe(400);
      expect(body).toEqual({
        error: "validation_error",
        message: "Request contains a character that cannot be stored (NUL byte)",
      });
    }
  });

  it("leaves other Prisma errors as 500", async () => {
    for (const path of ["/prisma-unknown-other", "/prisma-raw-other", "/prisma-known-22021-code"]) {
      const { status, body } = await invoke(path);
      expect(status).toBe(500);
      expect(body).toEqual({ error: "internal_error", message: "An unexpected error occurred" });
    }
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
