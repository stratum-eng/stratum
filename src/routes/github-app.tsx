/**
 * Linking GitHub App installations to Stratum owners (migrations 059, 082).
 *
 *   GET  /github/app/setup                      — the setup page; HTML
 *   POST /github/app/authorize                  — ask GitHub which installations the caller can link
 *   GET  /github/app/callback                   — the app's "Callback URL"; GitHub returns here
 *   GET  /api/github/installations              — JSON list
 *   POST /api/github/installations/:id/link     — body `{ org?: slug }`; starts the GitHub round trip
 *   POST /api/github/installations/:id/unlink   — form or JSON
 *
 * The `installation_id` GitHub appends to its redirects is only ever a lookup
 * key: anyone can type one. Control is proven at link time, by sending the
 * person through the app's user-to-server OAuth and asking GitHub what they
 * manage right now (#442) — see `checkInstallationAccess`. Who installed the
 * app is recorded for the audit trail and decides nothing.
 *
 * The user token that answers that question exists only inside the callback
 * request: it is never written to D1 or KV, never logged, and revoked on the
 * way out.
 *
 *   POST /github/app/connect                    — connect the caller's GitHub account
 *   POST /github/app/disconnect                 — remove that connection
 *
 * Connecting is the one round trip whose token is kept: a person who asks for
 * it lets Stratum open their promoted pull requests as them, and the token is
 * stored encrypted for that (src/services/github-pr-author.ts). It shares the
 * callback and the state table with linking, since GitHub gives an app one
 * callback URL, and a state only ever does what it was issued for.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  type CurrentGitHubAccess,
  GITHUB_APP_CALLBACK_PATH,
  type GitHubAppOAuthConfig,
  checkInstallationAccess,
  exchangeGitHubAppCode,
  fetchCurrentGitHubAccess,
  fetchGitHubUserIdentity,
  githubAppAuthorizeUrl,
  githubAppCallbackUrl,
  githubAppOAuthConfig,
  revokeGitHubAppUserToken,
} from "../github/user-access";
import { ipNotAllowedResponse } from "../middleware/org-ip-allowlist";
import { secondFactorRequired } from "../middleware/org-second-factor";
import { setHtmlSecurityHeaders } from "../middleware/security-headers";
import { toConnectionTokens, userConnectionConfig } from "../services/github-pr-author";
import { ipDenialFor, orgIpAllowsFor } from "../services/org-ip-allowlist";
import { orgBlockedFor } from "../services/org-second-factor";
import { recordAudit } from "../storage/audit";
import {
  ACCESS_SNAPSHOT_MAX_INSTALLATIONS,
  type LinkIntent,
  consumeLinkState,
  issueLinkState,
  replaceAccessSnapshot,
} from "../storage/github-app-link-states";
import {
  type GitHubInstallation,
  type StratumOwnerRef,
  getInstallation,
  linkInstallation,
  listInstallationsVisibleTo,
  unlinkInstallation,
} from "../storage/github-installations";
import {
  deleteConnection,
  readConnection,
  saveConnection,
} from "../storage/github-user-connections";
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
import { hashToken } from "../utils/crypto";
import { getWaitUntil } from "../utils/execution-ctx";
import { type Logger, createLogger } from "../utils/logger";
import { rememberPostLoginRedirect } from "../utils/post-login-redirect";
import { readJsonWithLimit } from "../utils/request-body";

const app = new Hono<{ Bindings: Env }>();

const MAX_LINK_BODY_BYTES = 4 * 1024;
const SETUP_PATH = "/github/app/setup";
/** Longer than any state this server issues; anything past it was never ours. */
const MAX_STATE_LENGTH = 128;

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
 * a mutating route answers with `SECOND_FACTOR_REQUIRED`. Nor does one calling
 * from outside the org's IP allowlist (#399): `ip_denied`, answered with
 * `IP_NOT_ALLOWED`. Linking decides which repositories the org's projects may
 * push to with the app, which is org administration like any other.
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
): Promise<OrgAuthority> {
  const role = await getOrgMemberRole(c.env.DB, logger, orgId, userId);
  if (!role.success || role.data !== "admin") return "no";
  if (orgBlockedFor(c, orgId, record)) return "blocked";
  const org = await getOrg(c.env.DB, logger, orgId);
  // Fail closed: an allowlist we could not read may be one that excludes this caller.
  if (!org.success) return "no";
  return orgIpAllowsFor(c, orgId, org.data.ipAllowlist, record) ? "admin" : "ip_denied";
}

