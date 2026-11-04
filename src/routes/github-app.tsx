/**
 * Linking GitHub App installations to Stratum owners (migration 059).
 *
 *   GET  /github/app/setup                      — the app's "Setup URL"; HTML
 *   GET  /api/github/installations              — JSON list
 *   POST /api/github/installations/:id/link     — body `{ org?: slug }`; form or JSON
 *   POST /api/github/installations/:id/unlink   — form or JSON
 *
 * The `installation_id` GitHub appends to the setup redirect is only ever a
 * lookup key: anyone can type one. Control is proven by the installation's
 * recorded installer (from the signed webhook) matching the caller's
 * OAuth-verified GitHub id — see `githubIdentityControls`.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { secondFactorRequired } from "../middleware/org-second-factor";
import { orgBlockedFor } from "../services/org-second-factor";
import { recordAudit } from "../storage/audit";
import {
  type GitHubInstallation,
  type StratumOwnerRef,
  getInstallation,
  githubIdentityControls,
  linkInstallation,
  listInstallationsVisibleTo,
  unlinkInstallation,
} from "../storage/github-installations";
import { getOrg, getOrgBySlug, getOrgMemberRole, listOrgsForUser } from "../storage/orgs";
import { getUser } from "../storage/users";
import type { Env, User } from "../types";
import {
  GitHubAppSetupPage,
  type InstallationView,
  type LinkTarget,
  SETUP_NOTICES,
  type SetupNotice,
} from "../ui/pages/github-app-setup";
import { bindingAllowsCreateIn, credentialBindingFrom } from "../utils/authz";
import { type Logger, createLogger } from "../utils/logger";
import { rememberPostLoginRedirect } from "../utils/post-login-redirect";
import { readJsonWithLimit } from "../utils/request-body";

const app = new Hono<{ Bindings: Env }>();

const MAX_LINK_BODY_BYTES = 4 * 1024;
const SETUP_PATH = "/github/app/setup";

type Ctx = Context<{ Bindings: Env }>;

function parseInstallationId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Does `userId` administer org `orgId` for THIS session? Every org-role
 * decision in this file goes through here. An admin whose session fails the
 * org's second-factor policy (#256) does not administer it: `blocked`, which
 * a mutating route answers with `SECOND_FACTOR_REQUIRED`.
 *
 * @param c - Request context, carrying the session's unmet org policies
 * @param orgId - The org
 * @param userId - The caller
 * @param logger - Request logger
 * @param record - Whether to record the denial for the response (mutations)
 * @returns `admin`, `blocked` (admin, policy unmet), or `no`
 */
async function orgAuthority(
  c: Ctx,
  orgId: string,
  userId: string,
  logger: Logger,
  record = false,
): Promise<"admin" | "blocked" | "no"> {
  const role = await getOrgMemberRole(c.env.DB, logger, orgId, userId);
  if (!role.success || role.data !== "admin") return "no";
  return orgBlockedFor(c, orgId, record) ? "blocked" : "admin";
}

/** Orgs the caller administers for this session: link targets. */
async function adminOrgs(
  c: Ctx,
  userId: string,
  logger: Logger,
): Promise<Array<{ id: string; slug: string }>> {
  const orgs = await listOrgsForUser(c.env.DB, logger, userId);
  if (!orgs.success) return [];
  const authority = await Promise.all(
    orgs.data.map(async (org) => ({
      org,
      authority: await orgAuthority(c, org.id, userId, logger),
    })),
  );
  return authority
    .filter(({ authority: level }) => level === "admin")
    .map(({ org }) => ({ id: org.id, slug: org.slug }));
}

/**
 * Does `user` hold the installation's CURRENT Stratum owner — is it them, or
 * an org they administer? Required to unlink, and to move an existing link
 * elsewhere. GitHub-side control alone is not enough for either: the installer
 * proof is recorded once and never re-checked, so it can outlive the
 * installer's place in the GitHub org, and must not let them pull a link an
 * org's admins set away from that org.
 */
async function holdsCurrentOwner(
  c: Ctx,
  installation: GitHubInstallation,
  user: User,
  logger: Logger,
  record = false,
): Promise<"yes" | "blocked" | "no"> {
  const owner = installation.owner;
  if (!owner) return "no";
  if (owner.type === "user") return owner.id === user.id ? "yes" : "no";
  const authority = await orgAuthority(c, owner.id, user.id, logger, record);
  return authority === "admin" ? "yes" : authority;
}

/** The refusal for an org admin whose session fails the org's policy. */
async function secondFactorRefusal(c: Ctx, orgId: string, logger: Logger): Promise<Response> {
  if (!isJsonRequest(c)) return c.redirect(`${SETUP_PATH}?notice=second_factor_required`, 303);
  const org = await getOrg(c.env.DB, logger, orgId);
  return secondFactorRequired(c, org.success ? org.data.slug : orgId);
}

/** What `user` may do with an installation, for the listings. */
async function permissionsFor(
  c: Ctx,
  installation: GitHubInstallation,
  user: User,
  logger: Logger,
): Promise<{ canLink: boolean; canUnlink: boolean }> {
  const holds = (await holdsCurrentOwner(c, installation, user, logger)) === "yes";
  const controls = githubIdentityControls(installation, user.githubId);
  return { canLink: controls && (!installation.owner || holds), canUnlink: holds };
}

