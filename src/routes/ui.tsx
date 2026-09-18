import { Hono } from "hono";
import type { Context } from "hono";
import { fetchInviteCodes, referralServiceConfigured } from "../beta/gate";
import { type UsageBannerNotice, loadUsageBanner } from "../billing/usage-banner";
import { buildUsageReport } from "../billing/usage-report";
import { cannotMintLegacyCredential } from "../middleware/auth";
import { NO_ANALYTICS_HEADER } from "../middleware/web-analytics";
import { createAgent, deleteAgent, getAgent, listAgents } from "../storage/agents";
import {
  type ApiTokenSummary,
  MAX_TOKEN_EXPIRY_DAYS,
  MIN_TOKEN_EXPIRY_DAYS,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../storage/api-tokens";
import { recordAudit } from "../storage/audit";
import { listComments, listReviews } from "../storage/change-reviews";
import { getChange, listChanges } from "../storage/changes";
import { getChangeCostSummary } from "../storage/costs";
import { type Deployment, getDeployment, listDeployments } from "../storage/deployments";
import { listEvalRuns } from "../storage/eval-runs";
import { listProjectEvents } from "../storage/events";
import type { RefResolutionFailure } from "../storage/git-ops";
import {
  freshRepoToken,
  getCommitLog,
  getDiffBetweenRepos,
  listFilesInRepo,
  listRepoBranches,
  listRepoTags,
  readFileFromRepo,
  resolveBranchRef,
} from "../storage/git-ops";
import { getImportProgress } from "../storage/imports";
import { listIssueComments } from "../storage/issue-comments";
import { getLabelsForIssues, listIssueLabels } from "../storage/issue-labels";
import { getIssueByNumber, listIssues } from "../storage/issues";
import { type OAuthGrantSummary, listGrantsForUser, revokeGrantForUser } from "../storage/oauth";
import { ownerHasClaims } from "../storage/project-namespace";
import { listSecretNames } from "../storage/project-secrets";
import { getProvenance } from "../storage/provenance";
import { readRepoSnapshot } from "../storage/repo-snapshot";
import {
  getProject,
  getProjectByPath,
  getWorkspace,
  listProjects,
  listProjectsByNamespace,
  listWorkspaces,
} from "../storage/state";
import { getProjectSourceUrl, getSyncStatus } from "../storage/sync";
import { usagePeriod } from "../storage/usage";
import {
  disableLegacyToken,
  getUser,
  renameUser,
  rotateUserToken,
  setUserDisplayName,
  setUserTelemetryOptOut,
} from "../storage/users";
import { listDeliveries, listWebhooks } from "../storage/webhooks";
import type { ApiTokenScope, Env, ProjectEntry } from "../types";
import { getUserNamespace, projectDefaultBranch } from "../types";
import { parseUnifiedDiff } from "../ui/components/diff-view";
import { getFileContent, isValidFilePath } from "../ui/file-content";
import { ActivityPage } from "../ui/pages/activity";
import { BranchesPage } from "../ui/pages/branches";
import { ChangeDetailPage } from "../ui/pages/change-detail";
import { ChangesPage } from "../ui/pages/changes";
import { DeploymentDetailPage, DeploymentsPage } from "../ui/pages/deployments";
import { ErrorPage } from "../ui/pages/error";
import { FileViewerPage } from "../ui/pages/file-viewer";
import { HomePage } from "../ui/pages/home";
import { IssueDetailPage, IssuesPage, NewIssuePage } from "../ui/pages/issues";
import { NewProjectPage } from "../ui/pages/new-project";
import { ProjectSettingsPage } from "../ui/pages/project-settings";
import { RepoPage } from "../ui/pages/repo";
import {
  type FreshCredential,
  type SettingsNotice,
  SettingsPage,
  type UsernameChange,
} from "../ui/pages/settings";
import { SyncPage } from "../ui/pages/sync";
import { TagsPage } from "../ui/pages/tags";
import { UsagePage } from "../ui/pages/usage";
import { WebhooksPage } from "../ui/pages/webhooks";
import { WorkspacesPage } from "../ui/pages/workspaces";
import { canReadProject, canWriteProject, filterMemberProjects } from "../utils/authz";
import { MAX_DISPLAY_NAME_LENGTH, normalizeDisplayName } from "../utils/display-name";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";
import { isValidNamespace, isValidSlug } from "../utils/validation";
import { canManageSecrets, secretErrorMessage } from "./deployments";
import { DEFAULT_COMMENTS_PAGE, DEFAULT_ISSUES_PAGE } from "./issues";
import { SUBSCRIBABLE_EVENTS } from "./webhooks";

const app = new Hono<{ Bindings: Env }>();

type PageUser = { id: string; email: string; username: string } | null;

const errorPage = (status: 400 | 404 | 500, message?: string, user?: PageUser) => (
  <ErrorPage status={status} {...(message !== undefined ? { message } : {})} user={user ?? null} />
);

/** The minimal project identity every page header needs. */
const projectRef = (project: ProjectEntry) => ({
  name: project.name,
  namespace: project.namespace,
  slug: project.slug,
  ...(project.visibility !== undefined ? { visibility: project.visibility } : {}),
});

/**
 * Drops `logTail` for anyone who cannot write to the project.
 *
 * It holds a redacted provider payload, and redaction is literal-substring
 * matching a public-project reader should not get to probe. The JSON API strips
 * the same field on the same rule (`toResponse` in routes/deployments.ts); the
 * page never assumes the field is present either way.
 */
function stripLogTail(deployment: Deployment, canWrite: boolean): Deployment {
  if (canWrite) return deployment;
  const { logTail: _logTail, ...rest } = deployment;
  return rest;
}

// Helper to get current user info
async function getCurrentUser(
  c: { get: (key: "userId") => string | undefined; env: { DB: D1Database } },
  logger: ReturnType<typeof createLogger>,
): Promise<{ id: string; email: string; username: string; displayName?: string } | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  const result = await getUser(c.env.DB, userId, logger);
  if (!result.success) return null;

  const user = result.data;
  // Username is always present - enforced by database schema and validation.
  // The display name rides along so the header shows it on every page, not
  // only on Settings.
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    ...(user.displayName !== undefined ? { displayName: user.displayName } : {}),
  };
}

/**
 * The 80% usage warning for the signed-in browser user, or `null`.
 *
 * Threaded into the pages a user actually visits — dashboard, settings, the
 * changes list and a change's detail — rather than only onto `/settings/usage`,
 * because a page nobody opens warns nobody (PRD §8). It costs **one KV read**
 * and no D1: the crossing was already detected and stored by
 * `usage-notifications.ts` at the moment the usage was written. Signed-out
 * visitors and self-hosted instances take no read at all.
 */
async function usageBannerFor(
  c: Context<{ Bindings: Env }>,
  logger: ReturnType<typeof createLogger>,
): Promise<UsageBannerNotice | null> {
  return loadUsageBanner(c.env, logger, c.get("userId"), usagePeriod());
}

/**
 * Resolve issue author ids to display names ("@username" for users, the agent's
 * name for agents). Unresolvable authors fall back to their author type.
 */
async function resolveIssueAuthors(
  db: D1Database,
  issues: Array<{ authorType: "user" | "agent"; authorId: string }>,
  logger: ReturnType<typeof createLogger>,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    [...new Map(issues.map((issue) => [issue.authorId, issue.authorType]))].map(
      async ([authorId, authorType]): Promise<readonly [string, string]> => {
        if (authorType === "user") {
          const result = await getUser(db, authorId, logger);
          return [authorId, result.success ? `@${result.data.username}` : "user"];
        }
        const result = await getAgent(db, authorId, logger);
        return [authorId, result.success ? `${result.data.name} (agent)` : "agent"];
      },
    ),
  );
  return Object.fromEntries(entries);
}

// GET / — Dashboard (list projects)
app.get("/", async (c) => {
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
  });

  const [userResult, allProjectsResult] = await Promise.all([
    getCurrentUser(c, logger),
    listProjects(c.env.STATE, logger),
  ]);

  if (!allProjectsResult.success) {
    logger.error("Failed to list projects", allProjectsResult.error);
    return c.html(errorPage(500, "Error loading projects. Please try again.", userResult), 500);
  }

  const user = userResult;
  // The dashboard is the caller's personal workspace: it lists only the projects
  // that are theirs (owned + org/team), never the whole instance's public
  // projects. Signed-out visitors get an empty list and a sign-in prompt; public
  // projects remain reachable by direct URL.
  const memberProjects = await filterMemberProjects(
    c.env.DB,
    allProjectsResult.data,
    userId,
    agentOwnerId,
  );
  // Most-recently-created first. createdAt is ISO-8601, so lexicographic order
  // matches chronological order.
  memberProjects.sort((a, b) => {
    if (a.createdAt === b.createdAt) return 0;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  const view = memberProjects.map((p) => ({
    name: p.name,
    namespace: p.namespace,
    slug: p.slug,
    remote: p.remote,
    createdAt: p.createdAt,
    ...(p.visibility !== undefined ? { visibility: p.visibility } : {}),
  }));

  logger.debug("Rendering home page", { projectCount: view.length });
  return c.html(
    <HomePage projects={view} user={user} usageNotice={await usageBannerFor(c, logger)} />,
  );
});

// GET /new — New project form
app.get("/new", async (c) => {
  const logger = createLogger({
    path: c.req.path,
    userId: c.get("userId"),
  });

  const user = await getCurrentUser(c, logger);
  if (!user) {
    logger.debug("User not authenticated, redirecting to login");
    return c.redirect("/auth/login");
  }

  logger.debug("Rendering new project page");
  return c.html(<NewProjectPage user={user} nonce={c.get("cspNonce") ?? ""} />);
});