type OrgAuthority = "admin" | "blocked" | "ip_denied" | "no";

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
 * elsewhere. GitHub-side control alone is not enough for either: a link is a
 * decision a Stratum owner made, and managing the GitHub account does not make
 * someone that owner. It must not let them pull a link an org's admins set
 * away from that org.
 */
async function holdsCurrentOwner(
  c: Ctx,
  installation: GitHubInstallation,
  user: User,
  logger: Logger,
  record = false,
): Promise<"yes" | Exclude<OrgAuthority, "admin">> {
  const owner = installation.owner;
  if (!owner) return "no";
  if (owner.type === "user") return owner.id === user.id ? "yes" : "no";
  const authority = await orgAuthority(c, owner.id, user.id, logger, record);
  return authority === "admin" ? "yes" : authority;
}

/** The refusal for an org admin calling from outside the org's IP allowlist. */
async function ipRefusal(c: Ctx, orgId: string): Promise<Response> {
  // Resolve first: it schedules the sampled audit entry, and a form's redirect
  // never reaches the middleware that would otherwise do so.
  const denial = await ipDenialFor(c, { id: orgId });
  if (!isJsonRequest(c)) return c.redirect(`${SETUP_PATH}?notice=ip_not_allowed`, 303);
  return ipNotAllowedResponse(c, denial);
}

/** The refusal for an org admin whose session fails the org's policy. */
async function secondFactorRefusal(c: Ctx, orgId: string, logger: Logger): Promise<Response> {
  if (!isJsonRequest(c)) return c.redirect(`${SETUP_PATH}?notice=second_factor_required`, 303);
  const org = await getOrg(c.env.DB, logger, orgId);
  return secondFactorRequired(c, org.success ? org.data.slug : orgId);
}

/**
 * What `user` may do with an installation, for the listings. `canLink` says
 * only that they may START a link — nothing the listing knows proves control,
 * which GitHub is asked about afresh on every attempt.
 *
 * @param c - Request context
 * @param installation - The installation
 * @param user - The viewer
 * @param mayStartLink - Whether this caller can begin the GitHub round trip at all
 * @param logger - Request logger
 * @returns The two permissions the listings show
 */
async function permissionsFor(
  c: Ctx,
  installation: GitHubInstallation,
  user: User,
  mayStartLink: boolean,
  logger: Logger,
): Promise<{ canLink: boolean; canUnlink: boolean }> {
  const holds = (await holdsCurrentOwner(c, installation, user, logger)) === "yes";
  return { canLink: mayStartLink && (!installation.owner || holds), canUnlink: holds };
}

/**
 * The browser session making this request, as the hash `sessions.id` holds —
 * what a link state is bound to. Undefined for a bearer credential: a token
 * cannot be walked through GitHub's consent screen, and a cookie that merely
 * rides along with one was not what authenticated the request.
 */
async function browserSessionHash(c: Ctx): Promise<string | undefined> {
  if (c.get("authVia") !== "session") return undefined;
  const sessionId = getCookie(c, "stratum_session");
  return sessionId ? hashToken(sessionId) : undefined;
}