async function ownerLabel(
  db: D1Database,
  owner: StratumOwnerRef,
  user: User,
  logger: Logger,
): Promise<string> {
  if (owner.type === "user") {
    return owner.id === user.id ? `@${user.username} (you)` : "another user";
  }
  const org = await getOrg(db, logger, owner.id);
  return org.success ? `@${org.data.slug}` : "an organization";
}

type Outcome =
  | { ok: true; notice: SetupNotice }
  | { ok: false; notice: SetupNotice; status: 400 | 403 | 404 | 500 };

function isJsonRequest(c: Ctx): boolean {
  return (c.req.header("content-type") ?? "").includes("application/json");
}

function respond(c: Ctx, outcome: Outcome, data?: Record<string, unknown>): Response {
  if (!isJsonRequest(c)) {
    // 303 so the browser follows with a GET; only a fixed code travels.
    return c.redirect(`${SETUP_PATH}?notice=${outcome.notice}`, 303);
  }
  if (outcome.ok) return c.json({ ok: true, ...data });
  return c.json(
    { error: SETUP_NOTICES[outcome.notice], code: outcome.notice.toUpperCase() },
    outcome.status,
  );
}

async function signedInUser(c: Ctx, logger: Logger): Promise<User | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  const user = await getUser(c.env.DB, userId, logger);
  return user.success ? user.data : null;
}

app.get(SETUP_PATH, async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const returnPath = `${SETUP_PATH}${new URL(c.req.url).search}`;
  const user = await signedInUser(c, logger);
  if (!user) {
    rememberPostLoginRedirect(c, returnPath);
    return c.redirect("/auth/login");
  }

  const visible = await listInstallationsVisibleTo(c.env.DB, user, logger);
  const installations = visible.success ? visible.data : [];

  const views: InstallationView[] = await Promise.all(
    installations.map(async (inst) => ({
      installationId: inst.installationId,
      accountLogin: inst.accountLogin,
      accountType: inst.accountType,
      suspended: inst.suspendedAt !== undefined,
      ...(inst.owner ? { linkedTo: await ownerLabel(c.env.DB, inst.owner, user, logger) } : {}),
      ...(await permissionsFor(c, inst, user, logger)),
    })),
  );

  const linkTargets: LinkTarget[] = [
    { value: "", label: `@${user.username} (personal)` },
    ...(await adminOrgs(c, user.id, logger)).map((org) => ({
      value: org.slug,
      label: `@${org.slug}`,
    })),
  ];

  // GitHub redirects here as soon as the install finishes, which can beat the
  // installation webhook; show a self-refreshing wait rather than "not found".
  const requested = parseInstallationId(c.req.query("installation_id"));
  let pendingInstallationId: number | undefined;
  if (requested !== null && !installations.some((i) => i.installationId === requested)) {
    const recorded = await getInstallation(c.env.DB, requested, logger);
    if (recorded.success && recorded.data === null) pendingInstallationId = requested;
  }

  const noticeParam = c.req.query("notice");
  const notice =
    noticeParam !== undefined && Object.hasOwn(SETUP_NOTICES, noticeParam)
      ? (noticeParam as SetupNotice)
      : undefined;

  return c.html(
    <GitHubAppSetupPage
      user={user}
      hasGitHubIdentity={user.githubId !== undefined}
      installations={views}
      linkTargets={linkTargets}
      returnPath={returnPath}
      {...(pendingInstallationId !== undefined ? { pendingInstallationId } : {})}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

app.get("/api/github/installations", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const user = await signedInUser(c, logger);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const visible = await listInstallationsVisibleTo(c.env.DB, user, logger);
  if (!visible.success) return c.json({ error: "Failed to list installations" }, 500);

  const installations = await Promise.all(
    visible.data.map(async (inst) => ({
      installationId: inst.installationId,
      account: { login: inst.accountLogin, type: inst.accountType },
      suspended: inst.suspendedAt !== undefined,
      linkedTo: inst.owner ? await ownerLabel(c.env.DB, inst.owner, user, logger) : null,
      ...(await permissionsFor(c, inst, user, logger)),
    })),
  );
  return c.json({ installations, githubLinked: user.githubId !== undefined });
});

/** Reads `org` from a JSON or form body; "" / absent = personal account. */
async function readTargetOrg(c: Ctx, logger: Logger): Promise<string | Response> {
  if (isJsonRequest(c)) {
    const body = await readJsonWithLimit<{ org?: unknown }>(c, MAX_LINK_BODY_BYTES, logger);
    if (body instanceof Response) return body;
    return typeof body.org === "string" ? body.org.trim() : "";
  }
  // A malformed form body (e.g. a broken multipart boundary) makes parseBody
  // reject; answer it as the caller's error, not a 500.
  try {
    const form = await c.req.parseBody();
    return typeof form.org === "string" ? form.org.trim() : "";
  } catch (error) {
    logger.warn("Unparseable link form body", {
      error: error instanceof Error ? error.message : String(error),
    });
    return respond(c, { ok: false, notice: "error", status: 400 });
  }
}

app.post("/api/github/installations/:id/link", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const user = await signedInUser(c, logger);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const installationId = parseInstallationId(c.req.param("id"));
  if (installationId === null) return respond(c, { ok: false, notice: "not_found", status: 404 });

  const orgSlug = await readTargetOrg(c, logger);
  if (orgSlug instanceof Response) return orgSlug;

  const record = await getInstallation(c.env.DB, installationId, logger);
  if (!record.success) return respond(c, { ok: false, notice: "error", status: 500 });
  const installation = record.data;
  if (!installation) return respond(c, { ok: false, notice: "not_found", status: 404 });

  // The proof of control. Not distinguishable from "not found" for a caller
  // with no claim on it, so installation ids can't be probed for accounts.
  if (!githubIdentityControls(installation, user.githubId)) {
    const visible = await holdsCurrentOwner(c, installation, user, logger);
    return visible === "no"
      ? respond(c, { ok: false, notice: "not_found", status: 404 })
      : respond(c, { ok: false, notice: "not_authorized", status: 403 });
  }

  // Already linked: moving it takes authority over the current owner too, so
  // a link is only ever changed with that owner's consent (see holdsCurrentOwner).
  if (installation.owner) {
    const holds = await holdsCurrentOwner(c, installation, user, logger, true);
    if (holds === "blocked") return secondFactorRefusal(c, installation.owner.id, logger);
    if (holds === "no") return respond(c, { ok: false, notice: "linked_elsewhere", status: 403 });
  }

  let target: StratumOwnerRef = { type: "user", id: user.id };
  if (orgSlug !== "") {
    const org = await getOrgBySlug(c.env.DB, logger, orgSlug);
    if (!org.success) return respond(c, { ok: false, notice: "bad_target", status: 400 });
    const authority = await orgAuthority(c, org.data.id, user.id, logger, true);
    if (authority === "blocked") return secondFactorRefusal(c, org.data.id, logger);
    if (authority === "no") return respond(c, { ok: false, notice: "bad_target", status: 400 });
    target = { type: "org", id: org.data.id };
  }

  // Both ends of a move: the binding must admit the owner being displaced as
  // well as the new one, matching what unlink requires of the former.
  const binding = credentialBindingFrom(c);
  if (
    !bindingAllowsCreateIn(binding, target) ||
    (installation.owner && !bindingAllowsCreateIn(binding, installation.owner))
  ) {
    return respond(c, { ok: false, notice: "bound_token", status: 403 });
  }

  const linked = await linkInstallation(c.env.DB, installationId, target, user.id, logger);
  if (!linked.success) return respond(c, { ok: false, notice: "error", status: 500 });

  await recordAudit(c.env.DB, logger, {
    action: "github_app.installation_linked",
    actorType: "user",
    actorId: user.id,
    subject: String(installationId),
    detail: {
      account: installation.accountLogin,
      ownerType: target.type,
      ownerId: target.id,
      ...(installation.owner ? { previousOwner: installation.owner } : {}),
    },
    ...(target.type === "org" ? { orgId: target.id } : {}),
  });
  logger.info("GitHub App installation linked", {
    installationId,
    ownerType: target.type,
    ownerId: target.id,
  });
  return respond(c, { ok: true, notice: "linked" }, { installationId, owner: target });
});