async function loadAgentSummaries(
  db: D1Database,
  userId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<Array<{ id: string; name: string; model?: string; createdAt: string }>> {
  const agentsResult = await listAgents(db, userId, logger);
  if (!agentsResult.success) return [];
  return agentsResult.data.map((agent) => ({
    id: agent.id,
    name: agent.name,
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    createdAt: agent.createdAt,
  }));
}

/**
 * The account pages need more of the user row than the page header does:
 * `createdAt` and the linked GitHub handle for the profile, plus the telemetry
 * preference (#257) for settings.
 */
type AccountUser = {
  id: string;
  email: string;
  username: string;
  displayName?: string;
  createdAt: string;
  githubUsername?: string;
};

/**
 * Every field above comes off the same row, so this reads it once rather than
 * widening `PageUser` — which is threaded through every page header — or paying
 * a second lookup per extra field.
 */
async function getAccountUser(
  c: { get: (key: "userId") => string | undefined; env: { DB: D1Database } },
  logger: ReturnType<typeof createLogger>,
): Promise<{ user: AccountUser; telemetryOptOut: boolean } | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  const result = await getUser(c.env.DB, userId, logger);
  if (!result.success) return null;

  const { id, email, username, displayName, createdAt, githubUsername, telemetryOptOut } =
    result.data;
  return {
    user: {
      id,
      email,
      username,
      createdAt,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(githubUsername !== undefined ? { githubUsername } : {}),
    },
    telemetryOptOut: telemetryOptOut === true,
  };
}

const sessionRequiredError = () => (
  <div style="padding:2rem;font-family:monospace;color:#f87171;">
    Account pages require a signed-in browser session, not an API token.
  </div>
);

/**
 * Resolves the caller of an account page, insisting on a browser SESSION (#254).
 *
 * These pages mint, revoke, and disable credentials, so the rule the JSON
 * routes enforce (`requireSession` in `routes/users.ts`) has to hold here too:
 * a `read_write` token that could open `/settings` and post its forms would be
 * able to mint siblings and turn off the legacy key, and "revoke the lost
 * laptop" would be worthless because the laptop could issue itself a
 * replacement. A read-only token never reaches the POSTs — `authMiddleware`
 * refuses it on method — but it could still read this listing, so the check is
 * on the session, not on the scope.
 *
 * `/profile` is behind the same guard: it lists shareable invite codes, and a
 * leaked read-only token must not be able to enumerate and spend them.
 */
async function requireAccountSession(
  c: Context<{ Bindings: Env }>,
  logger: ReturnType<typeof createLogger>,
): Promise<
  { user: AccountUser; telemetryOptOut: boolean } | { response: Response | Promise<Response> }
> {
  const loaded = await getAccountUser(c, logger);
  if (!loaded) return { response: c.redirect("/auth/email") };
  if (c.get("authVia") !== "session") {
    logger.warn("Account page rejected - not a session caller", {});
    return { response: c.html(sessionRequiredError(), 403) };
  }
  return loaded;
}

/**
 * The caller's scoped tokens, plus a notice when they could not be read.
 *
 * An empty list and a failed lookup must not look the same: rendering "no
 * tokens yet" over a D1 error would tell someone their credentials are gone.
 */
async function loadApiTokens(
  db: D1Database,
  userId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ tokens: ApiTokenSummary[]; notice?: SettingsNotice }> {
  const result = await listApiTokens(db, logger, userId);
  if (result.success) return { tokens: result.data };
  return {
    tokens: [],
    notice: { kind: "error", message: "Your API tokens could not be loaded. Try again shortly." },
  };
}

/**
 * The caller's connected MCP clients (#349), plus a notice when they could not
 * be read. Same reasoning as `loadApiTokens`: "no applications connected" and
 * "we could not check" must not render identically, because one of them is a
 * reassurance the user has not earned.
 */
async function loadOAuthGrants(
  db: D1Database,
  userId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ grants: OAuthGrantSummary[]; notice?: SettingsNotice }> {
  const result = await listGrantsForUser(db, logger, userId);
  if (result.success) return { grants: result.data };
  return {
    grants: [],
    notice: {
      kind: "error",
      message: "Your connected applications could not be loaded. Try again shortly.",
    },
  };
}

/**
 * Whether the username may change: only while the account owns no projects.
 * The claims table in D1 is the strongly consistent answer for every project
 * created since it existed; the KV listing covers projects that predate it.
 * Fails closed — if either cannot be read, the form is withheld rather than
 * offered on a guess, but as "unavailable", so the page asks for a retry
 * instead of blaming projects the account may not own.
 */
async function usernameChangeState(
  env: Pick<Env, "DB" | "STATE">,
  user: { id: string; username: string },
  logger: ReturnType<typeof createLogger>,
): Promise<UsernameChange> {
  const claims = await ownerHasClaims(env, user.id, logger);
  if (!claims.success) {
    logger.error("Could not read namespace claims for the settings page", claims.error);
    return "unavailable";
  }
  if (claims.data) return "blocked";
  const projects = await listProjectsByNamespace(
    env.STATE,
    getUserNamespace(user.username),
    logger,
  );
  if (!projects.success) {
    logger.error("Could not list projects for the settings page", projects.error);
    return "unavailable";
  }
  return projects.data.length === 0 ? "allowed" : "blocked";
}

/** The settings page plus everything it lists, in one round of loads. */
async function renderSettings(
  c: Context<{ Bindings: Env }>,
  user: AccountUser,
  telemetryOptOut: boolean,
  logger: ReturnType<typeof createLogger>,
  extras: { freshToken?: FreshCredential; notice?: SettingsNotice } = {},
) {
  const [agents, tokens, grants, usernameChange, invites, usageNotice] = await Promise.all([
    loadAgentSummaries(c.env.DB, user.id, logger),
    loadApiTokens(c.env.DB, user.id, logger),
    loadOAuthGrants(c.env.DB, user.id, logger),
    usernameChangeState(c.env, user, logger),
    // Keyed off the service URL alone, not `betaGateEnabled`: codes minted while
    // the gate was on stay redeemable after it is switched off, so gating the
    // listing on the gate would hide real codes from the users holding them.
    referralServiceConfigured(c.env)
      ? fetchInviteCodes(c.env, user.id, logger)
      : Promise.resolve(undefined),
    usageBannerFor(c, logger),
  ]);
  // A notice about the action just taken outranks a listing's own failure —
  // the caller needs to know what their POST did first.
  const notice = extras.notice ?? tokens.notice ?? grants.notice;
  return (
    <SettingsPage
      user={user}
      usernameChange={usernameChange}
      {...(invites !== undefined ? { invites } : {})}
      {...(c.env.REFERRAL_SERVICE_URL !== undefined
        ? { shareBaseUrl: c.env.REFERRAL_SERVICE_URL }
        : {})}
      agents={agents}
      apiTokens={tokens.tokens}
      oauthGrants={grants.grants}
      // A failed read and an empty list are the same empty array, so the flag
      // is what keeps them from rendering identically — see `loadOAuthGrants`.
      oauthGrantsUnavailable={grants.notice !== undefined}
      telemetryOptOut={telemetryOptOut}
      usageNotice={usageNotice}
      // Threaded here rather than at each call site: this helper is the single
      // render path for the settings page, so the CSP nonce main added cannot
      // be forgotten by a future caller.
      nonce={c.get("cspNonce") ?? ""}
      {...(extras.freshToken !== undefined ? { freshToken: extras.freshToken } : {})}
      {...(notice !== undefined ? { notice } : {})}
    />
  );
}

/**
 * Notices carried across the redirect that follows a successful settings POST.
 *
 * A closed vocabulary, not a message in the URL: the query string is
 * attacker-controlled, and rendering arbitrary text from it would make the
 * settings page a phishing surface.
 */
const SETTINGS_NOTICES: Record<string, SettingsNotice> = {
  "token-revoked": { kind: "success", message: "That API token has been revoked." },
  "display-name-saved": { kind: "success", message: "Display name saved." },
  "username-changed": {
    kind: "success",
    message: "Username changed. Your new namespace applies to everything you create from now on.",
  },
  "connection-revoked": {
    kind: "success",
    message: "That application has been disconnected. Its access stopped immediately.",
  },
  "legacy-disabled": {
    kind: "success",
    message:
      "The legacy API key has been disabled. Anything still using it must switch to a named API token; your existing tokens keep working.",
  },
};

// GET /profile — Folded into Settings (#profile-settings merge): the two pages
// opened with the same Account card and each pointed at the other. Kept as a
// redirect so old links and the docs' `/profile` keep working.
app.get("/profile", (c) => c.redirect("/settings#account", 302));

// GET /settings — Account, privacy, API token, and agent token management
app.get("/settings", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;

  // Own keys only: a bare index lookup would resolve `?notice=constructor`
  // (and every other Object.prototype name) to something that is not a notice.
  const requestedNotice = c.req.query("notice") ?? "";
  const notice = Object.hasOwn(SETTINGS_NOTICES, requestedNotice)
    ? SETTINGS_NOTICES[requestedNotice]
    : undefined;
  const page = await renderSettings(c, access.user, access.telemetryOptOut, logger, {
    ...(notice !== undefined ? { notice } : {}),
  });
  return c.html(page);
});

/**
 * GET /settings/usage — this account's consumption against its allowances.
 *
 * A page of its own, not a section of `/settings`: that route renders one
 * hash-anchored document (which `/profile` redirects into), and usage is a
 * different question with a different read behind it.
 *
 * Users only, and a browser session only, like every other account page. There
 * is deliberately no organization view — this application has no org UI, and
 * under PRD §4a an allowance is checked against the person anyway, so what is
 * shown here is exactly what every limit is compared to.
 */
app.get("/settings/usage", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;

  const [report, usageNotice] = await Promise.all([
    buildUsageReport(c.env, logger, { actorUserId: access.user.id, includeByok: true }),
    usageBannerFor(c, logger),
  ]);
  if (!report.success) {
    // The allowances are still worth showing when only the totals failed to
    // read, but this build cannot tell those apart, so the page says plainly
    // that the figures are incomplete rather than rendering zeroes as fact.
    logger.error("Failed to build usage report", report.error);
    const message = "Your usage could not be loaded. Please try again.";
    return c.html(errorPage(500, message, access.user), 500);
  }

  return c.html(<UsagePage user={access.user} report={report.data} usageNotice={usageNotice} />);
});

