import { getOrgBySlug } from "../storage/orgs";
import { getUserByUsername } from "../storage/users";
import { MAX_NAMESPACE_LENGTH } from "../types";
import type { Logger } from "../utils/logger";
import { validateUsername } from "../utils/username-validation";

/**
 * Username derivation for provisioned accounts, shared by the OIDC JIT login
 * path (src/routes/sso.tsx) and SCIM provisioning (src/routes/scim.ts) so both
 * produce identical names for the same email — a user provisioned by SCIM and
 * one JIT-created at first login must not diverge.
 */

// Bounded probe for a free numeric-suffixed name before falling back to a
// random one.
const MAX_USERNAME_SUFFIX_ATTEMPTS = 10;

/** CSPRNG hex string of `byteLength` bytes (also used by routes/sso.tsx). */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a username from the email local part via the exact pipeline signup
 * uses (see createUser), falling back to a random name when the local part
 * cannot produce a valid one.
 */
export function deriveUsernameBase(email: string): string {
  const candidate = (email.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-0-9]+/, "")
    .replace(/-+$/, "")
    // Truncate long local parts to the username cap (re-trimming so the cut
    // cannot leave a trailing hyphen) rather than failing max-length
    // validation and falling to the random fallback.
    .slice(0, MAX_NAMESPACE_LENGTH)
    .replace(/-+$/, "");
  const validation = validateUsername(candidate);
  return validation.success ? validation.data : `sso-${randomHex(3)}`;
}

/**
 * Find a free username: the base, then numeric suffixes, then a random
 * fallback. Usernames and org slugs share one namespace (user and org pages
 * live under the same URL prefix), so a name is taken when EITHER exists.
 */
export async function findAvailableUsername(
  db: D1Database,
  logger: Logger,
  base: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_USERNAME_SUFFIX_ATTEMPTS; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    // Keep base + suffix within the username cap; re-trim so a truncation
    // can't leave a trailing hyphen.
    const truncated = base.slice(0, MAX_NAMESPACE_LENGTH - suffix.length).replace(/-+$/, "");
    const candidate = `${truncated}${suffix}`;
    const userTaken = (await getUserByUsername(db, candidate, logger)).success;
    if (userTaken) continue;
    const slugTaken = (await getOrgBySlug(db, logger, candidate)).success;
    if (!slugTaken) return candidate;
  }
  return `sso-${randomHex(4)}`;
}
