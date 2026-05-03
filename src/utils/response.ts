import type { ApiError } from "../types";
import { AppError, AuthError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { Logger } from "./logger";

export function ok<T>(data: T, status = 200): Response {
  return Response.json(data, { status });
}

export function created<T>(data: T): Response {
  return ok(data, 201);
}

export function notFound(resource: string, name: string): Response {
  return error(`${resource} '${name}' not found`, 404);
}

export function badRequest(message: string): Response {
  return error(message, 400);
}

export function unauthorized(message: string): Response {
  return error(message, 401);
}

export function forbidden(message: string): Response {
  return error(message, 403);
}

export function internalError(message: string): Response {
  return error(message, 500);
}

/**
 * Creates an error response from an AppError, including the error code.
 */
export function appError(error: AppError): Response {
  const body: ApiError = {
    error: error.message,
    code: error.code,
  };
  return Response.json(body, { status: error.statusCode });
}

/**
 * Handles a Result error and returns an appropriate response.
 * Optionally logs the error with the provided logger.
 */
export function handleError(
  error: Error,
  logger?: Logger,
  context?: Record<string, unknown>,
): Response {
  if (logger) {
    logger.error("Request error", error, context);
  }

  if (error instanceof NotFoundError) {
    return appError(error);
  }

  if (error instanceof ValidationError) {
    return appError(error);
  }

  if (error instanceof AuthError) {
    return appError(error);
  }

  if (error instanceof ForbiddenError) {
    return appError(error);
  }

  if (error instanceof AppError) {
    return appError(error);
  }

  return internalError(error.message);
}

function error(message: string, status: number): Response {
  const body: ApiError = { error: message };
  return Response.json(body, { status });
}
