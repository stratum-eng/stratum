import { generateApiKey, hashToken } from "../utils/crypto";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { listAgents } from "./agents";
import { recordAudit } from "./audit";
import { deleteAllUserSessions } from "./sessions";
import { disableUser, enableUser } from "./users";

/**
 * Org SSO connections (migration 049 + 050): one OIDC connection per org.
 * The client secret arrives here already encrypted (AES-GCM under the SSO
 * salt) and the SCIM bearer token is stored only as a SHA-256 hash — this
 * module never sees or logs either plaintext.
 */

export interface SsoConnection {
  id: string;
  orgId: string;
  protocol: "oidc";
  issuer: string;
  clientId: string;
  clientSecretCiphertext: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  emailDomains: string[];
  domainsVerifiedAt: string | null;
  domainVerificationToken: string | null;
  scimTokenHash: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSsoConnectionInput {
  orgId: string;
  issuer: string;
  clientId: string;
  clientSecretCiphertext: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Already normalized via `normalizeEmailDomains`. */
  emailDomains: string[];
}

interface SsoConnectionRow {
  id: string;
  org_id: string;
  protocol: "oidc";
  issuer: string;
  client_id: string;
  client_secret_ciphertext: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  email_domains: string;
  domains_verified_at: string | null;
  domain_verification_token: string | null;
  scim_token_hash: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Public/shared mailbox providers that no org can claim as an SSO email
 * domain. Defense in depth: DNS TXT verification would fail for these anyway,
 * but rejecting them at create time gives an honest error instead of an
 * unverifiable connection.
 */
export const PUBLIC_EMAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
] as const;

const MAX_EMAIL_DOMAINS = 20;
// The DoH verification query name is `_stratum-sso.<domain>` — 13 extra octets
// on top of the domain — so the domain itself must fit in 253 - 13 = 240.
const MAX_DOMAIN_LENGTH = 240;
const MAX_DOMAIN_LABEL_LENGTH = 63;
// Lowercased hostname with at least two labels; no leading/trailing hyphens.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function rowToConnection(row: SsoConnectionRow): SsoConnection {
  let emailDomains: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.email_domains);
    if (Array.isArray(parsed)) {
      emailDomains = parsed.filter((d): d is string => typeof d === "string");
    }
  } catch {
    // A malformed stored array yields no domains — the connection simply
    // resolves nothing rather than crashing every lookup.
  }
  return {
    id: row.id,
    orgId: row.org_id,
    protocol: row.protocol,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecretCiphertext: row.client_secret_ciphertext,
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    jwksUri: row.jwks_uri,
    emailDomains,
    domainsVerifiedAt: row.domains_verified_at,
    domainVerificationToken: row.domain_verification_token,
    scimTokenHash: row.scim_token_hash,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Lowercase, trim, dedupe, and validate a list of email domains; rejects
 * public mailbox providers and malformed hostnames.
 */
export function normalizeEmailDomains(domains: string[]): Result<string[], ValidationError> {
  if (domains.length === 0) {
    return err(new ValidationError("emailDomains must contain at least one domain"));
  }
  if (domains.length > MAX_EMAIL_DOMAINS) {
    return err(new ValidationError(`emailDomains cannot exceed ${MAX_EMAIL_DOMAINS} entries`));
  }
  const normalized: string[] = [];
  for (const raw of domains) {
    const domain = raw.trim().toLowerCase();
    if (
      domain.length === 0 ||
      domain.length > MAX_DOMAIN_LENGTH ||
      !DOMAIN_PATTERN.test(domain) ||
      domain.split(".").some((label) => label.length > MAX_DOMAIN_LABEL_LENGTH)
    ) {
      return err(new ValidationError(`'${raw}' is not a valid email domain`));
    }
    if ((PUBLIC_EMAIL_DOMAINS as readonly string[]).includes(domain)) {
      return err(
        new ValidationError(`'${domain}' is a public email provider and cannot be claimed`),
      );
    }
    if (!normalized.includes(domain)) normalized.push(domain);
  }
  return ok(normalized);
}

function randomHexToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sameDomains(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((domain, i) => domain === sortedB[i]);
}

/**
 * Create the org's connection, or replace it wholesale (PUT semantics).
 * On replace, the domain verification token, SCIM token hash, and — when the
 * domain list is unchanged — verification/enabled state all survive. An edited
 * domain list clears `domains_verified_at` and disables the connection (an
 * unverified connection must never stay enabled); the token stays, so the
 * admin's published DNS records remain valid for re-verification.
 */
export async function upsertSsoConnection(
  db: D1Database,
  logger: Logger,
  input: UpsertSsoConnectionInput,
): Promise<Result<{ connection: SsoConnection; created: boolean }, AppError>> {
  logger.info("Upserting SSO connection", { orgId: input.orgId, issuer: input.issuer });

  try {
    const now = new Date().toISOString();
    const emailDomainsJson = JSON.stringify(input.emailDomains);

    const existingResult = await getSsoConnectionByOrgId(db, logger, input.orgId);
    if (!existingResult.success && !(existingResult.error instanceof NotFoundError)) {
      return err(existingResult.error);
    }

    if (existingResult.success) {
      const existing = existingResult.data;
      const domainsUnchanged = sameDomains(existing.emailDomains, input.emailDomains);
      const domainsVerifiedAt = domainsUnchanged ? existing.domainsVerifiedAt : null;
      const enabled = domainsUnchanged && existing.enabled ? 1 : 0;
      // Rows created before migration 050 have no verification token; generate
      // one on replace so verify-domains has a recovery path short of a
      // destructive DELETE.
      const domainVerificationToken = existing.domainVerificationToken ?? randomHexToken();

      await db
        .prepare(
          `UPDATE org_sso_connections
           SET issuer = ?, client_id = ?, client_secret_ciphertext = ?,
               authorization_endpoint = ?, token_endpoint = ?, jwks_uri = ?,
               email_domains = ?, domains_verified_at = ?, domain_verification_token = ?,
               enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          input.issuer,
          input.clientId,
          input.clientSecretCiphertext,
          input.authorizationEndpoint,
          input.tokenEndpoint,
          input.jwksUri,
          emailDomainsJson,
          domainsVerifiedAt,
          domainVerificationToken,
          enabled,
          now,
          existing.id,
        )
        .run();

      logger.info("SSO connection replaced", {
        orgId: input.orgId,
        connectionId: existing.id,
        domainsUnchanged,
      });
      return ok({
        connection: {
          ...existing,
          issuer: input.issuer,
          clientId: input.clientId,
          clientSecretCiphertext: input.clientSecretCiphertext,
          authorizationEndpoint: input.authorizationEndpoint,
          tokenEndpoint: input.tokenEndpoint,
          jwksUri: input.jwksUri,
          emailDomains: input.emailDomains,
          domainsVerifiedAt,
          domainVerificationToken,
          enabled: enabled === 1,
          updatedAt: now,
        },
        created: false,
      });
    }

    const id = newId("ssoc");
    const verificationToken = randomHexToken();
    await db
      .prepare(
        `INSERT INTO org_sso_connections (
           id, org_id, protocol, issuer, client_id, client_secret_ciphertext,
           authorization_endpoint, token_endpoint, jwks_uri, email_domains,
           domains_verified_at, domain_verification_token, scim_token_hash,
           enabled, created_at, updated_at
         ) VALUES (?, ?, 'oidc', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 0, ?, ?)`,
      )
      .bind(
        id,
        input.orgId,
        input.issuer,
        input.clientId,
        input.clientSecretCiphertext,
        input.authorizationEndpoint,
        input.tokenEndpoint,
        input.jwksUri,
        emailDomainsJson,
        verificationToken,
        now,
        now,
      )
      .run();

    logger.info("SSO connection created", { orgId: input.orgId, connectionId: id });
    return ok({
      connection: {
        id,
        orgId: input.orgId,
        protocol: "oidc",
        issuer: input.issuer,
        clientId: input.clientId,
        clientSecretCiphertext: input.clientSecretCiphertext,
        authorizationEndpoint: input.authorizationEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        jwksUri: input.jwksUri,
        emailDomains: input.emailDomains,
        domainsVerifiedAt: null,
        domainVerificationToken: verificationToken,
        scimTokenHash: null,
        enabled: false,
        createdAt: now,
        updatedAt: now,
      },
      created: true,
    });
  } catch (error) {
    logger.error("Failed to upsert SSO connection", error instanceof Error ? error : undefined, {
      orgId: input.orgId,
    });
    return err(new AppError("Failed to upsert SSO connection", "STORAGE_ERROR", 500));
  }
}

export async function getSsoConnectionByOrgId(
  db: D1Database,
  logger: Logger,
  orgId: string,
): Promise<Result<SsoConnection, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM org_sso_connections WHERE org_id = ?")
      .bind(orgId)
      .first<SsoConnectionRow>();
    if (!row) return err(new NotFoundError("SSO connection", orgId));
    return ok(rowToConnection(row));
  } catch (error) {
    logger.error("Failed to get SSO connection", error instanceof Error ? error : undefined, {
      orgId,
    });
    return err(new AppError("Failed to get SSO connection", "STORAGE_ERROR", 500));
  }
}

export async function getSsoConnectionById(
  db: D1Database,
  logger: Logger,
  connectionId: string,
): Promise<Result<SsoConnection, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM org_sso_connections WHERE id = ?")
      .bind(connectionId)
      .first<SsoConnectionRow>();
    if (!row) return err(new NotFoundError("SSO connection", connectionId));
    return ok(rowToConnection(row));
  } catch (error) {
    logger.error("Failed to get SSO connection", error instanceof Error ? error : undefined, {
      connectionId,
    });
    return err(new AppError("Failed to get SSO connection", "STORAGE_ERROR", 500));
  }
}

export async function getSsoConnectionByOrgSlug(
  db: D1Database,
  logger: Logger,
  slug: string,
): Promise<Result<SsoConnection, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare(
        `SELECT c.* FROM org_sso_connections c
         JOIN orgs o ON o.id = c.org_id
         WHERE o.slug = ?`,
      )
      .bind(slug)
      .first<SsoConnectionRow>();
    if (!row) return err(new NotFoundError("SSO connection", slug));
    return ok(rowToConnection(row));
  } catch (error) {
    logger.error(
      "Failed to get SSO connection by slug",
      error instanceof Error ? error : undefined,
      { slug },
    );
    return err(new AppError("Failed to get SSO connection", "STORAGE_ERROR", 500));
  }
}

/**
 * Resolve a connection by a VERIFIED email domain. Only connections with
 * `domains_verified_at` set are considered — an unverified claim must never
 * route logins. `requireEnabled` additionally restricts to enabled
 * connections (the login path needs that; admin tooling may not).
 *
 * Full table scan + JSON parse: fine at the one-connection-per-org scale.
 */
export async function getSsoConnectionByVerifiedDomain(
  db: D1Database,
  logger: Logger,
  domain: string,
  opts: { requireEnabled?: boolean } = {},
): Promise<Result<SsoConnection, NotFoundError | AppError>> {
  const requireEnabled = opts.requireEnabled ?? true;
  const needle = domain.trim().toLowerCase();
  try {
    const { results } = await db
      .prepare(
        `SELECT * FROM org_sso_connections
         WHERE domains_verified_at IS NOT NULL ${requireEnabled ? "AND enabled = 1" : ""}`,
      )
      .all<SsoConnectionRow>();

    for (const row of results) {
      const connection = rowToConnection(row);
      if (connection.emailDomains.includes(needle)) {
        return ok(connection);
      }
    }
    return err(new NotFoundError("SSO connection", needle));
  } catch (error) {
    logger.error(
      "Failed to resolve SSO connection by domain",
      error instanceof Error ? error : undefined,
      { domain: needle },
    );
    return err(new AppError("Failed to resolve SSO connection", "STORAGE_ERROR", 500));
  }
}

/**
 * Domains from `domains` already verified by ANOTHER connection. Verified
 * domains are globally unique across connections; callers reject with a
 * conflict when this returns a non-empty list (checked at verify AND enable
 * time, so a stale unverified claim can't sneak through later).
 */
export async function findVerifiedDomainConflicts(
  db: D1Database,
  logger: Logger,
  domains: string[],
  excludeConnectionId: string,
): Promise<Result<string[], AppError>> {
  try {
    const { results } = await db
      .prepare(
        "SELECT * FROM org_sso_connections WHERE domains_verified_at IS NOT NULL AND id != ?",
      )
      .bind(excludeConnectionId)
      .all<SsoConnectionRow>();

    const claimed = new Set<string>();
    for (const row of results) {
      for (const domain of rowToConnection(row).emailDomains) claimed.add(domain);
    }
    return ok(domains.filter((domain) => claimed.has(domain)));
  } catch (error) {
    logger.error(
      "Failed to check verified-domain uniqueness",
      error instanceof Error ? error : undefined,
    );
    return err(new AppError("Failed to check domain uniqueness", "STORAGE_ERROR", 500));
  }
}

/**
 * Mark the connection's domains verified (all of them — verification is
 * all-or-nothing). `checkedDomains` must be the exact list the DNS checks ran
 * against: the stamp is conditional on the stored `email_domains` still
 * matching it (same JSON serialization `upsertSsoConnection` writes), so a
 * concurrent PUT that edits the list mid-verification gets a CONFLICT instead
 * of a verification stamp for a never-checked list.
 */
export async function setSsoDomainsVerified(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  checkedDomains: string[],
): Promise<Result<string, AppError>> {
  const verifiedAt = new Date().toISOString();
  try {
    const result = await db
      .prepare(
        "UPDATE org_sso_connections SET domains_verified_at = ?, updated_at = ? WHERE id = ? AND email_domains = ?",
      )
      .bind(verifiedAt, verifiedAt, connectionId, JSON.stringify(checkedDomains))
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      const exists = await getSsoConnectionById(db, logger, connectionId);
      if (!exists.success) return err(exists.error);
      return err(new ConflictError("connection changed during verification; retry"));
    }
    logger.info("SSO domains verified", { connectionId });
    return ok(verifiedAt);
  } catch (error) {
    logger.error("Failed to mark domains verified", error instanceof Error ? error : undefined, {
      connectionId,
    });
    return err(new AppError("Failed to mark domains verified", "STORAGE_ERROR", 500));
  }
}

/**
 * Toggle `enabled`. Enabling requires verified domains — enforced in SQL so a
 * verify/enable race cannot enable an unverified connection.
 */
export async function setSsoConnectionEnabled(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  enabled: boolean,
): Promise<Result<void, AppError>> {
  const now = new Date().toISOString();
  try {
    const guard = enabled ? "AND domains_verified_at IS NOT NULL" : "";
    const result = await db
      .prepare(`UPDATE org_sso_connections SET enabled = ?, updated_at = ? WHERE id = ? ${guard}`)
      .bind(enabled ? 1 : 0, now, connectionId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      const exists = await getSsoConnectionById(db, logger, connectionId);
      if (!exists.success) return err(exists.error);
      return err(
        new ValidationError("Connection cannot be enabled until its domains are verified"),
      );
    }
    logger.info("SSO connection toggled", { connectionId, enabled });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to toggle SSO connection", error instanceof Error ? error : undefined, {
      connectionId,
    });
    return err(new AppError("Failed to toggle SSO connection", "STORAGE_ERROR", 500));
  }
}

/**
 * Generate (or rotate) the connection's SCIM bearer token. Only the SHA-256
 * hash is stored; the plaintext is returned exactly once for the caller to
 * show and is never logged.
 */
export async function rotateScimToken(
  db: D1Database,
  logger: Logger,
  connectionId: string,
): Promise<Result<string, AppError>> {
  try {
    const plaintext = await generateApiKey("stratum_scim");
    const tokenHash = await hashToken(plaintext);
    const result = await db
      .prepare("UPDATE org_sso_connections SET scim_token_hash = ?, updated_at = ? WHERE id = ?")
      .bind(tokenHash, new Date().toISOString(), connectionId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      return err(new NotFoundError("SSO connection", connectionId));
    }
    logger.info("SCIM token rotated", { connectionId });
    return ok(plaintext);
  } catch (error) {
    logger.error("Failed to rotate SCIM token", error instanceof Error ? error : undefined, {
      connectionId,
    });
    return err(new AppError("Failed to rotate SCIM token", "STORAGE_ERROR", 500));
  }
}

/**
 * Resolve the connection a SCIM bearer token belongs to. Only ENABLED
 * connections with VERIFIED domains authenticate: a disabled connection's
 * token must stop working immediately, and an unverified one must never
 * manage accounts (verification is the trust anchor for the whole SCIM
 * surface). Callers pass the token's SHA-256 hash — the plaintext never
 * reaches storage.
 */
export async function getSsoConnectionByScimTokenHash(
  db: D1Database,
  logger: Logger,
  tokenHash: string,
): Promise<Result<SsoConnection, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare(
        `SELECT * FROM org_sso_connections
         WHERE scim_token_hash = ? AND enabled = 1 AND domains_verified_at IS NOT NULL`,
      )
      .bind(tokenHash)
      .first<SsoConnectionRow>();
    if (!row) return err(new NotFoundError("SSO connection", "by-scim-token"));
    return ok(rowToConnection(row));
  } catch (error) {
    logger.error(
      "Failed to resolve SSO connection by SCIM token",
      error instanceof Error ? error : undefined,
    );
    return err(new AppError("Failed to resolve SSO connection", "STORAGE_ERROR", 500));
  }
}

/**
 * Mark a user managed by a connection (idempotent). Used at OIDC login when an
 * existing account is adopted or JIT-created; SCIM later updates the same row.
 * INSERT OR IGNORE so a re-login never resets `active` or `scim_external_id`
 * that SCIM has since written.
 */
export async function ensureScimMember(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  userId: string,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO scim_members (connection_id, user_id, active, created_at) VALUES (?, ?, 1, ?)",
      )
      .bind(connectionId, userId, new Date().toISOString())
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to ensure scim_members row", error instanceof Error ? error : undefined, {
      connectionId,
      userId,
    });
    return err(new AppError("Failed to record managed membership", "STORAGE_ERROR", 500));
  }
}

// ---------------------------------------------------------------------------
// OIDC login states (migration 049): short-lived per-login rows whose atomic
// consumption is the replay guard for the authorization-code callback.
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the login-state lifetime: the row expiry written
 * here AND the browser-binding cookie's maxAge in routes/sso.tsx must agree,
 * so the route imports this rather than declaring its own copy.
 */
export const OIDC_STATE_TTL_SECONDS = 600;

export interface OidcLoginState {
  state: string;
  connectionId: string;
  nonce: string;
  codeVerifier: string;
  redirectTo: string | null;
}

interface OidcLoginStateRow {
  state: string;
  connection_id: string;
  nonce: string;
  code_verifier: string;
  redirect_to: string | null;
}

export interface CreateOidcLoginStateInput {
  connectionId: string;
  nonce: string;
  codeVerifier: string;
  redirectTo: string | null;
}

function randomHex32Bytes(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Persist a login state row (10-minute TTL); returns the generated `state`. */
export async function createOidcLoginState(
  db: D1Database,
  logger: Logger,
  input: CreateOidcLoginStateInput,
): Promise<Result<string, AppError>> {
  try {
    const state = randomHex32Bytes();
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        `INSERT INTO oidc_login_states (state, connection_id, nonce, code_verifier, redirect_to, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        state,
        input.connectionId,
        input.nonce,
        input.codeVerifier,
        input.redirectTo,
        new Date().toISOString(),
        now + OIDC_STATE_TTL_SECONDS,
      )
      .run();
    return ok(state);
  } catch (error) {
    logger.error("Failed to create OIDC login state", error instanceof Error ? error : undefined, {
      connectionId: input.connectionId,
    });
    return err(new AppError("Failed to create OIDC login state", "STORAGE_ERROR", 500));
  }
}

/**
 * Atomically consume a login state: exactly ONE caller succeeds even under
 * concurrent callbacks, because the guard is a single conditional UPDATE
 * (`consumed_at IS NULL AND not expired`) whose affected-row count is the
 * winner signal — the same pattern as consumeMagicLink. Returns null when the
 * state is unknown, already consumed, or expired.
 */
export async function consumeOidcLoginState(
  db: D1Database,
  logger: Logger,
  state: string,
): Promise<Result<OidcLoginState | null, AppError>> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const update = await db
      .prepare(
        "UPDATE oidc_login_states SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL AND expires_at > ?",
      )
      .bind(new Date().toISOString(), state, now)
      .run();
    if (update.meta.changes !== 1) return ok(null);

    const row = await db
      .prepare(
        "SELECT state, connection_id, nonce, code_verifier, redirect_to FROM oidc_login_states WHERE state = ?",
      )
      .bind(state)
      .first<OidcLoginStateRow>();
    if (!row) return ok(null);

    return ok({
      state: row.state,
      connectionId: row.connection_id,
      nonce: row.nonce,
      codeVerifier: row.code_verifier,
      redirectTo: row.redirect_to,
    });
  } catch (error) {
    logger.error("Failed to consume OIDC login state", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to consume OIDC login state", "STORAGE_ERROR", 500));
  }
}

/**
 * Delete expired state rows. Called opportunistically from the start route and
 * from the daily cron; consumed-but-unexpired rows keep their tombstone until
 * expiry so a replayed state stays distinguishable from an unknown one.
 */
export async function purgeExpiredOidcStates(
  db: D1Database,
  logger: Logger,
): Promise<Result<number, AppError>> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const result = await db
      .prepare("DELETE FROM oidc_login_states WHERE expires_at < ?")
      .bind(now)
      .run();
    const purged = result.meta?.changes ?? 0;
    if (purged > 0) logger.debug("Purged expired OIDC login states", { purged });
    return ok(purged);
  } catch (error) {
    logger.error("Failed to purge OIDC login states", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to purge OIDC login states", "STORAGE_ERROR", 500));
  }
}

/**
 * Re-enable the users a connection deactivated via SCIM
 * (`scim_members.active = 0`), for connection removal: deleting a connection
 * is a clean rollback, never a permanent lockout. The NOT-IN subquery is the
 * cross-connection vote guard — removing one connection must not resurrect a
 * user ANOTHER connection still deactivates (mirrors `reactivateUser`'s
 * guard), and doing it set-based in one UPDATE bounds the D1 query count on
 * large connections. `excludeUserId` skips a user whose account is being
 * erased anyway. Returns the re-enabled user ids.
 */
function reenableForRemovalStatement(
  db: D1Database,
  connectionId: string,
  excludeUserId?: string,
): D1PreparedStatement {
  const excludeClause = excludeUserId === undefined ? "" : "AND id != ?";
  const stmt = db.prepare(
    `UPDATE users SET disabled_at = NULL
     WHERE disabled_at IS NOT NULL
       AND id IN (SELECT user_id FROM scim_members WHERE connection_id = ? AND active = 0)
       AND id NOT IN (SELECT user_id FROM scim_members WHERE connection_id != ? AND active = 0)
       ${excludeClause}
     RETURNING id`,
  );
  return excludeUserId === undefined
    ? stmt.bind(connectionId, connectionId)
    : stmt.bind(connectionId, connectionId, excludeUserId);
}

export async function reenableUsersForConnectionRemoval(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  opts: { excludeUserId?: string } = {},
): Promise<Result<string[], AppError>> {
  try {
    const { results } = await reenableForRemovalStatement(
      db,
      connectionId,
      opts.excludeUserId,
    ).all<{ id: string }>();
    const reenabledUserIds = results.map((row) => row.id);
    logger.info("Re-enabled SCIM-disabled users for connection removal", {
      connectionId,
      reenabled: reenabledUserIds.length,
    });
    return ok(reenabledUserIds);
  } catch (error) {
    logger.error(
      "Failed to re-enable SCIM-disabled users",
      error instanceof Error ? error : undefined,
      { connectionId },
    );
    return err(new AppError("Failed to re-enable SCIM-disabled users", "STORAGE_ERROR", 500));
  }
}

/**
 * Delete the connection and its managed-membership rows, re-enabling the users
 * this connection's SCIM deactivated (same set-based, cross-connection-guarded
 * UPDATE as `reenableUsersForConnectionRemoval`) — all in ONE D1 batch, which
 * runs as a single transaction. Done as separate round-trips, a SCIM
 * deprovision that had already authenticated could land between the re-enable
 * and the delete: its user would be disabled, and the active=0 vote that could
 * undo it deleted, leaving the account locked out for good. Managed users
 * become ordinary org members. Returns the re-enabled user ids.
 */
export async function deleteSsoConnection(
  db: D1Database,
  logger: Logger,
  connectionId: string,
): Promise<Result<string[], AppError>> {
  try {
    const [reenabled] = await db.batch<{ id: string }>([
      reenableForRemovalStatement(db, connectionId),
      db.prepare("DELETE FROM scim_members WHERE connection_id = ?").bind(connectionId),
      db.prepare("DELETE FROM org_sso_connections WHERE id = ?").bind(connectionId),
    ]);
    const reenabledUserIds = (reenabled?.results ?? []).map((row) => row.id);
    logger.info("SSO connection deleted", {
      connectionId,
      reenabled: reenabledUserIds.length,
    });
    return ok(reenabledUserIds);
  } catch (error) {
    logger.error("Failed to delete SSO connection", error instanceof Error ? error : undefined, {
      connectionId,
    });
    return err(new AppError("Failed to delete SSO connection", "STORAGE_ERROR", 500));
  }
}

// ---------------------------------------------------------------------------
// SCIM Users scope + lifecycle (#253 Task 6)
// ---------------------------------------------------------------------------

/** A connection's SCIM member row (or its absence — visible-for-adoption). */
export interface ScimMember {
  externalId: string | null;
  active: boolean;
}

/**
 * One user as this connection's SCIM surface sees them. `managed` is whether a
 * scim_members row exists; `scimActive` is that row's flag (null when
 * unmanaged). `active` in the SCIM resource is derived from `disabledAt` —
 * the enforced truth — not from `scimActive`.
 */
export interface ScimScopedUser {
  userId: string;
  email: string;
  username: string;
  createdAt: string;
  disabledAt: string | null;
  externalId: string | null;
  managed: boolean;
  scimActive: boolean | null;
}

interface ScimScopedUserRow {
  id: string;
  email: string;
  username: string;
  created_at: string;
  disabled_at: string | null;
  scim_external_id: string | null;
  scim_active: number | null;
}

function rowToScimScopedUser(row: ScimScopedUserRow): ScimScopedUser {
  return {
    userId: row.id,
    email: row.email,
    username: row.username,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    externalId: row.scim_external_id,
    managed: row.scim_active !== null,
    scimActive: row.scim_active === null ? null : row.scim_active === 1,
  };
}

/**
 * Shared FROM/WHERE for the connection's SCIM scope: every user with a
 * scim_members row for this connection, plus every member of the connection's
 * org whose email domain is one of the connection's email domains ("visible
 * for adoption"). Soft-deleting users are excluded outright: deletion
 * dominates disable, and a mid-erasure account must not resurface to the IdP
 * or accept a reactivation.
 *
 * The domain test is a suffix match on `'@' || domain`. Connection domains
 * are validated hostnames (normalizeEmailDomains: non-empty, never containing
 * '@'), so this is exactly "the text after the email's last '@' is one of the
 * domains". The domain list binds once as JSON (json_each), so the bind count
 * stays constant (at most 7, with LIMIT/OFFSET) however many domains the connection has.
 *
 * `extraClause` is AND-ed in ahead of the scope test; positional binds follow
 * textual order, so its binds sit between the join bind and the scope binds.
 * Without one (the unfiltered list), a logically redundant membership IN-list
 * is added instead: it lets SQLite drive the query from the scim_members /
 * org_members primary keys rather than scanning every user. A selective
 * extraClause (email, externalId, id) already drives from its own index, and
 * the IN-list would only add a full read of the membership set.
 */
function scimScopeFrom(
  connection: SsoConnection,
  extraClause = "",
  extraBinds: unknown[] = [],
): { sql: string; binds: unknown[] } {
  const driver =
    extraClause === ""
      ? `AND u.id IN (SELECT user_id FROM scim_members WHERE connection_id = ?
                      UNION ALL
                      SELECT user_id FROM org_members WHERE org_id = ?)`
      : extraClause;
  const driverBinds = extraClause === "" ? [connection.id, connection.orgId] : extraBinds;
  return {
    sql: `FROM users u
     LEFT JOIN scim_members sm ON sm.user_id = u.id AND sm.connection_id = ?
     WHERE u.deleting_at IS NULL ${driver}
       AND (sm.user_id IS NOT NULL
            OR (EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = ? AND om.user_id = u.id)
                AND EXISTS (SELECT 1 FROM json_each(?) d
                            WHERE substr(u.email, -length(d.value) - 1) = '@' || d.value)))`,
    binds: [
      connection.id,
      ...driverBinds,
      connection.orgId,
      JSON.stringify(connection.emailDomains),
    ],
  };
}

const SCIM_SCOPED_USER_COLUMNS = `u.id, u.email, u.username, u.created_at, u.disabled_at,
            sm.scim_external_id, sm.active AS scim_active`;

/** A parsed SCIM list filter: the two forms Okta/Entra send. */
export interface ScimUserFilter {
  attribute: "username" | "externalid";
  value: string;
}

export interface ScimUserListQuery {
  filter?: ScimUserFilter;
  /** 1-based index of the first result. */
  startIndex: number;
  /** Page size; 0 returns only the total. */
  count: number;
}

export interface ScimUserPage {
  /** Every match, independent of the page. */
  totalResults: number;
  users: ScimScopedUser[];
}

function scimFilterClause(filter: ScimUserFilter | undefined): {
  clause: string;
  binds: unknown[];
} {
  if (!filter) return { clause: "", binds: [] };
  if (filter.attribute === "username") {
    // userName is the email. The value is trimmed and lowercased (SCIM
    // userName is case-insensitive; stored emails are lowercase) and compared
    // exactly, so the users.email UNIQUE index serves the lookup.
    return { clause: "AND u.email = ?", binds: [filter.value.trim().toLowerCase()] };
  }
  // externalId is case-exact (RFC 7643 §3.1); served by
  // idx_scim_members_external_id (connection_id, scim_external_id).
  return { clause: "AND sm.scim_external_id = ?", binds: [filter.value] };
}

/**
 * One page of the connection's SCIM scope, filtered and paged in D1 and
 * ordered by (created_at, id), plus the total match count.
 */
export async function listScimScopedUsers(
  db: D1Database,
  logger: Logger,
  connection: SsoConnection,
  query: ScimUserListQuery,
): Promise<Result<ScimUserPage, AppError>> {
  try {
    const { clause, binds: filterBinds } = scimFilterClause(query.filter);
    const scope = scimScopeFrom(connection, clause, filterBinds);
    const countStmt = db.prepare(`SELECT COUNT(*) AS n ${scope.sql}`).bind(...scope.binds);
    if (query.count <= 0) {
      const row = await countStmt.first<{ n: number }>();
      return ok({ totalResults: row?.n ?? 0, users: [] });
    }
    // OFFSET must fit an int64: an absurd startIndex is clamped, and still
    // yields an empty page just as slicing past the end did.
    const offset = Math.min(Math.max(query.startIndex - 1, 0), Number.MAX_SAFE_INTEGER);
    const pageStmt = db
      .prepare(
        `SELECT ${SCIM_SCOPED_USER_COLUMNS} ${scope.sql}
     ORDER BY u.created_at, u.id
     LIMIT ? OFFSET ?`,
      )
      .bind(...scope.binds, query.count, offset);
    // One batch: a single round-trip, and count + page read the same snapshot.
    const [countResult, pageResult] = await db.batch<unknown>([countStmt, pageStmt]);
    const total = (countResult?.results[0] as { n: number } | undefined)?.n ?? 0;
    const rows = (pageResult?.results ?? []) as ScimScopedUserRow[];
    return ok({ totalResults: total, users: rows.map(rowToScimScopedUser) });
  } catch (error) {
    logger.error("Failed to list SCIM-scoped users", error instanceof Error ? error : undefined, {
      connectionId: connection.id,
    });
    return err(new AppError("Failed to list SCIM users", "STORAGE_ERROR", 500));
  }
}

export async function getScimScopedUser(
  db: D1Database,
  logger: Logger,
  connection: SsoConnection,
  userId: string,
): Promise<Result<ScimScopedUser, NotFoundError | AppError>> {
  try {
    const scope = scimScopeFrom(connection, "AND u.id = ?", [userId]);
    const row = await db
      .prepare(`SELECT ${SCIM_SCOPED_USER_COLUMNS} ${scope.sql}`)
      .bind(...scope.binds)
      .first<ScimScopedUserRow>();
    if (!row) return err(new NotFoundError("User", userId));
    return ok(rowToScimScopedUser(row));
  } catch (error) {
    logger.error("Failed to get SCIM-scoped user", error instanceof Error ? error : undefined, {
      connectionId: connection.id,
      userId,
    });
    return err(new AppError("Failed to get SCIM user", "STORAGE_ERROR", 500));
  }
}

/** The connection's scim_members row for a user, or null when unmanaged. */
export async function getScimMember(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  userId: string,
): Promise<Result<ScimMember | null, AppError>> {
  try {
    const row = await db
      .prepare(
        "SELECT scim_external_id, active FROM scim_members WHERE connection_id = ? AND user_id = ?",
      )
      .bind(connectionId, userId)
      .first<{ scim_external_id: string | null; active: number }>();
    if (!row) return ok(null);
    return ok({ externalId: row.scim_external_id, active: row.active === 1 });
  } catch (error) {
    logger.error("Failed to get scim_members row", error instanceof Error ? error : undefined, {
      connectionId,
      userId,
    });
    return err(new AppError("Failed to get managed membership", "STORAGE_ERROR", 500));
  }
}

/**
 * Set (or clear, with null) the IdP's externalId on the connection's
 * membership row. The row must already exist — callers ensureScimMember first.
 * An externalId already assigned to ANOTHER user on the same connection
 * violates the migration-043 unique index and returns a ConflictError.
 */
export async function setScimMemberExternalId(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  userId: string,
  externalId: string | null,
): Promise<Result<void, ConflictError | AppError>> {
  try {
    await db
      .prepare(
        "UPDATE scim_members SET scim_external_id = ? WHERE connection_id = ? AND user_id = ?",
      )
      .bind(externalId, connectionId, userId)
      .run();
    return ok(undefined);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      logger.warn("SCIM externalId already assigned on this connection", { connectionId, userId });
      return err(new ConflictError("externalId is already assigned to another user"));
    }
    logger.error("Failed to set SCIM externalId", error instanceof Error ? error : undefined, {
      connectionId,
      userId,
    });
    return err(new AppError("Failed to set SCIM externalId", "STORAGE_ERROR", 500));
  }
}

