import { describe, expect, it } from "vitest";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  errorCodeForName,
} from "../../src/lib/errors.js";

describe("AppError hierarchy", () => {
  it("AppError carries statusCode and message", () => {
    const err = new AppError(418, "I'm a teapot");
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe("I'm a teapot");
    expect(err.name).toBe("AppError");
    expect(err instanceof Error).toBe(true);
  });

  it.each([
    [NotFoundError, 404, "NotFoundError", "Resource not found"],
    [UnauthorizedError, 401, "UnauthorizedError", "Unauthorized"],
    [ForbiddenError, 403, "ForbiddenError", "Forbidden"],
    [ValidationError, 400, "ValidationError", "Validation failed"],
    [ConflictError, 409, "ConflictError", "Conflict"],
  ] as const)("%s has status %d, name %s, default message %s", (Ctor, status, name, msg) => {
    const err = new Ctor();
    expect(err.statusCode).toBe(status);
    expect(err.name).toBe(name);
    expect(err.message).toBe(msg);
    expect(err instanceof AppError).toBe(true);
  });

  it("subclasses accept a custom message", () => {
    const err = new ConflictError("Task already claimed");
    expect(err.message).toBe("Task already claimed");
    expect(err.statusCode).toBe(409);
  });
});

describe("errorCodeForName", () => {
  it.each([
    ["NotFoundError", "not_found"],
    ["UnauthorizedError", "unauthorized"],
    ["ForbiddenError", "forbidden"],
    ["ValidationError", "validation_error"],
    ["ConflictError", "conflict"],
    ["AppError", "internal_error"],
  ])("known class %s → %s (matches legacy Hono helper codes)", (name, code) => {
    expect(errorCodeForName(name)).toBe(code);
  });

  it("falls back to snake_case for unknown subclasses", () => {
    expect(errorCodeForName("WorkflowConflictError")).toBe("workflow_conflict_error");
  });
});