/** Whether this caller can begin a link: configured, in a browser, with a GitHub identity. */
function mayStartLink(c: Ctx, user: User, sessionHash: string | undefined): boolean {
  return (
    githubAppOAuthConfig(c.env) !== null && sessionHash !== undefined && user.githubId !== undefined
  );
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
  | { ok: false; notice: SetupNotice; status: 400 | 403 | 404 | 500 | 501 };

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

  const sessionHash = await browserSessionHash(c);
  const canStart = mayStartLink(c, user, sessionHash);
  const visible = await listInstallationsVisibleTo(c.env.DB, user, sessionHash, logger);
  const installations = visible.success ? visible.data : [];

  const views: InstallationView[] = await Promise.all(
    installations.map(async (inst) => ({
      installationId: inst.installationId,
      accountLogin: inst.accountLogin,
      accountType: inst.accountType,
      suspended: inst.suspendedAt !== undefined,
      ...(inst.owner ? { linkedTo: await ownerLabel(c.env.DB, inst.owner, user, logger) } : {}),
      ...(await permissionsFor(c, inst, user, canStart, logger)),
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
  // Once it is recorded, offer to link it by number: nothing yet shows it is
  // this person's, so the page says no more about it than the URL already did.
  const requested = parseInstallationId(c.req.query("installation_id"));
  let pendingInstallationId: number | undefined;
  let unconfirmedInstallationId: number | undefined;
  if (requested !== null && !installations.some((i) => i.installationId === requested)) {
    const recorded = await getInstallation(c.env.DB, requested, logger);
    if (recorded.success && recorded.data === null) pendingInstallationId = requested;
    else if (recorded.success) unconfirmedInstallationId = requested;
  }

  const noticeParam = c.req.query("notice");
  const notice =
    noticeParam !== undefined && Object.hasOwn(SETUP_NOTICES, noticeParam)
      ? (noticeParam as SetupNotice)
      : undefined;

  // The link forms on this page are answered with a redirect to GitHub, and
  // Chromium and WebKit hold every hop of a form's redirect chain to the
  // page's `form-action` (see `CspOptions`). Under the site-wide `'self'` the
  // Link button would silently do nothing. The chain is ours → github.com →
  // ours, so naming GitHub is exact rather than a guess.
  setHtmlSecurityHeaders(c, { formAction: ["https://github.com"] });

  return c.html(
    <GitHubAppSetupPage
      user={user}
      hasGitHubIdentity={user.githubId !== undefined}
      linkingConfigured={githubAppOAuthConfig(c.env) !== null}
      installations={views}
      linkTargets={linkTargets}
      returnPath={returnPath}
      {...(pendingInstallationId !== undefined ? { pendingInstallationId } : {})}
      {...(unconfirmedInstallationId !== undefined ? { unconfirmedInstallationId } : {})}
      {...(notice !== undefined ? { notice } : {})}
    />,
  );
});

app.get("/api/github/installations", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const user = await signedInUser(c, logger);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const sessionHash = await browserSessionHash(c);
  const canStart = mayStartLink(c, user, sessionHash);
  const visible = await listInstallationsVisibleTo(c.env.DB, user, sessionHash, logger);
  if (!visible.success) return c.json({ error: "Failed to list installations" }, 500);

  const installations = await Promise.all(
    visible.data.map(async (inst) => ({
      installationId: inst.installationId,
      account: { login: inst.accountLogin, type: inst.accountType },
      suspended: inst.suspendedAt !== undefined,
      linkedTo: inst.owner ? await ownerLabel(c.env.DB, inst.owner, user, logger) : null,
      ...(await permissionsFor(c, inst, user, canStart, logger)),
    })),
  );
  return c.json({
    installations,
    githubLinked: user.githubId !== undefined,
    linkingConfigured: githubAppOAuthConfig(c.env) !== null,
  });
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

/**
 * What must hold before anyone is sent to GitHub. Refused in this order so the
 * answer names the thing to fix first: an unconfigured deployment cannot link
 * for anyone, and there is deliberately no weaker rule to fall back to.
 */
async function roundTripPreconditions(
  c: Ctx,
  user: User,
): Promise<{ config: GitHubAppOAuthConfig; sessionHash: string } | Response> {
  const config = githubAppOAuthConfig(c.env);
  if (!config) return respond(c, { ok: false, notice: "not_configured", status: 501 });
  const sessionHash = await browserSessionHash(c);
  if (sessionHash === undefined) {
    return respond(c, { ok: false, notice: "browser_required", status: 403 });
  }
  if (user.githubId === undefined) {
    return respond(c, { ok: false, notice: "github_account_required", status: 403 });
  }
  return { config, sessionHash };
}

/** Records the intent and sends the browser to GitHub with the state that names it. */
async function beginRoundTrip(
  c: Ctx,
  ready: { config: GitHubAppOAuthConfig; sessionHash: string },
  intent: LinkIntent,
  logger: Logger,
): Promise<Response> {
  const state = await issueLinkState(c.env.DB, ready.sessionHash, intent, logger);
  if (!state.success) return respond(c, { ok: false, notice: "error", status: 500 });
  const authorizeUrl = githubAppAuthorizeUrl(
    ready.config,
    githubAppCallbackUrl(c.env, c.req.url),
    state.data,
  );
  if (isJsonRequest(c)) return c.json({ ok: true, authorizeUrl });
  return c.redirect(authorizeUrl, 303);
}

app.post("/github/app/authorize", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const user = await signedInUser(c, logger);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const ready = await roundTripPreconditions(c, user);
  if (ready instanceof Response) return ready;
  return beginRoundTrip(c, ready, { userId: user.id }, logger);
});

app.post("/api/github/installations/:id/link", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const user = await signedInUser(c, logger);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const installationId = parseInstallationId(c.req.param("id"));
  if (installationId === null) return respond(c, { ok: false, notice: "not_found", status: 404 });

  const orgSlug = await readTargetOrg(c, logger);
  if (orgSlug instanceof Response) return orgSlug;

  const ready = await roundTripPreconditions(c, user);
  if (ready instanceof Response) return ready;

  // The target is the caller's own to name, so a bad one is refused before
  // the trip to GitHub rather than after it. The installation is not looked at
  // here at all: nothing is known about the caller's claim on it until GitHub
  // answers, and saying anything sooner would let ids be probed.
  let targetOrgId: string | undefined;
  if (orgSlug !== "") {
    const org = await getOrgBySlug(c.env.DB, logger, orgSlug);
    if (!org.success) return respond(c, { ok: false, notice: "bad_target", status: 400 });
    const authority = await orgAuthority(c, org.data.id, user.id, logger, true);
    if (authority === "blocked") return secondFactorRefusal(c, org.data.id, logger);
    if (authority === "ip_denied") return ipRefusal(c, org.data.id);
    if (authority === "no") return respond(c, { ok: false, notice: "bad_target", status: 400 });
    targetOrgId = org.data.id;
  }

  return beginRoundTrip(
    c,
    ready,
    { userId: user.id, installationId, ...(targetOrgId !== undefined ? { targetOrgId } : {}) },
    logger,
  );
});

/** Where the callback always ends: back on the setup page, carrying a fixed code. */
function backToSetup(c: Ctx, notice: SetupNotice): Response {
  return c.redirect(`${SETUP_PATH}?notice=${notice}`, 303);
}

/**
 * Refreshes which installations the setup page offers this session a Link
 * button on: the recorded ones GitHub says the person manages right now.
 */
async function refreshLinkable(
  c: Ctx,
  token: string,
  access: CurrentGitHubAccess,
  sessionHash: string,
  logger: Logger,
): Promise<Response> {
  const listedIds = [...access.installations.keys()];
  if (listedIds.length > ACCESS_SNAPSHOT_MAX_INSTALLATIONS) {
    // Display only: one left out can still be linked by its number.
    logger.warn("More GitHub App installations listed than the setup page offers", {
      listed: listedIds.length,
    });
  }
  const verdicts = await Promise.all(
    listedIds.slice(0, ACCESS_SNAPSHOT_MAX_INSTALLATIONS).map(async (installationId) => {
      const record = await getInstallation(c.env.DB, installationId, logger);
      // Not recorded yet (its webhook is still in flight): nothing to offer.
      if (!record.success || !record.data) return null;
      const verdict = await checkInstallationAccess(token, access, record.data, logger);
      return verdict.success && verdict.data === "allowed" ? installationId : null;
    }),
  );
  const linkable = verdicts.filter((id): id is number => id !== null);
  const stored = await replaceAccessSnapshot(c.env.DB, sessionHash, linkable, logger);
  return backToSetup(c, stored.success ? "access_checked" : "error");
}

/**
 * Makes the link the person asked for, if GitHub says they manage the
 * installation now and Stratum says they may place it where they asked.
 */
async function linkWithCurrentAccess(
  c: Ctx,
  user: User,
  intent: { installationId: number; targetOrgId?: string },
  token: string,
  access: CurrentGitHubAccess,
  logger: Logger,
): Promise<Response> {
  const { installationId } = intent;
  const record = await getInstallation(c.env.DB, installationId, logger);
  if (!record.success) return backToSetup(c, "error");
  const installation = record.data;
  if (!installation) return backToSetup(c, "not_found");

  // The proof of control. An installation GitHub does not list for this
  // person is not distinguishable from "not found" unless they already hold
  // its Stratum link, so installation ids can't be probed for accounts.
  const verdict = await checkInstallationAccess(token, access, installation, logger);
  if (!verdict.success) return backToSetup(c, "github_unavailable");
  if (verdict.data !== "allowed") {
    const known =
      verdict.data === "not_manager" ||
      (await holdsCurrentOwner(c, installation, user, logger)) !== "no";
    logger.info("GitHub App installation link refused: no current GitHub control", {
      installationId,
      userId: user.id,
      verdict: verdict.data,
    });
    return backToSetup(c, known ? "not_authorized" : "not_found");
  }

  // Already linked: moving it takes authority over the current owner too, so
  // a link is only ever changed with that owner's consent (see holdsCurrentOwner).
  if (installation.owner) {
    const holds = await holdsCurrentOwner(c, installation, user, logger, true);
    if (holds === "blocked") return secondFactorRefusal(c, installation.owner.id, logger);
    if (holds === "ip_denied") return ipRefusal(c, installation.owner.id);
    if (holds === "no") return backToSetup(c, "linked_elsewhere");
  }

  // Checked again, not trusted from before the trip: up to ten minutes have
  // passed, and the person may have been removed from the org in them.
  let target: StratumOwnerRef = { type: "user", id: user.id };
  if (intent.targetOrgId !== undefined) {
    const authority = await orgAuthority(c, intent.targetOrgId, user.id, logger, true);
    if (authority === "blocked") return secondFactorRefusal(c, intent.targetOrgId, logger);
    if (authority === "ip_denied") return ipRefusal(c, intent.targetOrgId);
    if (authority === "no") return backToSetup(c, "bad_target");
    target = { type: "org", id: intent.targetOrgId };
  }

  const linked = await linkInstallation(c.env.DB, installationId, target, user.id, logger);
  if (!linked.success) return backToSetup(c, "error");

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
  return backToSetup(c, "linked");
}

app.get(GITHUB_APP_CALLBACK_PATH, async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const requested = parseInstallationId(c.req.query("installation_id"));
  const setupPath = requested !== null ? `${SETUP_PATH}?installation_id=${requested}` : SETUP_PATH;

  const user = await signedInUser(c, logger);
  if (!user) {
    // Come back to the setup page, not to this URL: its code will have expired.
    rememberPostLoginRedirect(c, setupPath);
    return c.redirect("/auth/login");
  }

  // With "Request user authorization (OAuth) during installation" on, GitHub
  // sends people here straight after installing, with a `code` and no `state`.
  // That code is never redeemed: a callback nobody on this server asked for is
  // exactly what `state` exists to refuse, and honouring it would let a link
  // someone else prepared be completed in this person's session. They are
  // shown the installation instead, and link it with a round trip of their own.
  const state = c.req.query("state");
  if (!state) return c.redirect(setupPath, 303);

  const sessionHash = await browserSessionHash(c);
  if (sessionHash === undefined || state.length > MAX_STATE_LENGTH) {
    return backToSetup(c, "state_invalid");
  }
  // Spent before anything else is looked at, so every later refusal still
  // leaves the state unusable.
  const intent = await consumeLinkState(c.env.DB, state, sessionHash, user.id, logger);
  if (!intent.success) return backToSetup(c, "error");
  if (!intent.data) return backToSetup(c, "state_invalid");

  const code = c.req.query("code");
  if (intent.data.connectAccount) return finishConnect(c, user, code, logger);
  if (c.req.query("error") !== undefined || !code) return backToSetup(c, "authorization_denied");

  const config = githubAppOAuthConfig(c.env);
  if (!config) return backToSetup(c, "not_configured");
  const githubId = user.githubId;
  if (githubId === undefined) return backToSetup(c, "github_account_required");

  const exchanged = await exchangeGitHubAppCode(
    config,
    code,
    githubAppCallbackUrl(c.env, c.req.url),
    logger,
  );
  if (!exchanged.success) return backToSetup(c, "github_unavailable");
  const token = exchanged.data.accessToken;

  try {
    const access = await fetchCurrentGitHubAccess(token, logger);
    if (!access.success) return backToSetup(c, "github_unavailable");
    // The account that authorized must be the one this Stratum account is
    // known by. Without this, a `code` lifted from someone else's browser would
    // lend their GitHub standing to whoever replayed it here.
    if (access.data.githubUserId !== githubId) {
      return backToSetup(c, "github_account_mismatch");
    }
    const { installationId, targetOrgId } = intent.data;
    if (installationId === undefined) {
      return await refreshLinkable(c, token, access.data, sessionHash, logger);
    }
    return await linkWithCurrentAccess(
      c,
      user,
      { installationId, ...(targetOrgId !== undefined ? { targetOrgId } : {}) },
      token,
      access.data,
      logger,
    );
  } finally {
    // The answer is in hand; the token has no further use to anyone.
    const revoked = revokeGitHubAppUserToken(config, token, logger);
    const waitUntil = getWaitUntil(c);
    if (waitUntil) waitUntil(revoked);
    else await revoked;
  }
});

/** Where connecting and disconnecting end: the settings page, carrying a fixed code. */
function backToSettings(c: Ctx, notice: string): Response {
  return c.redirect(`/settings?notice=${notice}#github`, 303);
}

/** Revokes a token without holding the response for it. */
function revokeInBackground(
  c: Ctx,
  config: GitHubAppOAuthConfig,
  token: string,
  logger: Logger,
): Promise<void> | void {
  const revoked = revokeGitHubAppUserToken(config, token, logger);
  const waitUntil = getWaitUntil(c);
  if (!waitUntil) return revoked;
  waitUntil(revoked);
}

app.post("/github/app/connect", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const user = await signedInUser(c, logger);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const config = userConnectionConfig(c.env);
  if (!config) return backToSettings(c, "github-connect-unavailable");
  const sessionHash = await browserSessionHash(c);
  if (sessionHash === undefined) return c.json({ error: "A browser session is required" }, 403);
  // The account that authorizes must be the one this Stratum account is known
  // by (see finishConnect), so without one there is nothing to match against.
  if (user.githubId === undefined) return backToSettings(c, "github-connect-needs-github");

  const state = await issueLinkState(
    c.env.DB,
    sessionHash,
    { userId: user.id, connectAccount: true },
    logger,
  );
  if (!state.success) return backToSettings(c, "github-connect-failed");
  return c.redirect(
    githubAppAuthorizeUrl(config.oauth, githubAppCallbackUrl(c.env, c.req.url), state.data),
    303,
  );
});

