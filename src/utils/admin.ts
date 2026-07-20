import { getUser } from "../storage/users";
import type { Env } from "../types";
import { constantTimeEqual } from "./crypto";
import type { Logger } from "./logger";

/**
 * Whether the caller is an administrator. Two paths:
 * - service-to-service: X-Admin-API-Key matching the ADMIN_API_KEY secret
 * - human: an authenticated user whose email matches the ADMIN_EMAIL secret
 *
 * Fails closed when neither secret is configured.
 */
export async function isAdminRequest(
  env: Env,
  opts: { adminApiKeyHeader?: string; userId?: string },
  logger: Logger,
): Promise<boolean> {
  if (
    opts.adminApiKeyHeader &&
    env.ADMIN_API_KEY &&
    constantTimeEqual(opts.adminApiKeyHeader, env.ADMIN_API_KEY)
  ) {
    return true;
  }

  if (opts.userId && env.ADMIN_EMAIL) {
    const userResult = await getUser(env.DB, opts.userId, logger);
    if (userResult.success && userResult.data.email === env.ADMIN_EMAIL) {
      return true;
    }
  }

  return false;
}
