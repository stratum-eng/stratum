import { type Context, Hono } from "hono";
import {
  checkDomainTxtRecord,
  verificationRecordName,
  verificationTxtValue,
} from "../services/domain-verification";
import { discoverOidcConfiguration } from "../services/oidc-discovery";
import { recordAudit } from "../storage/audit";
import { type Org, getOrgBySlug, isOrgAdmin, isOrgMember } from "../storage/orgs";
import {
  type SsoConnection,
  deleteSsoConnection,
  findVerifiedDomainConflicts,
  getSsoConnectionByOrgId,
  normalizeEmailDomains,
  rotateScimToken,
  setSsoConnectionEnabled,
  setSsoDomainsVerified,
  upsertSsoConnection,
} from "../storage/sso";
import type { Env } from "../types";
import { SSO_SECRET_SALT, encryptToken } from "../utils/crypto";
import { ConflictError, ValidationError } from "../utils/errors";
import { type Logger, createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { appError, badRequest, forbidden, notFound, ok } from "../utils/response";

/**
 * Org SSO admin API (#253 Task 4), mounted under /api/orgs/:slug/sso behind
 * authMiddleware. Every endpoint is gated on org admin (role 'admin' OR the
 * orgs.owner_id column — no code path ever writes an 'owner' role, and the
 * owner's member row may have been removed). The client secret is accepted in
 * request bodies only and never echoed; the SCIM token plaintext is shown
 * exactly once at rotation.
 */

const app = new Hono<{ Bindings: Env }>();

// Config bodies are a handful of short strings plus a small domain list.
const MAX_SSO_BODY_BYTES = 64 * 1024;

interface OrgAdminContext {
  org: Org;
  userId: string;
  logger: Logger;
}

type SsoHandlerContext = Context<{ Bindings: Env }>;

/**
 * Shared gate: 501 without SSO_ENCRYPTION_SECRET, then org-admin authz.
 * Non-members get the same 404 as a missing org (no existence leak);
 * members without admin get 403.
 */
async function requireOrgAdmin(c: SsoHandlerContext): Promise<OrgAdminContext | Response> {
  if (!c.env.SSO_ENCRYPTION_SECRET) {
    return c.json({ error: "SSO is not configured on this server" }, 501);
  }

  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const slug = c.req.param("slug") ?? "";
  const logger = createLogger({ path: c.req.path, userId, slug });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for SSO admin request", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  const isAdmin = (adminResult.success && adminResult.data) || org.ownerId === userId;
  if (!isAdmin) {
    const memberResult = await isOrgMember(c.env.DB, logger, org.id, userId);
    if (memberResult.success && memberResult.data) {
      logger.warn("Non-admin member denied SSO admin access", { orgId: org.id, userId });
      return forbidden("Forbidden");
    }
    // Fail closed: non-members and membership-lookup errors both get the
    // missing-org 404.
    logger.debug("SSO admin access denied (non-member or lookup failure)", { orgId: org.id });
    return notFound("Org", slug);
  }

  return { org, userId, logger };
}

/** Admin-facing view: everything except the secret ciphertext and SCIM hash. */
function redactConnection(connection: SsoConnection) {
  return {
    id: connection.id,
    orgId: connection.orgId,
    protocol: connection.protocol,
    issuer: connection.issuer,
    clientId: connection.clientId,
    authorizationEndpoint: connection.authorizationEndpoint,
    tokenEndpoint: connection.tokenEndpoint,
    jwksUri: connection.jwksUri,
    emailDomains: connection.emailDomains,
    domainsVerifiedAt: connection.domainsVerifiedAt,
    enabled: connection.enabled,
    scimTokenSet: connection.scimTokenHash !== null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/** The DNS records an admin must publish, retrievable any time before verification. */
function domainVerificationInfo(connection: SsoConnection) {
  const token = connection.domainVerificationToken;
  if (!token) return null;
  return {
    token,
    records: connection.emailDomains.map((domain) => ({
      domain,
      name: verificationRecordName(domain),
      type: "TXT" as const,
      value: verificationTxtValue(token),
    })),
    instructions:
      "Publish each TXT record at the name shown, then call POST /verify-domains. " +
      "All listed domains must verify before the connection can be enabled.",
  };
}

app.put("/:slug/sso", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  const { org, userId, logger } = ctx;

  let body: {
    issuer?: unknown;
    clientId?: unknown;
    clientSecret?: unknown;
    emailDomains?: unknown;
  };
  // Malformed JSON must be a 400, not a rethrow into the global 500 handler;
  // the empty-object fallback fails the required-field checks below.
  const parsed = await readJsonWithLimit<typeof body>(c, MAX_SSO_BODY_BYTES, logger).catch(
    () => ({}),
  );
  if (parsed instanceof Response) return parsed;
  body = parsed;

  if (typeof body.issuer !== "string" || !body.issuer.trim()) {
    return badRequest("issuer is required");
  }
  if (typeof body.clientId !== "string" || !body.clientId.trim()) {
    return badRequest("clientId is required");
  }
  if (typeof body.clientSecret !== "string" || !body.clientSecret) {
    return badRequest("clientSecret is required");
  }
  if (!Array.isArray(body.emailDomains) || !body.emailDomains.every((d) => typeof d === "string")) {
    return badRequest("emailDomains must be an array of strings");
  }

  const domainsResult = normalizeEmailDomains(body.emailDomains);
  if (!domainsResult.success) return appError(domainsResult.error);
  const emailDomains = domainsResult.data;

  const discoveryResult = await discoverOidcConfiguration(body.issuer.trim(), logger);
  if (!discoveryResult.success) return appError(discoveryResult.error);
  const endpoints = discoveryResult.data;
  // Store the discovery module's canonical (trailing-slash-normalized) issuer,
  // not the admin's raw input, so id_token `iss` comparisons stay exact.
  const issuer = endpoints.issuer;

  // c.env.SSO_ENCRYPTION_SECRET is set — requireOrgAdmin 501s otherwise.
  const secret = c.env.SSO_ENCRYPTION_SECRET as string;
  const ciphertext = await encryptToken(body.clientSecret, secret, SSO_SECRET_SALT);

  const upsertResult = await upsertSsoConnection(c.env.DB, logger, {
    orgId: org.id,
    issuer,
    clientId: body.clientId.trim(),
    clientSecretCiphertext: ciphertext,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
    jwksUri: endpoints.jwksUri,
    emailDomains,
  });
  if (!upsertResult.success) return appError(upsertResult.error);
  const { connection, created } = upsertResult.data;

  await recordAudit(c.env.DB, logger, {
    action: created ? "sso.connection.created" : "sso.connection.updated",
    actorType: "user",
    actorId: userId,
    subject: org.id,
    detail: { connectionId: connection.id, issuer, emailDomains },
  });

  return ok(
    {
      connection: redactConnection(connection),
      domainVerification: domainVerificationInfo(connection),
    },
    created ? 201 : 200,
  );
});

app.get("/:slug/sso", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  const { org, logger } = ctx;

  const connectionResult = await getSsoConnectionByOrgId(c.env.DB, logger, org.id);
  if (!connectionResult.success) return appError(connectionResult.error);
  const connection = connectionResult.data;

  return ok({
    connection: redactConnection(connection),
    domainVerification: domainVerificationInfo(connection),
  });
});

app.delete("/:slug/sso", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  const { org, userId, logger } = ctx;

  const connectionResult = await getSsoConnectionByOrgId(c.env.DB, logger, org.id);
  if (!connectionResult.success) return appError(connectionResult.error);
  const connection = connectionResult.data;

  // Deleting a connection is a clean rollback, never a permanent lockout:
  // users this connection deactivated via SCIM get their accounts back, in the
  // same transaction as the delete (see deleteSsoConnection).
  const deleteResult = await deleteSsoConnection(c.env.DB, logger, connection.id);
  if (!deleteResult.success) return appError(deleteResult.error);
  const reenabledUserIds = deleteResult.data;

  await recordAudit(c.env.DB, logger, {
    action: "sso.connection.deleted",
    actorType: "user",
    actorId: userId,
    subject: org.id,
    detail: { connectionId: connection.id, reenabledUserIds },
  });

  return ok({ deleted: true, reenabledUserIds });
});

