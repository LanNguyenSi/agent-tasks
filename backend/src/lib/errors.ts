export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed") {
    super(400, message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, message);
    this.name = "ConflictError";
  }
}

const KNOWN_ERROR_CODES: Readonly<Record<string, string>> = {
  AppError: "internal_error",
  NotFoundError: "not_found",
  UnauthorizedError: "unauthorized",
  ForbiddenError: "forbidden",
  ValidationError: "validation_error",
  ConflictError: "conflict",
};

/**
 * Known subclasses emit the exact codes the Hono helpers in
 * `middleware/error.ts` already return, so the wire envelope does not
 * change when a route switches from `return forbidden(c)` to
 * `throw new ForbiddenError()`. Unknown subclasses get snake-cased.
 */
export function errorCodeForName(name: string): string {
  if (name in KNOWN_ERROR_CODES) return KNOWN_ERROR_CODES[name];
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
