import { type Context, Hono } from "hono";
import { deriveUsernameBase, findAvailableUsername } from "../services/sso-usernames";
import { recordAudit } from "../storage/audit";
import { ensureOrgMember } from "../storage/orgs";
import {
  type ScimScopedUser,
  type SsoConnection,
  deprovisionUser,
  ensureScimMember,
  getScimMember,
  getScimScopedUser,
  getSsoConnectionById,
  listScimScopedUsers,
  reactivateUser,
  setScimMemberExternalId,
} from "../storage/sso";
import { createUser, getUserByEmail } from "../storage/users";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";

/**
 * SCIM 2.0 Users endpoints (#253 Task 6), mounted at /scim/v2. Auth is a
 * `stratum_scim_*` bearer resolved by authMiddleware to a scimConnectionId —
 * every handler here FAILS CLOSED unless that var is set: a session cookie or
 * user/agent bearer is never honored on this surface, because SCIM writes are
 * org-lifecycle operations authorized by the connection's token alone.
 *
 * Deviations from RFC 7644, chosen for real IdP behavior (Okta/Entra):
 * - DELETE deactivates instead of erasing; a later GET returns the resource
 *   with active:false. (Okta's lifecycle uses PATCH active:false; a DELETE
 *   that destroyed data would make an IdP misconfiguration unrecoverable.)
 * - PATCH ignores ops on attributes we don't store (displayName, name.*,
 *   enterprise-extension paths, ...) instead of erroring: Okta and Entra send
 *   them on every profile sync, and a 4xx would mark the whole user as failed.
 *   Stored attributes accept replace AND add (Entra sends Add on link; RFC
 *   7644 add-on-existing-attribute replaces); only remove ops on stored
 *   attributes and malformed values are rejected.
 */

const app = new Hono<{ Bindings: Env }>();

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_CONTENT_TYPE = "application/scim+json";
// SCIM payloads are one user each; Entra's PATCH envelopes are the largest.
const MAX_SCIM_BODY_BYTES = 256 * 1024;
const DEFAULT_PAGE_COUNT = 100;
const MAX_PAGE_COUNT = 200;

type ScimContext = Context<{ Bindings: Env }>;

function scimJson(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  // The explicit Content-Type in init survives Response.json's default.
  return Response.json(body, {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE, ...headers },
  });
}

function scimError(status: number, detail: string, scimType?: string): Response {
  const body: Record<string, unknown> = {
    schemas: [ERROR_SCHEMA],
    status: String(status),
    detail,
  };
  if (scimType) body.scimType = scimType;
  return scimJson(body, status);
}

interface ScimRequestContext {
  connection: SsoConnection;
  logger: Logger;
}

/**
 * Fail-closed gate + connection load. The connection row is re-read per
 * request (authMiddleware stores only ids) — a connection deleted or disabled
 * mid-flight 401s rather than operating on stale scope.
 */
async function requireScimConnection(c: ScimContext): Promise<ScimRequestContext | Response> {
  const connectionId = c.get("scimConnectionId");
  if (!connectionId) {
    return scimError(401, "SCIM requests must authenticate with a SCIM bearer token");
  }
  const logger = createLogger({
    path: c.req.path,
    method: c.req.method,
    connectionId,
  });
  const connectionResult = await getSsoConnectionById(c.env.DB, logger, connectionId);
  if (
    !connectionResult.success ||
    !connectionResult.data.enabled ||
    connectionResult.data.domainsVerifiedAt === null
  ) {
    logger.warn("SCIM connection no longer usable");
    return scimError(401, "SCIM connection is no longer available");
  }
  return { connection: connectionResult.data, logger };
}

function userLocation(c: ScimContext, userId: string): string {
  return `${new URL(c.req.url).origin}/scim/v2/Users/${userId}`;
}

/** `active` reflects users.disabled_at — the enforced truth — not the IdP's last write. */
function userResource(c: ScimContext, user: ScimScopedUser): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    schemas: [USER_SCHEMA],
    id: user.userId,
    userName: user.email,
    active: user.disabledAt === null,
    name: { formatted: user.username },
    emails: [{ value: user.email, primary: true }],
    meta: {
      resourceType: "User",
      created: user.createdAt,
      location: userLocation(c, user.userId),
    },
  };
  if (user.externalId !== null) resource.externalId = user.externalId;
  return resource;
}

