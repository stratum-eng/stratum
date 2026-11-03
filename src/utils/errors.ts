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

/** Why a credential that DOES exist was refused. */
export type CredentialRejection =
  | "revoked"
  | "expired"
  | "owner-deleting"
  | "owner-disabled"
  /** An OAuth grant bound to an agent (#409) whose agent is gone, or is no
   * longer owned by the grant's user. */
  | "agent-unavailable";

/**
 * A credential lookup that found a real row and refused it. Still a
 * NotFoundError — callers that only care "did it authenticate" treat it like
 * an unknown token — but it carries who the credential belongs to, so the
 * auth middleware can audit a failure that identifies an account (#255)
 * without a second lookup.
 */
export class RejectedCredentialError extends NotFoundError {
  constructor(
    public readonly reason: CredentialRejection,
    public readonly userId: string,
    public readonly credentialId: string,
  ) {
    super("Token", reason);
    this.name = "RejectedCredentialError";
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

/**
 * Exists so an over-cap body can be *thrown* from deep inside a util or storage
 * layer and still surface as a 413 with its code intact: `handleError` maps any
 * `AppError` to a coded response, whereas a plain `Error` collapses into a 500
 * that tells the caller nothing actionable. Routes that already have the
 * response in hand should prefer `payloadTooLarge()` in `./response`.
 */
export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body too large") {
    super(message, "PAYLOAD_TOO_LARGE", 413);
    this.name = "PayloadTooLargeError";
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