// POST /settings/account — Set or clear the display name
app.post("/settings/account", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;
  const { user, telemetryOptOut } = access;

  const form = await c.req.parseBody();
  const raw = typeof form.displayName === "string" ? form.displayName : "";
  const displayName = normalizeDisplayName(raw);
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    const page = await renderSettings(c, user, telemetryOptOut, logger, {
      notice: {
        kind: "error",
        message: `A display name can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
      },
    });
    return c.html(page, 400);
  }

  const saved = await setUserDisplayName(
    c.env.DB,
    user.id,
    displayName === "" ? null : displayName,
    logger,
  );
  if (!saved.success) {
    logger.error("Failed to save display name", saved.error);
    return c.html(issuePageError(500, user), 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "user.display_name_changed",
    actorType: "user",
    actorId: user.id,
  });
  return c.redirect("/settings?notice=display-name-saved#account", 302);
});

// POST /settings/username — Change the username, only while nothing is keyed under it
//
// The username is the namespace in every project URL, clone URL, KV project
// key and backing repository name, none of which is rewritten here. So the
// rename is refused outright once the account owns a project, and the check
// fails closed when the listing cannot be read.
app.post("/settings/username", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;
  const { user, telemetryOptOut } = access;

  const form = await c.req.parseBody();
  const requested = typeof form.username === "string" ? form.username.trim().toLowerCase() : "";
  if (requested === user.username) return c.redirect("/settings#account", 302);

  const refuse = async (message: string, status: 400 | 403 | 409) => {
    const page = await renderSettings(c, user, telemetryOptOut, logger, {
      notice: { kind: "error", message },
    });
    return c.html(page, status);
  };

  // D1 first: a claim is written before any project's KV entry, so this read
  // is authoritative for everything created since claims existed. The KV
  // listing after it covers older projects, best effort.
  const claims = await ownerHasClaims(c.env, user.id, logger);
  if (!claims.success) {
    logger.error("Could not read namespace claims before a rename", claims.error);
    return c.html(issuePageError(500, user), 500);
  }
  if (claims.data) {
    logger.warn("Rename refused - account holds a project claim", {});
    return refuse(
      "Your username cannot be changed while you own projects: every project URL is keyed under it. If you have just deleted your last project, allow up to 15 minutes.",
      403,
    );
  }
  const projects = await listProjectsByNamespace(
    c.env.STATE,
    getUserNamespace(user.username),
    logger,
  );
  if (!projects.success) {
    logger.error("Could not list projects before a rename", projects.error);
    return c.html(issuePageError(500, user), 500);
  }
  if (projects.data.length > 0) {
    logger.warn("Rename refused - account owns projects", { projects: projects.data.length });
    return refuse(
      "Your username cannot be changed while you own projects: every project URL is keyed under it.",
      403,
    );
  }

  const renamed = await renameUser(c.env.DB, user.id, requested, logger);
  if (!renamed.success) {
    // 403: a claim landed between the check above and the UPDATE — the race
    // this table exists to decide, decided against the rename.
    const status = renamed.error.statusCode;
    if (status === 400 || status === 403 || status === 409) {
      return refuse(renamed.error.message, status);
    }
    logger.error("Failed to rename user", renamed.error);
    return c.html(issuePageError(500, user), 500);
  }

  // The listing and the UPDATE span two stores with nothing to serialize them,
  // so a project created in between — by this user in another tab, or by an
  // agent acting as them — would sit under a namespace no account owns. Look
  // again now that the name has changed: anything under the old namespace was
  // created in that window, so put the name back rather than leave it orphaned.
  // A project created from here on reads the new username. What remains is a
  // creation that read the old name before the UPDATE and wrote KV after this
  // check, a window the width of that one request; and KV listings are only
  // eventually consistent across edges, which no check here can close.
  const late = await listProjectsByNamespace(c.env.STATE, getUserNamespace(user.username), logger);
  if (!late.success || late.data.length > 0) {
    const reverted = await renameUser(c.env.DB, user.id, user.username, logger);
    if (!reverted.success) {
      logger.error("Rename could not be reverted after a late project", reverted.error);
      return c.html(issuePageError(500, user), 500);
    }
    if (!late.success) {
      // Nothing is known about the old namespace, so the name was put back on
      // caution; that is our failure to report, not a project to blame.
      logger.error("Could not list projects after a rename; reverted", late.error);
      return c.html(issuePageError(500, user), 500);
    }
    logger.warn("Rename reverted - a project appeared under the old namespace", {
      projects: late.data.length,
    });
    return refuse(
      "A project was created under your account while the username was changing, so the change was undone.",
      409,
    );
  }

  await recordAudit(c.env.DB, logger, {
    action: "user.renamed",
    actorType: "user",
    actorId: user.id,
    detail: { from: user.username, to: renamed.data },
  });
  return c.redirect("/settings?notice=username-changed#account", 302);
});

/** Same bounds as `POST /api/users/me/tokens`, applied to form fields. */
function parseTokenForm(
  form: Record<string, string | File>,
): { name: string; scope: ApiTokenScope; expiresInDays?: number } | { error: string } {
  const rawName = typeof form.name === "string" ? form.name.trim() : "";
  if (rawName.length === 0 || rawName.length > 100) {
    return { error: "Give the token a name of 1 to 100 characters." };
  }

  const rawScope = typeof form.scope === "string" ? form.scope : "read";
  if (rawScope !== "read" && rawScope !== "read_write") {
    return { error: "Scope must be read-only or read & write." };
  }

  const rawExpiry = typeof form.expiresInDays === "string" ? form.expiresInDays.trim() : "";
  if (rawExpiry.length === 0) return { name: rawName, scope: rawScope };
  // Digits only: `Number("1e3")` and `Number(" 5 ")` are both integers, and
  // neither is what a user typed into a day count.
  const expiresInDays = /^\d+$/.test(rawExpiry) ? Number(rawExpiry) : Number.NaN;
  if (
    !Number.isInteger(expiresInDays) ||
    expiresInDays < MIN_TOKEN_EXPIRY_DAYS ||
    expiresInDays > MAX_TOKEN_EXPIRY_DAYS
  ) {
    return {
      error: `Expiry must be a whole number of days between ${MIN_TOKEN_EXPIRY_DAYS} and ${MAX_TOKEN_EXPIRY_DAYS}, or blank for no expiry.`,
    };
  }
  return { name: rawName, scope: rawScope, expiresInDays };
}

// POST /settings/tokens — Mint a named API token; renders the plaintext once
app.post("/settings/tokens", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;
  const user = access.user;

  const parsed = parseTokenForm(await c.req.parseBody());
  if ("error" in parsed) {
    const page = await renderSettings(c, user, access.telemetryOptOut, logger, {
      notice: { kind: "error", message: parsed.error },
    });
    return c.html(page, 400);
  }

  const createResult = await createApiToken(c.env.DB, logger, {
    userId: user.id,
    name: parsed.name,
    scope: parsed.scope,
    ...(parsed.expiresInDays !== undefined ? { expiresInDays: parsed.expiresInDays } : {}),
  });
  if (!createResult.success) {
    logger.error("Failed to create API token", createResult.error);
    // The cap (409) and a rejected expiry (400) are the caller's to fix, so they
    // are shown as written; anything else is ours and is not.
    const status =
      createResult.error.statusCode === 409
        ? 409
        : createResult.error.statusCode === 400
          ? 400
          : 500;
    const page = await renderSettings(c, user, access.telemetryOptOut, logger, {
      notice: {
        kind: "error",
        message: status === 500 ? "Could not create the token." : createResult.error.message,
      },
    });
    return c.html(page, status);
  }

  await recordAudit(c.env.DB, logger, {
    action: "token.created",
    actorType: "user",
    actorId: user.id,
    subject: createResult.data.token.id,
    detail: { scope: createResult.data.token.scope },
  });

  const page = await renderSettings(c, user, access.telemetryOptOut, logger, {
    freshToken: {
      kind: "scoped-token",
      value: createResult.data.plaintext,
      tokenName: createResult.data.token.name,
    },
  });
  // The plaintext exists nowhere else after this response: it must not be held
  // by a shared cache, nor re-served from the browser's back-forward cache.
  return c.html(page, 200, {
    "Cache-Control": "no-store",
    // This response body contains a plaintext credential that exists nowhere
    // else. The analytics injector denies `/settings/*` by prefix already;
    // this is the local half of that control, set by the handler that knows
    // it is rendering a secret rather than by a list in another directory.
    [NO_ANALYTICS_HEADER]: "1",
  });
});

// POST /settings/tokens/:id/revoke — Revoke one of the caller's own tokens
app.post("/settings/tokens/:id/revoke", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;

  const { id } = c.req.param();
  const revokeResult = await revokeApiToken(c.env.DB, logger, {
    userId: access.user.id,
    tokenId: id,
  });
  if (!revokeResult.success) {
    // Another user's token id is indistinguishable from one that never existed.
    const status = revokeResult.error.statusCode === 404 ? 404 : 500;
    logger.warn("Failed to revoke API token", { tokenId: id, status });
    const page = await renderSettings(c, access.user, access.telemetryOptOut, logger, {
      notice: {
        kind: "error",
        message: status === 404 ? "No such token." : "Could not revoke that token.",
      },
    });
    return c.html(page, status);
  }

  await recordAudit(c.env.DB, logger, {
    action: "token.revoked",
    actorType: "user",
    actorId: access.user.id,
    subject: id,
  });
  // Redirect rather than render, so a refresh re-runs the listing and not the
  // revocation.
  return c.redirect("/settings?notice=token-revoked");
});

// POST /settings/connections/:id/revoke — Disconnect one authorized MCP client
app.post("/settings/connections/:id/revoke", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;

  const { id } = c.req.param();
  // Scoped by user id inside the storage call, so another account's grant id is
  // a no-op rather than a cross-account revocation.
  const revoked = await revokeGrantForUser(c.env.DB, logger, {
    grantId: id,
    userId: access.user.id,
  });
  if (!revoked.success) {
    logger.error("Failed to revoke OAuth grant", revoked.error, { grantId: id });
    const page = await renderSettings(c, access.user, access.telemetryOptOut, logger, {
      notice: { kind: "error", message: "Could not disconnect that application." },
    });
    return c.html(page, 500);
  }
  if (!revoked.data.revoked) {
    // Already gone, or never this user's. Both are reported the same way: a
    // distinguishable answer would let a signed-in user probe for other
    // accounts' grant ids.
    const page = await renderSettings(c, access.user, access.telemetryOptOut, logger, {
      notice: { kind: "error", message: "No such connected application." },
    });
    return c.html(page, 404);
  }

  await recordAudit(c.env.DB, logger, {
    action: "oauth.revoked",
    actorType: "user",
    actorId: access.user.id,
    subject: id,
  });
  return c.redirect("/settings?notice=connection-revoked");
});

// POST /settings/legacy-token/disable — Turn off the pre-scopes credential
app.post("/settings/legacy-token/disable", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;

  const disableResult = await disableLegacyToken(c.env.DB, access.user.id, logger);
  if (!disableResult.success) {
    logger.error("Failed to disable legacy token", disableResult.error);
    const page = await renderSettings(c, access.user, access.telemetryOptOut, logger, {
      notice: { kind: "error", message: "Could not disable the legacy API key." },
    });
    return c.html(page, 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "token.legacy_disabled",
    actorType: "user",
    actorId: access.user.id,
  });
  return c.redirect("/settings?notice=legacy-disabled");
});

// POST /settings/telemetry — Set the per-user product-analytics preference
//
// Not behind `requireAccountSession`: this changes the caller's own analytics
// preference, it does not mint or revoke a credential, so the circularity that
// makes the token routes session-only does not apply. A read-only token is
// already refused on method by `authMiddleware`.
app.post("/settings/telemetry", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const loaded = await getAccountUser(c, logger);
  if (!loaded) return c.redirect("/auth/login");
  const { user } = loaded;

  const form = await c.req.parseBody();
  // An unchecked checkbox is not submitted at all, so the field carries the
  // affirmative and its absence is the opt-out. Any value that isn't exactly
  // "on" — a stray type, an unexpected string — is read as an opt-out rather
  // than guessed at, so a misread never turns export back on. (A body that
  // cannot be parsed at all throws out of parseBody and is rejected without
  // changing the preference; it never reaches this line.)
  const optOut = !(typeof form.analytics === "string" && form.analytics === "on");

  const saved = await setUserTelemetryOptOut(c.env.DB, user.id, optOut, logger);
  if (!saved.success) {
    logger.error("Failed to save telemetry preference", saved.error);
    // Redirecting here would re-render Settings from the unchanged row, showing
    // the old value as though the save had succeeded.
    return c.html(issuePageError(500, user), 500);
  }

  // analyticsMiddleware wraps this request and reads the preference on the way
  // out, from the value auth loaded BEFORE this write. Without this line, the
  // last thing exported about someone who just opted out is the request in
  // which they did it, attributed to them.
  c.set("telemetryOptOut", optOut);

  await recordAudit(c.env.DB, logger, {
    action: "telemetry.preference_changed",
    actorType: "user",
    actorId: user.id,
    detail: { optOut },
  });

  return c.redirect("/settings", 302);
});

// POST /settings/rotate-token — Rotate the API key; renders the new key once
app.post("/settings/rotate-token", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const loaded = await getAccountUser(c, logger);
  if (!loaded) return c.redirect("/auth/login");
  const { user, telemetryOptOut } = loaded;

  // Not `requireAccountSession`: the legacy key must keep rotating for callers
  // that predate #254. Only a delegated credential — a scoped token or an OAuth
  // grant — is refused, because the key it would mint never expires and
  // survives revocation of the credential that minted it.
  if (cannotMintLegacyCredential(c)) {
    logger.warn("Rotate rejected - delegated credential cannot mint the legacy key", {});
    return c.html(sessionRequiredError(), 403);
  }

  const rotateResult = await rotateUserToken(c.env.DB, user.id, logger);
  if (!rotateResult.success) {
    logger.error("Failed to rotate API key", rotateResult.error);
    return c.html(issuePageError(500, user), 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "token.rotated",
    actorType: "user",
    actorId: user.id,
  });

  // Rendered in the POST response so the secret never lands in a URL or log,
  // and never in a cache either.
  const page = await renderSettings(c, user, telemetryOptOut, logger, {
    freshToken: { kind: "api-key", value: rotateResult.data },
  });
  return c.html(page, 200, {
    "Cache-Control": "no-store",
    // This response body contains a plaintext credential that exists nowhere
    // else. The analytics injector denies `/settings/*` by prefix already;
    // this is the local half of that control, set by the handler that knows
    // it is rendering a secret rather than by a list in another directory.
    [NO_ANALYTICS_HEADER]: "1",
  });
});

// POST /settings/agents — Create an agent token; renders it once
//
// Behind `requireAccountSession` for the same reason as `/settings/tokens`: an
// agent token is a long-lived credential that outlives the credential that
// minted it, so letting a scoped `read_write` token mint one would leave
// "revoke the lost laptop" incomplete. Note this closes the browser form only —
// `POST /api/agents` still accepts any authenticated caller, so the capability
// is not gone, just no longer reachable by two doors with different rules.
app.post("/settings/agents", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;
  const { user, telemetryOptOut } = access;

  const form = await c.req.parseBody();
  const name = typeof form.name === "string" ? form.name.trim().slice(0, 100) : "";
  if (!name) return c.html(errorPage(400, "Agent name is required.", user), 400);
  const model =
    typeof form.model === "string" && form.model.trim()
      ? form.model.trim().slice(0, 100)
      : undefined;

  const createResult = await createAgent(c.env.DB, user.id, name, logger, model);
  if (!createResult.success) {
    logger.error("Failed to create agent", createResult.error);
    return c.html(issuePageError(500, user), 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "agent.created",
    actorType: "user",
    actorId: user.id,
    subject: createResult.data.agent.id,
    detail: { name },
  });

  const page = await renderSettings(c, user, telemetryOptOut, logger, {
    freshToken: { kind: "agent", value: createResult.data.plaintext, agentName: name },
  });
  return c.html(page, 200, {
    "Cache-Control": "no-store",
    // This response body contains a plaintext credential that exists nowhere
    // else. The analytics injector denies `/settings/*` by prefix already;
    // this is the local half of that control, set by the handler that knows
    // it is rendering a secret rather than by a list in another directory.
    [NO_ANALYTICS_HEADER]: "1",
  });
});

// POST /settings/agents/:id/delete — Revoke an agent token
//
// Session-only alongside its create counterpart: revocation is half of the
// same credential-management surface, and a token that could revoke its owner's
// agents can lock them out of their own automation.
app.post("/settings/agents/:id/delete", async (c) => {
  const logger = createLogger({ path: c.req.path, userId: c.get("userId") });
  const access = await requireAccountSession(c, logger);
  if ("response" in access) return access.response;
  const { user } = access;

  const { id } = c.req.param();
  const agentResult = await getAgent(c.env.DB, id, logger);
  if (agentResult.success && agentResult.data.ownerId === user.id) {
    const deleteResult = await deleteAgent(c.env.DB, id, logger);
    if (deleteResult.success) {
      await recordAudit(c.env.DB, logger, {
        action: "agent.revoked",
        actorType: "user",
        actorId: user.id,
        subject: id,
      });
    }
  }
  return c.redirect("/settings", 302);
});

// GET /p/:name — Repo view (files + commit log) - DEPRECATED: Use /:namespace/:slug
app.get("/p/:name", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found", { name });
    return c.html(errorPage(404, `Project '${name}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    logger.warn("Project not found or access denied", { name, userId });
    return c.html(errorPage(404, `Project '${name}' not found.`, userResult), 404);
  }

  let files: string[] = [];
  // Distinguishes "this repo is empty" from "the listing failed": both leave
  // `files` empty, but only the first should hide content-gated actions.
  let filesUnavailable = false;
  let log: Array<{ sha: string; message: string; author: string; timestamp: number }> = [];
  let readme: string | null = null;
  let importProgress = null;

  // Check for active import
  const importResult = await getImportProgress(
    c.env.DB,
    project.namespace || "@legacy",
    project.slug || project.name,
    logger,
  );
  if (importResult.success && importResult.data && importResult.data.status !== "completed") {
    importProgress = importResult.data;
  }

  // Fetch upstream sync status — guard: skip for legacy entries without a namespace
  let syncStatus: {
    hasUpdates?: boolean;
    commitsBehind?: number;
    latestCommit?: string;
    lastCheckedAt?: string;
  } | null = null;
  let canSync = false;
  if (project.namespace) {
    const legacyNamespace = project.namespace ?? "@legacy";
    const legacySlug = project.slug ?? project.name;
    const syncStatusResult = await getSyncStatus(c.env.STATE, legacyNamespace, legacySlug, logger);
    if (syncStatusResult.success && syncStatusResult.data) {
      syncStatus = syncStatusResult.data;
    }
    canSync =
      !!getProjectSourceUrl(project) &&
      !!userId &&
      project.ownerType === "user" &&
      project.ownerId === userId &&
      project.importCompleted !== false;
  }
  const isOwner = !!userId && project.ownerType === "user" && project.ownerId === userId;
  const canWrite = await canWriteProject(c.env.DB, project, userId);

  const snapshotResult = await readRepoSnapshot(c.env.STATE, project, logger);
  if (snapshotResult.success && snapshotResult.data) {
    files = snapshotResult.data.files;
    log = snapshotResult.data.commits;
    readme = snapshotResult.data.readme;
  } else {
    // Cache miss or corrupt entry — fall back to git clone
    try {
      const tokenResult = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
      if (!tokenResult.success) throw tokenResult.error;
      const readToken = tokenResult.data;
      const branch = projectDefaultBranch(project);
      const [filesResult, logResult] = await Promise.all([
        listFilesInRepo(project.remote, readToken, logger, branch),
        getCommitLog(project.remote, readToken, logger, 20, branch),
      ]);

      if (filesResult.success) {
        files = filesResult.data;
      } else {
        filesUnavailable = true;
        logger.warn("Failed to list files in repo", { error: filesResult.error });
      }

      if (logResult.success) {
        log = logResult.data;
      } else {
        logger.warn("Failed to get commit log", { error: logResult.error });
      }

      // Try to read README.md if it exists
      const readmePath = files.find((f) => f.toLowerCase() === "readme.md");
      if (readmePath) {
        const readmeResult = await readFileFromRepo(
          project.remote,
          readToken,
          readmePath,
          logger,
          branch,
        );
        if (readmeResult.success) {
          readme = readmeResult.data;
        }
      }
    } catch (error) {
      // Repo may be empty or unreachable — render with empty data
      filesUnavailable = true;
      logger.warn("Error loading repo data", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.debug("Rendering project page", {
    name,
    fileCount: files.length,
    hasImport: !!importProgress,
  });
  return c.html(
    <RepoPage
      project={{
        name: project.name,
        namespace: project.namespace,
        slug: project.slug,
        ...(project.visibility !== undefined ? { visibility: project.visibility } : {}),
        remote: project.remote,
        createdAt: project.createdAt,
        sourceUrl: getProjectSourceUrl(project),
        sourceProvider: project.sourceProvider,
        sourceOwner: project.sourceOwner,
        sourceRepo: project.sourceRepo,
        lastSyncedAt: project.lastSyncedAt,
        lastSyncedCommit: project.lastSyncedCommit,
        lastSyncStatus: project.lastSyncStatus,
        lastSyncError: project.lastSyncError,
        autoSyncEnabled: project.autoSyncEnabled,
      }}
      files={files}
      filesUnavailable={filesUnavailable}
      log={log}
      readme={readme}
      user={userResult}
      importProgress={importProgress}
      syncStatus={syncStatus}
      canSync={canSync}
      isOwner={isOwner}
      canWrite={canWrite}
      nonce={c.get("cspNonce") ?? ""}
    />,
  );
});

// GET /p/:name/changes — Changes list
app.get("/p/:name/changes", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found for changes", { name });
    return c.html(errorPage(404, `Project '${name}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    logger.warn("Project not found or access denied", { name, userId });
    return c.html(errorPage(404, `Project '${name}' not found.`, userResult), 404);
  }

  const changesResult = await listChanges(c.env.DB, logger, name, undefined, {
    projectId: project.id,
  });
  if (!changesResult.success) {
    logger.error("Failed to list changes", changesResult.error);
    return c.html(errorPage(500, "Error loading changes. Please try again.", userResult), 500);
  }

  const view = changesResult.data.map((change) => ({
    id: change.id,
    project: change.project,
    workspace: change.workspace,
    status: change.status,
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    createdAt: change.createdAt,
  }));

  const canWrite = await canWriteProject(c.env.DB, project, userId);
  logger.debug("Rendering changes page", { name, changeCount: view.length });
  return c.html(
    <ChangesPage
      project={projectRef(project)}
      changes={view}
      canWrite={canWrite}
      user={userResult}
      usageNotice={await usageBannerFor(c, logger)}
    />,
  );
});

// GET /changes/:id — Change detail
app.get("/changes/:id", async (c) => {
  const { id } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    changeId: id,
  });

  const [userResult, changeResult] = await Promise.all([
    getCurrentUser(c, logger),
    getChange(c.env.DB, logger, id),
  ]);

  if (!changeResult.success) {
    logger.warn("Change not found", { id });
    return c.html(errorPage(404, `Change '${id}' not found.`, userResult), 404);
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    logger.error("Project not found for change", projectResult.error, { project: change.project });
    return c.html(errorPage(500, "Project not found.", userResult), 500);
  }

  if (!(await canReadProject(c.env.DB, projectResult.data, userId, agentOwnerId))) {
    logger.warn("Change not found or access denied", { id, userId });
    return c.html(errorPage(404, undefined, userResult), 404);
  }

  const [evalRunsResult, commentsResult, reviewsResult, costsResult, provenanceResult] =
    await Promise.all([
      listEvalRuns(c.env.DB, logger, change.id),
      listComments(c.env.DB, logger, change.id),
      listReviews(c.env.DB, logger, change.id),
      getChangeCostSummary(c.env.DB, logger, change.id),
      getProvenance(c.env.DB, logger, change.id),
    ]);

  // Provenance only exists once the change has merged; absence is normal, not an
  // error — the page simply omits the provenance card.
  const provenance = provenanceResult.success ? provenanceResult.data : null;

  // The diff is only renderable while the workspace still exists and the
  // change is still in review; failures degrade to "no diff section".
  let diffFiles: ReturnType<typeof parseUnifiedDiff> | null = null;
  const DIFFABLE_STATUSES = ["open", "needs_changes", "accepted", "approved"];
  if (DIFFABLE_STATUSES.includes(change.status)) {
    const workspaceResult = await getWorkspace(
      c.env.STATE,
      projectResult.data.id,
      change.workspace,
      logger,
    );
    if (workspaceResult.success) {
      const [projectToken, workspaceToken] = await Promise.all([
        freshRepoToken(c.env.ARTIFACTS, projectResult.data.remote, "read", logger),
        freshRepoToken(c.env.ARTIFACTS, workspaceResult.data.remote, "read", logger),
      ]);
      if (projectToken.success && workspaceToken.success) {
        const diffResult = await getDiffBetweenRepos(
          projectResult.data.remote,
          projectToken.data,
          workspaceResult.data.remote,
          workspaceToken.data,
          logger,
          projectDefaultBranch(projectResult.data),
        );
        if (diffResult.success) {
          diffFiles = parseUnifiedDiff(diffResult.data.diff);
        } else {
          logger.warn("Failed to load change diff", { changeId: change.id });
        }
      } else {
        logger.warn("Failed to mint tokens for change diff", { changeId: change.id });
      }
    }
  }
  if (!evalRunsResult.success) {
    logger.error("Failed to list eval runs", evalRunsResult.error);
  }

  const evalRuns = evalRunsResult.success
    ? evalRunsResult.data.map((run) => ({
        id: run.id,
        evaluatorType: run.evaluatorType,
        score: run.score,
        passed: run.passed,
        reason: run.reason,
        ...(run.issues !== undefined ? { issues: run.issues } : {}),
        ranAt: run.ranAt,
      }))
    : [];

  const canReview = !!userResult && (await canWriteProject(c.env.DB, projectResult.data, userId));
  logger.debug("Rendering change detail page", { id });
  return c.html(
    <ChangeDetailPage
      change={{
        id: change.id,
        project: change.project,
        workspace: change.workspace,
        status: change.status,
        ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
        ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
        ...(change.evalReason !== undefined ? { evalReason: change.evalReason } : {}),
        createdAt: change.createdAt,
        ...(change.mergedAt !== undefined ? { mergedAt: change.mergedAt } : {}),
        ...(change.githubPrUrl !== undefined ? { githubPrUrl: change.githubPrUrl } : {}),
      }}
      evalRuns={evalRuns}
      provenance={provenance}
      comments={commentsResult.success ? commentsResult.data : []}
      reviews={reviewsResult.success ? reviewsResult.data : []}
      costs={costsResult.success ? costsResult.data : []}
      diff={diffFiles}
      canReview={canReview}
      projectRef={projectRef(projectResult.data)}
      user={userResult}
      usageNotice={await usageBannerFor(c, logger)}
    />,
  );
});

// GET /p/:name/workspaces — Workspaces list
app.get("/p/:name/workspaces", async (c) => {
  const { name } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: name,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProject(c.env.STATE, name, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found for workspaces", { name });
    return c.html(errorPage(404, `Project '${name}' not found.`, userResult), 404);
  }

  if (!(await canReadProject(c.env.DB, projectResult.data, userId, agentOwnerId))) {
    logger.warn("Project not found or access denied", { name, userId });
    return c.html(errorPage(404, undefined, userResult), 404);
  }

  const project = projectResult.data;

  const workspacesResult = await listWorkspaces(c.env.STATE, project.id, logger);
  if (!workspacesResult.success) {
    logger.error("Failed to list workspaces", workspacesResult.error);
    return c.html(errorPage(500, "Error loading workspaces.", userResult), 500);
  }

  const view = workspacesResult.data.map((ws) => ({
    name: ws.name,
    createdAt: ws.createdAt,
  }));

  const canWrite = await canWriteProject(c.env.DB, project, userId);
  logger.debug("Rendering workspaces page", { name, workspaceCount: view.length });
  return c.html(
    <WorkspacesPage
      project={projectRef(project)}
      workspaces={view}
      canWrite={canWrite}
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/changes — Changes list (namespace format)
app.get("/:namespace/:slug/changes", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.notFound();
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  const changesResult = await listChanges(c.env.DB, logger, project.name, undefined, {
    projectId: project.id,
  });
  if (!changesResult.success) {
    logger.error("Failed to list changes", changesResult.error);
    return c.html(errorPage(500, "Error loading changes. Please try again.", userResult), 500);
  }

  const changes = changesResult.data.map((change) => ({
    id: change.id,
    project: change.project,
    workspace: change.workspace,
    status: change.status,
    ...(change.evalScore !== undefined ? { evalScore: change.evalScore } : {}),
    ...(change.evalPassed !== undefined ? { evalPassed: change.evalPassed } : {}),
    createdAt: change.createdAt,
  }));

  const canWrite = await canWriteProject(c.env.DB, project, userId);
  return c.html(
    <ChangesPage
      project={projectRef(project)}
      changes={changes}
      canWrite={canWrite}
      user={userResult}
      usageNotice={await usageBannerFor(c, logger)}
    />,
  );
});

// GET /:namespace/:slug/activity — Project activity feed
app.get("/:namespace/:slug/activity", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.notFound();
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  const eventsResult = await listProjectEvents(c.env.DB, logger, project.name);
  if (!eventsResult.success) {
    logger.error("Failed to list project events", eventsResult.error);
    return c.html(errorPage(500, "Error loading activity. Please try again.", userResult), 500);
  }

  const canWrite = await canWriteProject(c.env.DB, project, userId);
  return c.html(
    <ActivityPage
      project={projectRef(project)}
      events={eventsResult.data}
      canWrite={canWrite}
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/tags — Tags listing (annotated + lightweight, #182)
app.get("/:namespace/:slug/tags", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.notFound();
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) {
    logger.error("Failed to mint read token for tags page", readToken.error);
    return c.html(errorPage(500, "Error loading tags. Please try again.", userResult), 500);
  }
  const tagsResult = await listRepoTags(project.remote, readToken.data, logger);
  if (!tagsResult.success) {
    logger.error("Failed to list tags", tagsResult.error);
    return c.html(errorPage(500, "Error loading tags. Please try again.", userResult), 500);
  }

  const canWrite = await canWriteProject(c.env.DB, project, userId);
  return c.html(
    <TagsPage
      project={projectRef(project)}
      tags={tagsResult.data.tags}
      canWrite={canWrite}
      truncated={tagsResult.data.truncated}
      totalTagCount={tagsResult.data.totalTagCount}
      user={userResult}
    />,
  );
});

/**
 * The hand-rolled error block the routes in this file already render inline.
 * Kept as one helper so the ref-scoped views report failures on the same
 * surface as their neighbours instead of inventing a second one.
 */
const uiErrorBody = (message: string) => (
  <div style="padding:2rem;font-family:monospace;color:#f87171;">{message}</div>
);

const REF_LOAD_ERROR = "Error loading repository. Please try again.";

/**
 * `resolveBranchRef` reports a request-shaped refusal as a tagged object and a
 * transport failure as an `AppError`; only the former carries a `kind`.
 */
function isRefResolutionFailure(
  error: RefResolutionFailure | AppError,
): error is RefResolutionFailure {
  return "kind" in error;
}

/** How a UI view should answer a `?ref=` it could not honour. */
function refFailureAnswer(failure: RefResolutionFailure): {
  message: string;
  status: 400 | 404 | 409;
} {
  switch (failure.kind) {
    case "invalid":
      return { message: `Invalid branch name '${failure.name}'.`, status: 400 };
    case "not-found":
      return {
        message: `Branch '${failure.name}' not found in this repository.`,
        status: 404,
      };
    case "ambiguous":
      return {
        message: `Ref '${failure.name}' is ambiguous: it names both refs/heads/${failure.name} and refs/tags/${failure.name}. Rename one of them, or browse by a name that is unique.`,
        status: 409,
      };
  }
}

type UiRefResolution =
  | { resolved: true; branch: string }
  | { resolved: false; message: string; status: 400 | 404 | 409 | 500 };

/**
 * Resolves `?ref=` for a ref-scoped UI view.
 *
 * Absent means the project's default branch — the behaviour these views had
 * before multi-branch support, unchanged. Present is checked against the
 * remote's own advertisement and, if it does not name exactly one branch, the
 * view says so: an unknown ref must never fall back to the default branch, or
 * the page would show one tree under a URL naming another (PRD edge case 1).
 */
async function resolveUiRef(
  requestedRef: string | undefined,
  remote: string,
  readToken: string | null,
  defaultBranch: string,
  logger: Logger,
): Promise<UiRefResolution> {
  // An empty `ref=` means "no preference", matching `resolveRequestedRef` in
  // routes/projects.ts: a GET form submitted with nothing chosen sends exactly
  // that, and answering a browser's default submission with a 400 would be a
  // worse contract than reading it as unspecified.
  if (requestedRef === undefined || requestedRef === "") {
    return { resolved: true, branch: defaultBranch };
  }
  if (readToken === null) return { resolved: false, message: REF_LOAD_ERROR, status: 500 };

  const resolved = await resolveBranchRef(remote, readToken, logger, requestedRef);
  if (resolved.success) return { resolved: true, branch: resolved.data.name };
  if (isRefResolutionFailure(resolved.error)) {
    return { resolved: false, ...refFailureAnswer(resolved.error) };
  }
  logger.error("Failed to resolve requested ref", resolved.error, { ref: requestedRef });
  return { resolved: false, message: REF_LOAD_ERROR, status: 500 };
}

/**
 * Branch names for the switcher.
 *
 * Best-effort on purpose: a page that rendered before this feature existed must
 * not start failing because a ref advertisement did. A failure is logged and
 * yields no switcher, never an error page.
 */
async function loadSwitcherBranchNames(
  remote: string,
  readToken: string | null,
  defaultBranch: string,
  logger: Logger,
): Promise<string[]> {
  if (readToken === null) return [];
  const result = await listRepoBranches(remote, readToken, logger, defaultBranch);
  if (!result.success) {
    logger.warn("Failed to list branches for the switcher", { error: result.error });
    return [];
  }
  return result.data.branches.map((branch) => branch.name);
}

// GET /:namespace/:slug/branches — Branch listing (registered before the
// catch-all repo view at the bottom of this file, which would otherwise swallow
// it as a slug).
app.get("/:namespace/:slug/branches", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.html(uiErrorBody("Invalid project path."), 400);
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(uiErrorBody(`Project '${namespace}/${slug}' not found.`), 404);
  }
  const project = projectResult.data;

  // A private project must be indistinguishable from a missing one.
  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(uiErrorBody(`Project '${namespace}/${slug}' not found.`), 404);
  }

  const branchesError = uiErrorBody("Error loading branches. Please try again.");
  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) {
    logger.error("Failed to mint read token for branches page", readToken.error);
    return c.html(branchesError, 500);
  }

  const defaultBranch = projectDefaultBranch(project);
  const branchesResult = await listRepoBranches(
    project.remote,
    readToken.data,
    logger,
    defaultBranch,
  );
  if (!branchesResult.success) {
    logger.error("Failed to list branches", branchesResult.error);
    return c.html(branchesError, 500);
  }

  return c.html(
    <BranchesPage
      project={{ name: project.name, namespace: project.namespace, slug: project.slug }}
      branches={branchesResult.data.branches}
      defaultBranch={defaultBranch}
      truncated={branchesResult.data.truncated}
      totalBranchCount={branchesResult.data.totalBranchCount}
      user={userResult}
    />,
  );
});