async function readScimBody(
  c: ScimContext,
  logger: Logger,
): Promise<Record<string, unknown> | Response> {
  const body = await readJsonWithLimit<unknown>(c, MAX_SCIM_BODY_BYTES, logger).catch(() => null);
  if (body instanceof Response) {
    // readJsonWithLimit's 413 is the repo's plain {error, code} shape; this
    // surface answers in the SCIM Error schema.
    if (body.status === 413) return scimError(413, "Request body too large");
    return body;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return scimError(400, "Request body must be a JSON object", "invalidSyntax");
  }
  return body as Record<string, unknown>;
}

/**
 * Coerce a SCIM `active` value. Entra sends string booleans ("True"/"False");
 * Okta sends real booleans. Returns undefined for anything else so the caller
 * can 400 with invalidValue.
 */
function coerceActive(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

// Exactly the two filter forms Okta/Entra send during provisioning:
// `userName eq "value"` / `externalId eq "value"` (attribute and operator
// case-insensitive, value double-quoted). Anything else is unsupported.
const FILTER_PATTERN = /^\s*(userName|externalId)\s+eq\s+"([^"]*)"\s*$/i;

function parseFilter(raw: string): { attribute: "username" | "externalid"; value: string } | null {
  const match = FILTER_PATTERN.exec(raw);
  if (!match) return null;
  return {
    attribute: (match[1] ?? "").toLowerCase() as "username" | "externalid",
    value: match[2] ?? "",
  };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Apply an `active` transition through the enforced lifecycle. The skip is
 * PER-DIRECTION: a transition is skipped only when the desired direction is
 * already FULLY applied (deactivate: disabled AND this connection's vote is
 * active=0; activate: enabled AND this connection's vote is not active=0) —
 * so an idempotent full-sync PUT/PATCH doesn't re-run (and re-audit) a
 * completed transition, while a half-applied drift state (e.g. a partial
 * deprovision failure) or a missing deactivation vote on an account another
 * connection disabled still triggers the transition that repairs it.
 * Transitions themselves are idempotent, so over-calling is safe.
 */
async function applyActiveTransition(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  user: ScimScopedUser,
  desiredActive: boolean,
): Promise<Response | null> {
  const skip = desiredActive
    ? user.disabledAt === null && user.scimActive !== false
    : user.disabledAt !== null && user.scimActive === false;
  if (skip) return null;
  const result = desiredActive
    ? await reactivateUser(db, logger, connectionId, user.userId)
    : await deprovisionUser(db, logger, connectionId, user.userId);
  if (!result.success) {
    return scimError(500, desiredActive ? "Failed to activate user" : "Failed to deactivate user");
  }
  return null;
}

/** Set externalId (adopting the user into management if needed). */
async function applyExternalId(
  db: D1Database,
  logger: Logger,
  connectionId: string,
  userId: string,
  externalId: string | null,
): Promise<Response | null> {
  const ensureResult = await ensureScimMember(db, logger, connectionId, userId);
  if (!ensureResult.success) return scimError(500, "Failed to update user");
  const setResult = await setScimMemberExternalId(db, logger, connectionId, userId, externalId);
  if (!setResult.success) {
    if (setResult.error.code === "CONFLICT") {
      return scimError(409, "externalId is already assigned to another user", "uniqueness");
    }
    return scimError(500, "Failed to update user");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery endpoints — static, but still auth-gated (they reveal nothing
// secret; the gate is uniformity: NOTHING under /scim/v2 answers without the
// connection's token).
// ---------------------------------------------------------------------------

app.get("/ServiceProviderConfig", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const origin = new URL(c.req.url).origin;
  return scimJson({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: `${origin}/docs`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Authorization: Bearer <SCIM token issued by the org's Stratum admin>",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${origin}/scim/v2/ServiceProviderConfig`,
    },
  });
});

app.get("/ResourceTypes", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const origin = new URL(c.req.url).origin;
  return scimJson({
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        description: "Stratum user account",
        schema: USER_SCHEMA,
        meta: { resourceType: "ResourceType", location: `${origin}/scim/v2/ResourceTypes/User` },
      },
    ],
  });
});