/**
 * The callback half of connecting an account: redeem the code, check whose
 * token it is, and keep it.
 */
async function finishConnect(
  c: Ctx,
  user: User,
  code: string | undefined,
  logger: Logger,
): Promise<Response> {
  if (c.req.query("error") !== undefined || !code) {
    return backToSettings(c, "github-connect-declined");
  }
  const config = userConnectionConfig(c.env);
  if (!config) return backToSettings(c, "github-connect-unavailable");
  const githubId = user.githubId;
  if (githubId === undefined) return backToSettings(c, "github-connect-needs-github");

  const exchanged = await exchangeGitHubAppCode(
    config.oauth,
    code,
    githubAppCallbackUrl(c.env, c.req.url),
    logger,
  );
  if (!exchanged.success) return backToSettings(c, "github-connect-failed");
  const tokens = exchanged.data;
  // Every way out below this line that does not store the token revokes it.
  const abandon = async (notice: string): Promise<Response> => {
    await revokeInBackground(c, config.oauth, tokens.accessToken, logger);
    return backToSettings(c, notice);
  };

  const identity = await fetchGitHubUserIdentity(tokens.accessToken, logger);
  if (!identity.success) return abandon("github-connect-failed");
  // Without this, a `code` lifted from someone else's browser would have this
  // account opening pull requests as them.
  if (identity.data.id !== githubId) {
    logger.warn("GitHub connect refused: authorized as a different GitHub account", {
      userId: user.id,
    });
    return abandon("github-connect-mismatch");
  }

  // Read before it is overwritten: once replaced, nothing on record names the
  // old pair, and it would stay alive at GitHub with no way left to revoke it.
  const previous = await readConnection(c.env.DB, config.secret, user.id, logger);
  const saved = await saveConnection(
    c.env.DB,
    config.secret,
    {
      userId: user.id,
      githubUserId: identity.data.id,
      githubLogin: identity.data.login,
      ...toConnectionTokens(tokens, Math.floor(Date.now() / 1000)),
    },
    logger,
  );
  if (!saved.success) return abandon("github-connect-failed");
  if (previous.success && previous.data && previous.data.accessToken !== tokens.accessToken) {
    await revokeInBackground(c, config.oauth, previous.data.accessToken, logger);
  }

  await recordAudit(c.env.DB, logger, {
    action: "github.account_connected",
    actorType: "user",
    actorId: user.id,
    subject: identity.data.id,
    detail: { githubLogin: identity.data.login },
  });
  logger.info("GitHub account connected", { userId: user.id });
  return backToSettings(c, "github-connected");
}