/**
 * Three issue routes share the same preamble, and getting it wrong leaks
 * project existence. A private project must 404 rather than 403, so an
 * unreadable project is indistinguishable from a missing one — that is why
 * both the lookup miss and the authz failure return the same 404 here, and
 * why this is one helper rather than three copies that could drift apart.
 *
 * Returns `{ errorStatus }` instead of throwing so each caller renders the
 * error in its own page shell.
 */
async function loadIssuePageContext(c: {
  env: Env;
  get(key: "userId" | "agentOwnerId"): string | undefined;
  req: { param(key: string): string; path: string; query(key: string): string | undefined };
}): Promise<
  | {
      project: ProjectEntry;
      user: { id: string; email: string; username: string } | null;
      userId: string | undefined;
      logger: ReturnType<typeof createLogger>;
    }
  | { errorStatus: 400 | 404 }
> {
  const namespace = c.req.param("namespace");
  const slug = c.req.param("slug");
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) return { errorStatus: 400 };

  const [user, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);
  if (!projectResult.success) return { errorStatus: 404 };
  const project = projectResult.data;
  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) return { errorStatus: 404 };

  return { project, user, userId, logger };
}

const issuePageError = (status: 400 | 404 | 500, user?: PageUser) =>
  errorPage(status, status === 400 ? "Invalid project path." : undefined, user);