app.post("/api/github/installations/:id/unlink", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const user = await signedInUser(c, logger);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const installationId = parseInstallationId(c.req.param("id"));
  if (installationId === null) return respond(c, { ok: false, notice: "not_found", status: 404 });

  const record = await getInstallation(c.env.DB, installationId, logger);
  if (!record.success) return respond(c, { ok: false, notice: "error", status: 500 });
  const installation = record.data;
  if (!installation) return respond(c, { ok: false, notice: "not_found", status: 404 });
  const holds = await holdsCurrentOwner(c, installation, user, logger, true);
  if (holds === "blocked" && installation.owner) {
    return secondFactorRefusal(c, installation.owner.id, logger);
  }
  if (holds !== "yes") return respond(c, { ok: false, notice: "not_found", status: 404 });

  const owner = installation.owner;
  if (owner && !bindingAllowsCreateIn(credentialBindingFrom(c), owner)) {
    return respond(c, { ok: false, notice: "bound_token", status: 403 });
  }

  if (owner) {
    const unlinked = await unlinkInstallation(c.env.DB, installationId, logger);
    if (!unlinked.success) return respond(c, { ok: false, notice: "error", status: 500 });
    await recordAudit(c.env.DB, logger, {
      action: "github_app.installation_unlinked",
      actorType: "user",
      actorId: user.id,
      subject: String(installationId),
      detail: { account: installation.accountLogin, previousOwner: owner },
      ...(owner.type === "org" ? { orgId: owner.id } : {}),
    });
    logger.info("GitHub App installation unlinked", { installationId });
  }
  return respond(c, { ok: true, notice: "unlinked" }, { installationId });
});

export { app as githubAppRouter };
