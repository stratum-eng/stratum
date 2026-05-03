export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, context);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' not found`, "NOT_FOUND", 404, { resource, id });
    this.name = "NotFoundError";
  }
}

export class AuthError extends AppError {
  constructor(message = "Authentication required") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AuthError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super(message, "FORBIDDEN", 403);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
}

export class ExternalServiceError extends AppError {
  constructor(
    service: string,
    message: string,
    override readonly cause?: Error,
  ) {
    super(`${service} error: ${message}`, "EXTERNAL_SERVICE_ERROR", 502, {
      service,
      cause: cause?.message,
    });
    this.name = "ExternalServiceError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError(error.message, "INTERNAL_ERROR", 500);
  }
  return new AppError(String(error), "INTERNAL_ERROR", 500);
}