/**
 * `?page=` as a zero-based page index. Anything not a non-negative integer —
 * absent, "-1", "abc", "1e3" — is page 0 rather than an error: a bad page in a
 * hand-edited URL should show the first page, not a 400.
 *
 * @param raw - The raw page query parameter
 * @returns The parsed non-negative safe integer, or `0` for invalid or missing values
 */
function parsePageParam(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : 0;
}

// GET /:namespace/:slug/issues — Issues list
app.get("/:namespace/:slug/issues", async (c) => {
  const ctx = await loadIssuePageContext(c);
  if ("errorStatus" in ctx) return c.notFound();
  const { project, user, userId, logger } = ctx;

  const statusParam = c.req.query("status");
  const filter: "open" | "closed" | "all" =
    statusParam === "closed" ? "closed" : statusParam === "all" ? "all" : "open";
  const activeLabel = c.req.query("label")?.trim() || undefined;
  const query = c.req.query("q")?.trim() || undefined;
  const page = parsePageParam(c.req.query("page"));

  const issuesResult = await listIssues(
    c.env.DB,
    logger,
    project.name,
    filter === "all" ? undefined : filter,
    {
      projectId: project.id,
      ...(activeLabel !== undefined ? { label: activeLabel } : {}),
      ...(query !== undefined ? { search: query } : {}),
      // Bound the page like the API route does. Unbounded, this renders every
      // issue in the project and hands every id to getLabelsForIssues. One row
      // beyond the page tells us whether a next page exists without a COUNT.
      limit: DEFAULT_ISSUES_PAGE + 1,
      offset: page * DEFAULT_ISSUES_PAGE,
    },
  );
  if (!issuesResult.success) {
    logger.error("Failed to list issues", issuesResult.error);
    return c.html(issuePageError(500, user), 500);
  }
  const hasNext = issuesResult.data.length > DEFAULT_ISSUES_PAGE;
  const issues = issuesResult.data.slice(0, DEFAULT_ISSUES_PAGE);

  const labelsResult = await getLabelsForIssues(
    c.env.DB,
    logger,
    issues.map((issue) => issue.id),
  );

  // The assignee is a user id like the author ids — resolve display names for both.
  const authorRefs = [
    ...issues,
    ...issues
      .filter((issue) => issue.assignee !== undefined)
      .map((issue) => ({ authorType: "user" as const, authorId: issue.assignee as string })),
  ];
  const [authors, canWrite] = await Promise.all([
    resolveIssueAuthors(c.env.DB, authorRefs, logger),
    canWriteProject(c.env.DB, project, userId),
  ]);

  return c.html(
    <IssuesPage
      project={projectRef(project)}
      issues={issues}
      labels={labelsResult.success ? labelsResult.data : {}}
      authors={authors}
      filter={filter}
      activeLabel={activeLabel}
      query={query}
      page={page}
      hasNext={hasNext}
      canWrite={canWrite}
      user={user}
    />,
  );
});