app.post("/:slug/sso/verify-domains", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  const { org, userId, logger } = ctx;

  const connectionResult = await getSsoConnectionByOrgId(c.env.DB, logger, org.id);
  if (!connectionResult.success) return appError(connectionResult.error);
  const connection = connectionResult.data;

  if (!connection.domainVerificationToken) {
    return appError(new ValidationError("Connection has no domain verification token"));
  }

  // A malformed stored email_domains list parses to [] — the DoH loop below
  // would then be vacuous and stamp a verification that checked nothing.
  if (connection.emailDomains.length === 0) {
    return appError(new ValidationError("Connection has no email domains to verify"));
  }

  // Verified domains are globally unique across connections. Two connections
  // concurrently verifying the same domain can both pass this check and both
  // stamp, after which both 409 at enable time — bounded (it requires both
  // orgs to control the domain's DNS, effectively impossible) and accepted;
  // recovery is editing one connection's domain list, which clears its
  // verification.
  const conflictsResult = await findVerifiedDomainConflicts(
    c.env.DB,
    logger,
    connection.emailDomains,
    connection.id,
  );
  if (!conflictsResult.success) return appError(conflictsResult.error);
  if (conflictsResult.data.length > 0) {
    return appError(
      new ConflictError(
        `Domains already verified by another connection: ${conflictsResult.data.join(", ")}`,
      ),
    );
  }

  const failedDomains: string[] = [];
  for (const domain of connection.emailDomains) {
    const checkResult = await checkDomainTxtRecord(
      domain,
      connection.domainVerificationToken,
      logger,
    );
    if (!checkResult.success) return appError(checkResult.error);
    if (!checkResult.data) failedDomains.push(domain);
  }
  if (failedDomains.length > 0) {
    return c.json(
      {
        error: "Domain verification failed: TXT record missing or incorrect",
        code: "DOMAIN_VERIFICATION_FAILED",
        failedDomains,
      },
      400,
    );
  }

  // Stamp conditionally on the exact list the DoH checks ran against; a
  // concurrent PUT that edited the domains mid-verification surfaces as a 409.
  const verifyResult = await setSsoDomainsVerified(
    c.env.DB,
    logger,
    connection.id,
    connection.emailDomains,
  );
  if (!verifyResult.success) return appError(verifyResult.error);

  await recordAudit(c.env.DB, logger, {
    action: "sso.domain.verified",
    actorType: "user",
    actorId: userId,
    subject: org.id,
    detail: { connectionId: connection.id, domains: connection.emailDomains },
  });

  return ok({
    verified: true,
    domains: connection.emailDomains,
    domainsVerifiedAt: verifyResult.data,
  });
});