app.post("/github/app/disconnect", async (c) => {
  const logger = createLogger({ path: c.req.path, method: c.req.method });
  const user = await signedInUser(c, logger);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if ((await browserSessionHash(c)) === undefined) {
    return c.json({ error: "A browser session is required" }, 403);
  }

  // Read for the token to revoke, but removal does not wait on that: a row
  // that no longer decrypts, or a deployment whose secret has since been
  // unset, must still be removable.
  const config = userConnectionConfig(c.env);
  const stored = config
    ? await readConnection(c.env.DB, config.secret, user.id, logger)
    : undefined;
  const removed = await deleteConnection(c.env.DB, user.id, logger);
  if (!removed.success) return backToSettings(c, "github-disconnect-failed");
  if (config && stored?.success && stored.data) {
    await revokeInBackground(c, config.oauth, stored.data.accessToken, logger);
  }
  if (removed.data) {
    await recordAudit(c.env.DB, logger, {
      action: "github.account_disconnected",
      actorType: "user",
      actorId: user.id,
      subject: user.githubId ?? user.id,
    });
    logger.info("GitHub account disconnected", { userId: user.id });
  }
  return backToSettings(c, "github-disconnected");
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
  if (holds === "ip_denied" && installation.owner) return ipRefusal(c, installation.owner.id);
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