app.get("/Schemas", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const origin = new URL(c.req.url).origin;
  return scimJson({
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [
      {
        id: USER_SCHEMA,
        name: "User",
        description: "Stratum user account",
        attributes: [
          {
            name: "userName",
            type: "string",
            multiValued: false,
            required: true,
            caseExact: false,
            mutability: "immutable",
            returned: "default",
            uniqueness: "server",
            description: "The user's email address",
          },
          {
            name: "active",
            type: "boolean",
            multiValued: false,
            required: false,
            mutability: "readWrite",
            returned: "default",
            description: "Whether the account's credentials work",
          },
          {
            name: "name",
            type: "complex",
            multiValued: false,
            required: false,
            mutability: "readOnly",
            returned: "default",
            subAttributes: [
              {
                name: "formatted",
                type: "string",
                multiValued: false,
                required: false,
                mutability: "readOnly",
                returned: "default",
              },
            ],
          },
          {
            name: "emails",
            type: "complex",
            multiValued: true,
            required: false,
            mutability: "readOnly",
            returned: "default",
            subAttributes: [
              {
                name: "value",
                type: "string",
                multiValued: false,
                required: false,
                mutability: "readOnly",
                returned: "default",
              },
              {
                name: "primary",
                type: "boolean",
                multiValued: false,
                required: false,
                mutability: "readOnly",
                returned: "default",
              },
            ],
          },
        ],
        meta: {
          resourceType: "Schema",
          location: `${origin}/scim/v2/Schemas/${USER_SCHEMA}`,
        },
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

app.get("/Users", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const { connection, logger } = ctx;

  const listResult = await listScimScopedUsers(c.env.DB, logger, connection);
  if (!listResult.success) return scimError(500, "Failed to list users");
  let users = listResult.data;

  const rawFilter = c.req.query("filter");
  if (rawFilter !== undefined) {
    const filter = parseFilter(rawFilter);
    if (!filter) {
      // RFC 7644 §3.4.2.2: an unsupported filter is 501, not an empty list —
      // an empty 200 would make the IdP believe the user does not exist.
      return scimError(501, "Only 'userName eq \"...\"' and 'externalId eq \"...\"' are supported");
    }
    users = users.filter((user) =>
      filter.attribute === "username"
        ? user.email === filter.value.trim().toLowerCase()
        : user.externalId === filter.value,
    );
  }

  const startIndex = Math.max(parsePositiveInt(c.req.query("startIndex")) ?? 1, 1);
  // RFC 7644 §3.4.2.4: count=0 (and any negative value, treated as 0) returns
  // totalResults with no Resources.
  const count = Math.min(
    Math.max(parsePositiveInt(c.req.query("count")) ?? DEFAULT_PAGE_COUNT, 0),
    MAX_PAGE_COUNT,
  );
  const page = count === 0 ? [] : users.slice(startIndex - 1, startIndex - 1 + count);

  return scimJson({
    schemas: [LIST_SCHEMA],
    totalResults: users.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page.map((user) => userResource(c, user)),
  });
});

app.get("/Users/:id", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const { connection, logger } = ctx;

  const userResult = await getScimScopedUser(c.env.DB, logger, connection, c.req.param("id"));
  if (!userResult.success) {
    if (userResult.error.code === "NOT_FOUND") return scimError(404, "User not found");
    return scimError(500, "Failed to get user");
  }
  return scimJson(userResource(c, userResult.data));
});

app.post("/Users", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const { connection, logger } = ctx;

  const body = await readScimBody(c, logger);
  if (body instanceof Response) return body;

  const rawUserName = body.userName;
  if (typeof rawUserName !== "string" || rawUserName.trim().length === 0) {
    return scimError(400, "userName is required", "invalidValue");
  }
  const email = rawUserName.trim().toLowerCase();
  const domain = email.includes("@") ? (email.split("@").pop() ?? "") : "";
  if (!connection.emailDomains.includes(domain)) {
    return scimError(
      400,
      "userName must be an email address within the connection's verified domains",
      "invalidValue",
    );
  }

  const externalId = typeof body.externalId === "string" ? body.externalId : undefined;
  const active = body.active === undefined ? true : coerceActive(body.active);
  if (active === undefined) {
    return scimError(400, "active must be a boolean", "invalidValue");
  }

  const existing = await getUserByEmail(c.env.DB, email, logger);
  let userId: string;
  let adopted: boolean;
  // Set when the payload asks for active:true but the account is currently
  // deactivated for this connection — a retried POST must repair that.
  let needsReactivation = false;
  if (existing.success) {
    // A soft-deleting account still owns the email; it cannot be adopted and
    // the email cannot be reissued mid-erasure.
    if (existing.data.deletingAt) {
      return scimError(409, "A conflicting account already exists", "uniqueness");
    }
    const memberResult = await getScimMember(c.env.DB, logger, connection.id, existing.data.id);
    if (!memberResult.success) return scimError(500, "Failed to provision user");
    if (memberResult.data !== null) {
      // An already-managed user is not automatically a conflict: a retried
      // POST after a partial provision must finish the job — IdPs stop
      // retrying on 409 and would strand the account in whatever state the
      // failed step never reached. Only a mismatched externalId against a
      // non-null stored one is a genuine uniqueness conflict; otherwise
      // converge and let the normal flow re-apply the remaining steps.
      if (
        externalId !== undefined &&
        memberResult.data.externalId !== null &&
        memberResult.data.externalId !== externalId
      ) {
        return scimError(409, "User is already provisioned for this connection", "uniqueness");
      }
      needsReactivation =
        existing.data.disabledAt !== undefined || memberResult.data.active === false;
    }
    userId = existing.data.id;
    adopted = true;
  } else {
    // The beta gate is deliberately bypassed here (as in OIDC JIT): SCIM
    // provisioning is authorized by the connection's DNS-verified email
    // domain, a stronger gate than a referral code.
    const base = deriveUsernameBase(email);
    const created = await createUser(
      c.env.DB,
      email,
      logger,
      await findAvailableUsername(c.env.DB, logger, base),
    );
    if (created.success) {
      userId = created.data.user.id;
      adopted = false;
    } else {
      // The insert may have lost the EMAIL race: a concurrent OIDC JIT login
      // or duplicate POST created the account after the existence check above.
      // If the user exists now, fall into the adopt path instead of erroring.
      const raced = await getUserByEmail(c.env.DB, email, logger);
      if (raced.success) {
        if (raced.data.deletingAt) {
          return scimError(409, "A conflicting account already exists", "uniqueness");
        }
        userId = raced.data.id;
        adopted = true;
      } else {
        // Otherwise a concurrent claim won the USERNAME race; re-derive once.
        const retried = await createUser(
          c.env.DB,
          email,
          logger,
          await findAvailableUsername(c.env.DB, logger, base),
        );
        if (!retried.success) return scimError(500, "Failed to provision user");
        userId = retried.data.user.id;
        adopted = false;
      }
    }
  }

  // ensureOrgMember, never addOrgMember: adopting an org owner/admin into
  // SCIM management must not demote their existing role.
  const orgResult = await ensureOrgMember(c.env.DB, logger, connection.orgId, userId, "member");
  if (!orgResult.success) return scimError(500, "Failed to provision user");
  const memberResult = await ensureScimMember(c.env.DB, logger, connection.id, userId);
  if (!memberResult.success) return scimError(500, "Failed to provision user");
  if (externalId !== undefined) {
    const setResult = await setScimMemberExternalId(
      c.env.DB,
      logger,
      connection.id,
      userId,
      externalId,
    );
    if (!setResult.success) {
      if (setResult.error.code === "CONFLICT") {
        return scimError(409, "externalId is already assigned to another user", "uniqueness");
      }
      return scimError(500, "Failed to provision user");
    }
  }
  if (!active) {
    const deprovisionResult = await deprovisionUser(c.env.DB, logger, connection.id, userId);
    if (!deprovisionResult.success) return scimError(500, "Failed to provision user");
  } else if (needsReactivation) {
    // Convergence applies BOTH active directions: idempotent, and carries the
    // cross-connection guard, so a repaired retry cannot override another
    // connection's standing deactivation.
    const reactivateResult = await reactivateUser(c.env.DB, logger, connection.id, userId);
    if (!reactivateResult.success) return scimError(500, "Failed to provision user");
  }

  await recordAudit(c.env.DB, logger, {
    action: "scim.user.provisioned",
    actorType: "system",
    subject: userId,
    detail: { via: "scim", connectionId: connection.id, adopted },
  });

  const provisioned = await getScimScopedUser(c.env.DB, logger, connection, userId);
  if (!provisioned.success) return scimError(500, "Failed to provision user");
  // RFC 7644 §3.3: creation answers 201 with a Location header — including
  // adoption/convergence, where "created" means "now managed here"; Okta and
  // Entra key off the 201 + Location pair.
  return scimJson(userResource(c, provisioned.data), 201, {
    Location: userLocation(c, provisioned.data.userId),
  });
});

app.put("/Users/:id", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const { connection, logger } = ctx;

  const userResult = await getScimScopedUser(c.env.DB, logger, connection, c.req.param("id"));
  if (!userResult.success) {
    if (userResult.error.code === "NOT_FOUND") return scimError(404, "User not found");
    return scimError(500, "Failed to get user");
  }
  const user = userResult.data;

  const body = await readScimBody(c, logger);
  if (body instanceof Response) return body;

  // users.email is UNIQUE and load-bearing (login, git identity, audit trail);
  // silently ignoring a rename would leave the IdP believing it succeeded and
  // desync every future userName-filtered lookup — so reject loudly instead.
  if (typeof body.userName === "string" && body.userName.trim().toLowerCase() !== user.email) {
    return scimError(400, "userName cannot be changed", "mutability");
  }
  // Every field is validated before anything is written, so a 400 neither
  // adopts the user nor leaves a half-applied update (e.g. a new externalId
  // already stored and audited when `active` turns out to be malformed).
  if (
    body.externalId !== undefined &&
    typeof body.externalId !== "string" &&
    body.externalId !== null
  ) {
    return scimError(400, "externalId must be a string", "invalidValue");
  }
  const desiredActive = body.active === undefined ? undefined : coerceActive(body.active);
  if (body.active !== undefined && desiredActive === undefined) {
    return scimError(400, "active must be a boolean", "invalidValue");
  }

  // Any successful write verb adopts: after a 2xx the IdP believes it manages
  // this user, so even a no-op PUT must create the scim_members row —
  // otherwise the user could silently fall out of the connection's scope.
  const adoptResult = await ensureScimMember(c.env.DB, logger, connection.id, user.userId);
  if (!adoptResult.success) return scimError(500, "Failed to update user");

  if (body.externalId !== undefined) {
    if (body.externalId !== user.externalId) {
      const failure = await applyExternalId(
        c.env.DB,
        logger,
        connection.id,
        user.userId,
        body.externalId,
      );
      if (failure) return failure;
      await recordAudit(c.env.DB, logger, {
        action: "scim.user.updated",
        actorType: "system",
        subject: user.userId,
        detail: { via: "scim", connectionId: connection.id, externalId: body.externalId },
      });
    }
  }

  if (desiredActive !== undefined) {
    const failure = await applyActiveTransition(
      c.env.DB,
      logger,
      connection.id,
      user,
      desiredActive,
    );
    if (failure) return failure;
  }

  const updated = await getScimScopedUser(c.env.DB, logger, connection, user.userId);
  if (!updated.success) return scimError(500, "Failed to get user");
  return scimJson(userResource(c, updated.data));
});

app.patch("/Users/:id", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const { connection, logger } = ctx;

  const userResult = await getScimScopedUser(c.env.DB, logger, connection, c.req.param("id"));
  if (!userResult.success) {
    if (userResult.error.code === "NOT_FOUND") return scimError(404, "User not found");
    return scimError(500, "Failed to get user");
  }
  const user = userResult.data;

  const body = await readScimBody(c, logger);
  if (body instanceof Response) return body;
  const operations = body.Operations;
  if (!Array.isArray(operations)) {
    return scimError(400, "Operations must be an array", "invalidSyntax");
  }

  let desiredActive: boolean | undefined;
  let externalIdUpdate: string | null | undefined;

  for (const operation of operations) {
    if (operation === null || typeof operation !== "object" || Array.isArray(operation)) {
      return scimError(400, "Each operation must be an object", "invalidSyntax");
    }
    const op = operation as Record<string, unknown>;
    if (typeof op.op !== "string") {
      return scimError(400, `Unsupported PATCH operation '${String(op.op)}'`, "invalidPath");
    }
    // Entra capitalizes op names ("Replace", "Add"); compare case-insensitively.
    const opName = op.op.toLowerCase();
    const path = typeof op.path === "string" ? op.path.trim().toLowerCase() : undefined;

    // Resolve the path FIRST: an op on an attribute we don't store
    // (displayName, name.givenName, enterprise extension paths, ...) is
    // ignored regardless of op type — Okta/Entra profile syncs send them on
    // every update, and a 4xx would mark the whole user as failed.
    if (path !== undefined && path !== "active" && path !== "externalid") {
      continue;
    }
    // On stored paths: RFC 7644 §3.5.2.1 says add on an existing single-valued
    // attribute replaces it (Entra sends Add on initial link), so add and
    // replace are equivalent here; remove (and anything else) is invalid.
    if (opName !== "replace" && opName !== "add") {
      return scimError(400, `Unsupported PATCH operation '${String(op.op)}'`, "invalidPath");
    }

    if (path === undefined) {
      // No-path op: the value object carries the attributes.
      if (op.value === null || typeof op.value !== "object" || Array.isArray(op.value)) {
        return scimError(400, `${opName} without a path requires an object value`, "invalidValue");
      }
      for (const [key, value] of Object.entries(op.value as Record<string, unknown>)) {
        const attribute = key.toLowerCase();
        if (attribute === "active") {
          const coerced = coerceActive(value);
          if (coerced === undefined) {
            return scimError(400, "active must be a boolean", "invalidValue");
          }
          desiredActive = coerced;
        } else if (attribute === "externalid") {
          if (typeof value !== "string" && value !== null) {
            return scimError(400, "externalId must be a string", "invalidValue");
          }
          externalIdUpdate = value;
        }
        // Unknown attributes ignored — see the unknown-path policy above.
      }
    } else if (path === "active") {
      const coerced = coerceActive(op.value);
      if (coerced === undefined) {
        return scimError(400, "active must be a boolean", "invalidValue");
      }
      desiredActive = coerced;
    } else {
      if (typeof op.value !== "string" && op.value !== null) {
        return scimError(400, "externalId must be a string", "invalidValue");
      }
      externalIdUpdate = op.value;
    }
  }

  // Adopt on any successful write verb — see the PUT handler's rationale.
  // Adoption runs AFTER the Operations validation above: a 400 must not adopt.
  const adoptResult = await ensureScimMember(c.env.DB, logger, connection.id, user.userId);
  if (!adoptResult.success) return scimError(500, "Failed to update user");

  if (externalIdUpdate !== undefined && externalIdUpdate !== user.externalId) {
    const failure = await applyExternalId(
      c.env.DB,
      logger,
      connection.id,
      user.userId,
      externalIdUpdate,
    );
    if (failure) return failure;
    await recordAudit(c.env.DB, logger, {
      action: "scim.user.updated",
      actorType: "system",
      subject: user.userId,
      detail: { via: "scim", connectionId: connection.id, externalId: externalIdUpdate },
    });
  }
  if (desiredActive !== undefined) {
    const failure = await applyActiveTransition(
      c.env.DB,
      logger,
      connection.id,
      user,
      desiredActive,
    );
    if (failure) return failure;
  }

  const updated = await getScimScopedUser(c.env.DB, logger, connection, user.userId);
  if (!updated.success) return scimError(500, "Failed to get user");
  return scimJson(userResource(c, updated.data));
});

app.delete("/Users/:id", async (c) => {
  const ctx = await requireScimConnection(c);
  if (ctx instanceof Response) return ctx;
  const { connection, logger } = ctx;

  const userResult = await getScimScopedUser(c.env.DB, logger, connection, c.req.param("id"));
  if (!userResult.success) {
    if (userResult.error.code === "NOT_FOUND") return scimError(404, "User not found");
    return scimError(500, "Failed to get user");
  }

  // DELETE deactivates rather than erases (see module doc): identical to
  // active:false, so a later GET shows the resource with active:false. Same
  // direction-aware skip as applyActiveTransition: a fully deactivated user
  // (disabled AND this connection's vote recorded) is a retried DELETE —
  // still 204, without re-running (and re-auditing) the deprovision.
  const user = userResult.data;
  const fullyDeactivated = user.disabledAt !== null && user.scimActive === false;
  if (!fullyDeactivated) {
    const deprovisionResult = await deprovisionUser(c.env.DB, logger, connection.id, user.userId);
    if (!deprovisionResult.success) return scimError(500, "Failed to deactivate user");
  }
  return new Response(null, { status: 204 });
});

export { app as scimRouter };