/** Upsert the connection's membership row with the given active flag. */
async function upsertScimMemberActive(
  db: D1Database,
  connectionId: string,
  userId: string,
  active: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO scim_members (connection_id, user_id, active, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (connection_id, user_id) DO UPDATE SET active = excluded.active`,
    )
    .bind(connectionId, userId, active ? 1 : 0, new Date().toISOString())
    .run();
}

/**
 * The org a connection belongs to, spread into a recordAudit call so SCIM
 * lifecycle rows land in that org's trail (#255). Best-effort: a failed
 * lookup records the row unscoped rather than failing a completed transition.
 */
async function connectionOrgId(
  db: D1Database,
  logger: Logger,
  connectionId: string,
): Promise<{ orgId?: string }> {
  try {
    const row = await db
      .prepare("SELECT org_id FROM org_sso_connections WHERE id = ?")
      .bind(connectionId)
      .first<{ org_id: string }>();
    return row ? { orgId: row.org_id } : {};
  } catch (error) {
    logger.warn("Failed to resolve SSO connection org for audit", {
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * SCIM deactivation: record who disabled whom (scim_members.active = 0), set
 * the enforced flag (users.disabled_at), then purge sessions. Any storage
 * failure fails the whole request — deprovision must never report success
 * while sessions survive — but the ordering guarantees the enforced flag
 * holds even when the session purge fails (the middleware then rejects the
 * surviving sessions anyway). Idempotent: rerunning changes nothing. Audits
 * are best-effort per the recordAudit contract; agentIds enumerate the
 * credentials made inert by the flag.
 */
export async function deprovisionUser(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  userId: string,
): Promise<Result<{ disabledAt: string }, AppError>> {
  try {
    await upsertScimMemberActive(db, connectionId, userId, false);
  } catch (error) {
    logger.error("Failed to record SCIM deactivation", error instanceof Error ? error : undefined, {
      connectionId,
      userId,
    });
    return err(new AppError("Failed to record SCIM deactivation", "STORAGE_ERROR", 500));
  }

  const disableResult = await disableUser(db, userId, logger);
  if (!disableResult.success) return err(disableResult.error);

  const purgeResult = await deleteAllUserSessions(db, userId, logger);
  if (!purgeResult.success) return err(purgeResult.error);

  // Audit detail only — a lookup failure must not fail a completed deprovision.
  const agentsResult = await listAgents(db, userId, logger);
  const agentIds = agentsResult.success ? agentsResult.data.map((agent) => agent.id) : [];
  const detail = { via: "scim", connectionId, userId, agentIds };
  const orgId = await connectionOrgId(db, logger, connectionId);
  await recordAudit(db, logger, {
    action: "scim.user.deactivated",
    actorType: "system",
    subject: connectionId,
    ...orgId,
    detail,
  });
  await recordAudit(db, logger, {
    action: "user.disabled",
    actorType: "system",
    subject: connectionId,
    ...orgId,
    detail,
  });

  logger.info("SCIM user deprovisioned", { connectionId, userId });
  return ok({ disabledAt: disableResult.data });
}

/**
 * SCIM reactivation: mark this connection's membership active again, and clear
 * users.disabled_at only when NO other connection still holds an active
 * deactivation for the user — one IdP unsuspending an account must not undo
 * another IdP's suspension. Idempotent. A failed guard read fails CLOSED (the
 * account stays disabled) rather than enabling on unknown state.
 */
export async function reactivateUser(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  userId: string,
): Promise<Result<{ enabled: boolean }, AppError>> {
  try {
    await upsertScimMemberActive(db, connectionId, userId, true);
  } catch (error) {
    logger.error("Failed to record SCIM reactivation", error instanceof Error ? error : undefined, {
      connectionId,
      userId,
    });
    return err(new AppError("Failed to record SCIM reactivation", "STORAGE_ERROR", 500));
  }

  let blocked: boolean;
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM scim_members WHERE user_id = ? AND active = 0")
      .bind(userId)
      .first<{ n: number }>();
    blocked = (row?.n ?? 0) > 0;
  } catch (error) {
    logger.error("Failed to check reactivation guard", error instanceof Error ? error : undefined, {
      connectionId,
      userId,
    });
    return err(new AppError("Failed to check reactivation guard", "STORAGE_ERROR", 500));
  }

  if (!blocked) {
    const enableResult = await enableUser(db, userId, logger);
    if (!enableResult.success) return err(enableResult.error);
  }

  const detail = { via: "scim", connectionId, userId };
  const orgId = await connectionOrgId(db, logger, connectionId);
  await recordAudit(db, logger, {
    action: "scim.user.reactivated",
    actorType: "system",
    subject: connectionId,
    ...orgId,
    detail,
  });
  if (!blocked) {
    await recordAudit(db, logger, {
      action: "user.enabled",
      actorType: "system",
      subject: connectionId,
      ...orgId,
      detail,
    });
  }

  logger.info("SCIM user reactivated", { connectionId, userId, enabled: !blocked });
  return ok({ enabled: !blocked });
}