app.post("/:slug/sso/enable", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  const { org, userId, logger } = ctx;

  const connectionResult = await getSsoConnectionByOrgId(c.env.DB, logger, org.id);
  if (!connectionResult.success) return appError(connectionResult.error);
  const connection = connectionResult.data;

  if (!connection.domainsVerifiedAt) {
    return appError(
      new ValidationError("Connection cannot be enabled until its domains are verified"),
    );
  }

  // Re-check global uniqueness at enable time: a competing connection may
  // have verified an overlapping domain since this one verified.
  const conflictsResult = await findVerifiedDomainConflicts(
    c.env.DB,
    logger,
    connection.emailDomains,
    connection.id,
  );
  if (!conflictsResult.success) return appError(conflictsResult.error);
  if (conflictsResult.data.length > 0) {
    return appError(
      new ConflictError(
        `Domains already verified by another connection: ${conflictsResult.data.join(", ")}`,
      ),
    );
  }

  const enableResult = await setSsoConnectionEnabled(c.env.DB, logger, connection.id, true);
  if (!enableResult.success) return appError(enableResult.error);

  await recordAudit(c.env.DB, logger, {
    action: "sso.connection.updated",
    actorType: "user",
    actorId: userId,
    subject: org.id,
    detail: { connectionId: connection.id, enabled: true },
  });

  return ok({ enabled: true });
});

app.post("/:slug/sso/disable", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  const { org, userId, logger } = ctx;

  const connectionResult = await getSsoConnectionByOrgId(c.env.DB, logger, org.id);
  if (!connectionResult.success) return appError(connectionResult.error);
  const connection = connectionResult.data;

  const disableResult = await setSsoConnectionEnabled(c.env.DB, logger, connection.id, false);
  if (!disableResult.success) return appError(disableResult.error);

  await recordAudit(c.env.DB, logger, {
    action: "sso.connection.updated",
    actorType: "user",
    actorId: userId,
    subject: org.id,
    detail: { connectionId: connection.id, enabled: false },
  });

  return ok({ enabled: false });
});

app.post("/:slug/sso/scim-token", async (c) => {
  const ctx = await requireOrgAdmin(c);
  if (ctx instanceof Response) return ctx;
  const { org, userId, logger } = ctx;

  const connectionResult = await getSsoConnectionByOrgId(c.env.DB, logger, org.id);
  if (!connectionResult.success) return appError(connectionResult.error);
  const connection = connectionResult.data;

  const rotateResult = await rotateScimToken(c.env.DB, logger, connection.id);
  if (!rotateResult.success) return appError(rotateResult.error);

  await recordAudit(c.env.DB, logger, {
    action: "sso.scim_token.rotated",
    actorType: "user",
    actorId: userId,
    subject: org.id,
    detail: { connectionId: connection.id },
  });

  // Plaintext is returned exactly once; only the hash is stored.
  return ok({ scimToken: rotateResult.data });
});

export { app as orgSsoRouter };