// GET /:namespace/:slug/issues/new — New issue form (writers only)
app.get("/:namespace/:slug/issues/new", async (c) => {
  const ctx = await loadIssuePageContext(c);
  if ("errorStatus" in ctx) return c.notFound();
  const { project, user, userId } = ctx;

  if (!(await canWriteProject(c.env.DB, project, userId))) {
    return c.html(issuePageError(404, user), 404);
  }

  return c.html(<NewIssuePage project={projectRef(project)} user={user} />);
});

// GET /:namespace/:slug/issues/:number — Issue detail
app.get("/:namespace/:slug/issues/:number", async (c) => {
  const ctx = await loadIssuePageContext(c);
  if ("errorStatus" in ctx) return c.notFound();
  const { project, user, userId, logger } = ctx;

  const number = Number(c.req.param("number"));
  if (!Number.isInteger(number) || number <= 0) {
    return c.notFound();
  }

  const issueResult = await getIssueByNumber(c.env.DB, logger, project.name, number, {
    projectId: project.id,
  });
  if (!issueResult.success) {
    return c.html(errorPage(404, `Issue #${number} not found.`, user), 404);
  }
  const issue = issueResult.data;

  const commentPage = parsePageParam(c.req.query("page"));
  const [labelsResult, commentsResult] = await Promise.all([
    listIssueLabels(c.env.DB, logger, issue.id),
    // One past the page, as above, so "is there more" needs no second query.
    listIssueComments(c.env.DB, logger, issue.id, {
      limit: DEFAULT_COMMENTS_PAGE + 1,
      offset: commentPage * DEFAULT_COMMENTS_PAGE,
    }),
  ]);
  const commentsPageData = commentsResult.success ? commentsResult.data : [];
  const commentsHasNext = commentsPageData.length > DEFAULT_COMMENTS_PAGE;
  const comments = commentsPageData.slice(0, DEFAULT_COMMENTS_PAGE);

  // Resolve display names for the issue author, every comment author, and the
  // assignee (a user id) in one pass.
  const authorRefs = [
    issue,
    ...comments,
    ...(issue.assignee !== undefined
      ? [{ authorType: "user" as const, authorId: issue.assignee }]
      : []),
  ];
  const [authors, canWrite] = await Promise.all([
    resolveIssueAuthors(c.env.DB, authorRefs, logger),
    canWriteProject(c.env.DB, project, userId),
  ]);

  return c.html(
    <IssueDetailPage
      project={projectRef(project)}
      issue={issue}
      labels={labelsResult.success ? labelsResult.data : []}
      comments={comments}
      commentPage={commentPage}
      commentsHasNext={commentsHasNext}
      authors={authors}
      canWrite={canWrite}
      user={user}
    />,
  );
});

// GET /:namespace/:slug/webhooks — Webhook management (project writers only)
app.get("/:namespace/:slug/webhooks", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.notFound();
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  // Webhook URLs and secrets are sensitive: writers only.
  if (!(await canWriteProject(c.env.DB, project, userId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  const webhooksResult = await listWebhooks(c.env.DB, logger, project.id);
  if (!webhooksResult.success) {
    logger.error("Failed to list webhooks", webhooksResult.error);
    return c.html(errorPage(500, "Error loading webhooks. Please try again.", userResult), 500);
  }

  const webhooks = await Promise.all(
    // Strip the signing secret before it reaches the HTML — it is shown once on
    // creation via the JSON API and must never render in the management page.
    webhooksResult.data.map(async ({ secret: _secret, ...webhook }) => {
      const deliveriesResult = await listDeliveries(c.env.DB, logger, webhook.id, 5);
      return { webhook, deliveries: deliveriesResult.success ? deliveriesResult.data : [] };
    }),
  );

  return c.html(
    <WebhooksPage
      project={projectRef(project)}
      webhooks={webhooks}
      subscribableEvents={SUBSCRIBABLE_EVENTS}
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/workspaces — Workspaces list (namespace format)
app.get("/:namespace/:slug/workspaces", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.notFound();
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  const workspacesResult = await listWorkspaces(c.env.STATE, project.id, logger);
  if (!workspacesResult.success) {
    logger.error("Failed to list workspaces", workspacesResult.error);
    return c.html(errorPage(500, "Error loading workspaces. Please try again.", userResult), 500);
  }

  const workspaces = workspacesResult.data.map((ws) => ({
    name: ws.name,
    createdAt: ws.createdAt,
  }));

  const canWrite = await canWriteProject(c.env.DB, project, userId);
  return c.html(
    <WorkspacesPage
      project={projectRef(project)}
      workspaces={workspaces}
      canWrite={canWrite}
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/sync — Sync management page
app.get("/:namespace/:slug/sync", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) {
    return c.notFound();
  }

  if (!userId) {
    return c.redirect("/auth/login");
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  const syncStatusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);
  const stored = syncStatusResult.success ? syncStatusResult.data : null;
  const syncStatus = {
    namespace,
    slug,
    // Only external import sources are shown; the internal artifacts remote is not a
    // sync source and must not leak into the page.
    sourceUrl: getProjectSourceUrl(project) ?? "",
    sourceBranch: projectDefaultBranch(project),
    lastSyncStatus: (stored?.lastSyncStatus ?? "idle") as
      | "success"
      | "failed"
      | "in_progress"
      | "idle",
    lastSyncedAt: stored?.lastSyncedAt,
    lastSyncedCommit: stored?.lastSyncedCommit,
    lastSyncError: stored?.lastSyncError,
    hasUpdates: stored?.hasUpdates ?? false,
    commitsBehind: stored?.commitsBehind,
    latestCommit: stored?.latestCommit,
    autoSyncEnabled: stored?.autoSyncEnabled ?? false,
    syncFrequency: stored?.syncFrequency,
    lastCheckedAt: stored?.lastCheckedAt ?? new Date().toISOString(),
  };

  return c.html(
    <SyncPage
      project={{
        namespace: project.namespace || namespace,
        slug: project.slug || slug,
        name: project.name,
        ...(project.visibility !== undefined ? { visibility: project.visibility } : {}),
      }}
      syncStatus={syncStatus}
      syncHistory={[]}
      user={userResult}
      nonce={c.get("cspNonce") ?? ""}
    />,
  );
});

/**
 * Loads a project for a page that has already validated `:namespace`/`:slug`,
 * answering the shared 404 page on any failure so a caller can `return` it
 * directly.
 */
async function loadProjectPage(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
): Promise<{ project: ProjectEntry; user: PageUser } | { response: Response }> {
  const namespace = c.req.param("namespace") ?? "";
  const slug = c.req.param("slug") ?? "";
  const [user, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);
  if (!projectResult.success) {
    return {
      response: await c.html(
        errorPage(404, `Project '${namespace}/${slug}' not found.`, user),
        404,
      ),
    };
  }
  return { project: projectResult.data, user };
}

// GET /:namespace/:slug/deployments — Post-merge deploy history
//
// Readable by anyone who can read the project, like Activity. `logTail` is the
// one field that is not: it carries a redacted provider payload, so it is
// stripped for non-writers here exactly as `GET /api/.../deployments` strips it.
app.get("/:namespace/:slug/deployments", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) return c.notFound();

  const loaded = await loadProjectPage(c, logger);
  if ("response" in loaded) return loaded.response;
  const { project, user } = loaded;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, user), 404);
  }
  const canWrite = await canWriteProject(c.env.DB, project, userId, agentOwnerId);

  const result = await listDeployments(c.env.DB, logger, { projectId: project.id });
  if (!result.success) {
    logger.error("Failed to list deployments", result.error);
    return c.html(errorPage(500, "Error loading deployments. Please try again.", user), 500);
  }

  return c.html(
    <DeploymentsPage
      project={projectRef(project)}
      deployments={result.data.map((deployment) => stripLogTail(deployment, canWrite))}
      canWrite={canWrite}
      user={user}
    />,
  );
});

// GET /:namespace/:slug/deployments/:id — One attempt, with its log tail
app.get("/:namespace/:slug/deployments/:id", async (c) => {
  const { namespace, slug, id } = c.req.param();
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) return c.notFound();

  const loaded = await loadProjectPage(c, logger);
  if ("response" in loaded) return loaded.response;
  const { project, user } = loaded;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, user), 404);
  }
  const canWrite = await canWriteProject(c.env.DB, project, userId, agentOwnerId);

  const result = await getDeployment(c.env.DB, logger, { projectId: project.id, deploymentId: id });
  if (!result.success) {
    logger.error("Failed to get deployment", result.error);
    return c.html(errorPage(500, "Error loading deployment. Please try again.", user), 500);
  }
  if (!result.data) {
    return c.html(errorPage(404, `Deployment '${id}' not found.`, user), 404);
  }

  return c.html(
    <DeploymentDetailPage
      project={projectRef(project)}
      deployment={stripLogTail(result.data, canWrite)}
      canWrite={canWrite}
      user={user}
    />,
  );
});

// GET /:namespace/:slug/settings — Project settings (writers only; danger zone owner-only)
app.get("/:namespace/:slug/settings", async (c) => {
  const { namespace, slug } = c.req.param();
  const userId = c.get("userId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace) || !isValidSlug(slug)) return c.notFound();
  if (!userId) return c.redirect("/auth/login");

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  // Same 404 as a missing project — settings must not leak project existence.
  if (!(await canWriteProject(c.env.DB, project, userId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  const isOwner = project.ownerType === "user" && project.ownerId === userId;
  const sourceUrl = getProjectSourceUrl(project);

  // Deploy credentials are admin-only *and* refused to agent identities, which
  // is stricter than the write access the rest of this page needs. The rule
  // itself lives with the routes that enforce it, so what this page renders and
  // what those routes allow cannot drift apart.
  const showSecrets = await canManageSecrets(c.env.DB, project, {
    userId,
    agentId: c.get("agentId"),
  });
  const secretsResult = showSecrets ? await listSecretNames(c.env.DB, logger, project.id) : null;
  if (secretsResult && !secretsResult.success) {
    logger.error("Failed to list project secrets", secretsResult.error);
  }
  // The secret forms post to the API router and come back here with the reason
  // as a fixed code; anything not in that closed set resolves to no message.
  const secretError = secretErrorMessage(c.req.query("secretError"));

  return c.html(
    <ProjectSettingsPage
      project={{
        ...projectRef(project),
        createdAt: project.createdAt,
        ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      }}
      isOwner={isOwner}
      canManageSecrets={showSecrets}
      secrets={secretsResult?.success ? secretsResult.data : []}
      secretsUnavailable={secretsResult !== null && !secretsResult.success}
      {...(secretError !== undefined ? { secretError } : {})}
      user={userResult}
    />,
  );
});

// GET /:namespace/:slug/blob/* — File viewer (must be before /:namespace/:slug catch-all)
app.get("/:namespace/:slug/blob/*", async (c) => {
  const { namespace, slug } = c.req.param();
  const filePath = c.req.path.slice(`/${namespace}/${slug}/blob/`.length);
  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({ path: c.req.path, userId });

  if (!isValidNamespace(namespace)) {
    return c.notFound();
  }

  if (!isValidSlug(slug)) {
    return c.notFound();
  }

  if (!filePath || !isValidFilePath(filePath)) {
    return c.notFound();
  }

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  const readToken = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
  if (!readToken.success) {
    return c.html(errorPage(500, "Error loading file.", userResult), 500);
  }

  // Hono's getPath stops at "?", so the wildcard above never contains the query
  // string — `?ref=` is read here, from the query, and nowhere else.
  const defaultBranch = projectDefaultBranch(project);
  const refResolution = await resolveUiRef(
    c.req.query("ref"),
    project.remote,
    readToken.data,
    defaultBranch,
    logger,
  );
  if (!refResolution.resolved) {
    return c.html(uiErrorBody(refResolution.message), refResolution.status);
  }
  const branch = refResolution.branch;

  const contentResult = await getFileContent(
    project.remote,
    readToken.data,
    filePath,
    logger,
    branch,
  );
  if (!contentResult.success) {
    return c.html(errorPage(500, "Error loading file.", userResult), 500);
  }

  const content = contentResult.data;
  if (content.kind === "not-found") {
    return c.html(
      errorPage(404, `File '${filePath}' not found in this repository.`, userResult),
      404,
    );
  }

  const branchNames = await loadSwitcherBranchNames(
    project.remote,
    readToken.data,
    defaultBranch,
    logger,
  );
  const canWrite = await canWriteProject(c.env.DB, project, userId);
  return c.html(
    <FileViewerPage
      project={projectRef(project)}
      path={filePath}
      content={content}
      canWrite={canWrite}
      user={userResult}
      refName={branch === defaultBranch ? undefined : branch}
      defaultBranch={defaultBranch}
      branchNames={branchNames}
    />,
  );
});

// GET /:namespace/:slug — Repo view with namespace (NEW FORMAT) - MUST BE LAST
app.get("/:namespace/:slug", async (c) => {
  const params = c.req.param();
  const { namespace, slug } = params;

  // Validate namespace format
  if (!isValidNamespace(namespace)) {
    return c.notFound();
  }

  // Validate slug format
  if (!isValidSlug(slug)) {
    return c.notFound();
  }

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const logger = createLogger({
    path: c.req.path,
    userId,
    projectName: `${namespace}/${slug}`,
  });

  const [userResult, projectResult] = await Promise.all([
    getCurrentUser(c, logger),
    getProjectByPath(c.env.STATE, namespace, slug, logger),
  ]);

  if (!projectResult.success) {
    logger.warn("Project not found", { namespace, slug });
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    logger.warn("Project not found or access denied", { namespace, slug, userId });
    return c.html(errorPage(404, `Project '${namespace}/${slug}' not found.`, userResult), 404);
  }

  // Minted lazily and at most once. This is the highest-traffic page in the
  // product and, served from the KV snapshot, it did no git work at all before
  // multi-branch support: minting here unconditionally would add a fixed round
  // trip to every view for the benefit of the minority that actually needs it.
  // Best-effort, as before — an unreachable repo renders as an empty page
  // rather than an error.
  let readTokenLoaded = false;
  let readToken: string | null = null;
  const getReadToken = async (): Promise<string | null> => {
    if (readTokenLoaded) return readToken;
    readTokenLoaded = true;
    const minted = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
    if (!minted.success) {
      logger.warn("Failed to mint read token for repo view", { error: minted.error.message });
      return readToken;
    }
    readToken = minted.data;
    return readToken;
  };

  const defaultBranch = projectDefaultBranch(project);
  const requestedRef = c.req.query("ref");
  // Only a request that actually names a ref pays for resolving it.
  const hasRequestedRef = requestedRef !== undefined && requestedRef !== "";
  const refResolution = await resolveUiRef(
    requestedRef,
    project.remote,
    hasRequestedRef ? await getReadToken() : null,
    defaultBranch,
    logger,
  );
  if (!refResolution.resolved) {
    return c.html(uiErrorBody(refResolution.message), refResolution.status);
  }
  const branch = refResolution.branch;
  const isDefaultBranch = branch === defaultBranch;

  let files: string[] = [];
  // Distinguishes "this repo is empty" from "the listing failed": both leave
  // `files` empty, but only the first should hide content-gated actions.
  let filesUnavailable = false;
  let log: Array<{ sha: string; message: string; author: string; timestamp: number }> = [];
  let readme: string | null = null;
  let importProgress = null;

  // Check for active import — hide the card once it has completed
  const importResult = await getImportProgress(c.env.DB, namespace, slug, logger);
  if (importResult.success && importResult.data && importResult.data.status !== "completed") {
    importProgress = importResult.data;
  }

  // Fetch upstream sync status (null on KV failure — not fatal)
  let syncStatus: {
    hasUpdates?: boolean;
    commitsBehind?: number;
    latestCommit?: string;
    lastCheckedAt?: string;
  } | null = null;
  const syncStatusResult = await getSyncStatus(c.env.STATE, namespace, slug, logger);
  if (syncStatusResult.success && syncStatusResult.data) {
    syncStatus = syncStatusResult.data;
  }

  const isOwner = !!userId && project.ownerType === "user" && project.ownerId === userId;
  const canSync = !!getProjectSourceUrl(project) && isOwner && project.importCompleted !== false;
  const canWrite = await canWriteProject(c.env.DB, project, userId);

  // The snapshot is keyed `repo_snapshot:<ns>:<slug>` with no branch component
  // and only ever describes the default branch, so a non-default ref must not
  // read it at all — serving it would show the default branch's tree under a URL
  // naming another branch (PRD edge case 15).
  const snapshotResult2 = isDefaultBranch
    ? await readRepoSnapshot(c.env.STATE, project, logger)
    : null;
  const snapshotServedThePage = Boolean(snapshotResult2?.success && snapshotResult2.data);
  // Minted only when the snapshot cannot serve the page — a hit does no git work.
  const cloneToken = snapshotServedThePage ? null : await getReadToken();
  if (snapshotResult2?.success && snapshotResult2.data) {
    files = snapshotResult2.data.files;
    log = snapshotResult2.data.commits;
    readme = snapshotResult2.data.readme;
  } else if (cloneToken !== null) {
    // Cache miss, corrupt entry, or a non-default ref — fall back to git clone.
    // A token that could not be minted was already warned about above and leaves
    // the page rendering empty, exactly as it did before.
    try {
      const [filesResult, logResult] = await Promise.all([
        listFilesInRepo(project.remote, cloneToken, logger, branch),
        getCommitLog(project.remote, cloneToken, logger, 20, branch),
      ]);

      if (filesResult.success) {
        files = filesResult.data;
      } else {
        filesUnavailable = true;
        logger.warn("Failed to list files in repo", { error: filesResult.error });
      }

      if (logResult.success) {
        log = logResult.data;
      } else {
        logger.warn("Failed to get commit log", { error: logResult.error });
      }

      // Try to read README.md if it exists
      const readmePath = files.find((f) => f.toLowerCase() === "readme.md");
      if (readmePath) {
        const readmeResult = await readFileFromRepo(
          project.remote,
          cloneToken,
          readmePath,
          logger,
          branch,
        );
        if (readmeResult.success) {
          readme = readmeResult.data;
        }
      }
    } catch (error) {
      // Repo may be empty or unreachable — render with empty data
      filesUnavailable = true;
      logger.warn("Error loading repo data", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The switcher is a convenience, not the page. When the view was served from
  // the snapshot and no ref was requested, this request has touched git zero
  // times — so it offers just the branch being shown rather than spending a ref
  // advertisement (two subrequests) on the product's busiest page. A reader who
  // wants the full list is one click away on /branches.
  const branchNames = readTokenLoaded
    ? await loadSwitcherBranchNames(project.remote, readToken, defaultBranch, logger)
    : [defaultBranch];

  logger.debug("Rendering project page", {
    namespace,
    slug,
    branch,
    fileCount: files.length,
    hasImport: !!importProgress,
  });
  return c.html(
    <RepoPage
      project={{
        name: project.name,
        namespace: project.namespace,
        slug: project.slug,
        ...(project.visibility !== undefined ? { visibility: project.visibility } : {}),
        remote: project.remote,
        createdAt: project.createdAt,
        sourceUrl: getProjectSourceUrl(project),
        sourceProvider: project.sourceProvider,
        sourceOwner: project.sourceOwner,
        sourceRepo: project.sourceRepo,
        lastSyncedAt: project.lastSyncedAt,
        lastSyncedCommit: project.lastSyncedCommit,
        lastSyncStatus: project.lastSyncStatus,
        lastSyncError: project.lastSyncError,
        autoSyncEnabled: project.autoSyncEnabled,
      }}
      files={files}
      filesUnavailable={filesUnavailable}
      log={log}
      readme={readme}
      user={userResult}
      importProgress={importProgress}
      syncStatus={syncStatus}
      canSync={canSync}
      isOwner={isOwner}
      canWrite={canWrite}
      nonce={c.get("cspNonce") ?? ""}
      refName={isDefaultBranch ? undefined : branch}
      defaultBranch={defaultBranch}
      branchNames={branchNames}
    />,
  );
});

export { app as uiRouter };
