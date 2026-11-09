import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { githubAppRouter } from "../src/routes/github-app";
import { createApiToken } from "../src/storage/api-tokens";
import { createSession } from "../src/storage/sessions";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { createLogger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import {
  type GitHubPersona,
  type GitHubStub,
  STUB_CLIENT_ID,
  STUB_CLIENT_SECRET,
  stubGitHub,
} from "./helpers/github-app-oauth-stub";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * The GitHub App link routes, end to end against real SQLite. The property
 * under test: an installation is linked only by someone GitHub says manages
 * its account right now (#442), and only to a Stratum owner they hold; who
 * installed the app decides nothing. `github-app-link-current-access.test.ts`
 * covers the GitHub-side rule in depth through the whole Worker; this file
 * covers each route's own gatekeeping and the Stratum-side rules around it.
 */

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

const logger = createLogger({ component: "Test" });
let raw: Raw;
let env: Env;
let app: Hono<{ Bindings: Env }>;
let stub: GitHubStub;

const USERS = {
  // Installed the app on the acme GitHub org.
  alice: "4242",
  // Admin of the acme Stratum org, but no GitHub account linked.
  bob: null,
  // Has a GitHub account, and nothing to do with acme.
  mallory: "666",
} as const;
type Who = keyof typeof USERS;
const tokenOf = (who: Who) => `stratum_user_${who}_token`;

const ACME_INSTALLATION = {
  id: 777,
  account: { id: 99, login: "acme", type: "Organization" as const },
};
/** GitHub's answer for someone who owns the acme GitHub org today. */
const acmeOwner = (id: number): GitHubPersona => ({
  id,
  installations: [ACME_INSTALLATION],
  memberships: { acme: { state: "active", role: "admin", organizationId: 99 } },
});
/** GitHub's answer for someone the app's installations mean nothing to. */
const noAccess = (id: number): GitHubPersona => ({ id, installations: [] });

beforeEach(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeFakeKV(),
    DB: sqlite.db,
    GITHUB_APP_CLIENT_ID: STUB_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: STUB_CLIENT_SECRET,
  };
  for (const [who, githubId] of Object.entries(USERS)) {
    raw
      .prepare(
        "INSERT INTO users (id, email, username, token_hash, github_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`usr_${who}`, `${who}@example.com`, who, await hashToken(tokenOf(who as Who)), githubId);
  }
  raw
    .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES ('org_acme', 'Acme', 'acme', ?)")
    .run("usr_bob");
  raw
    .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES ('org_acme', ?, ?)")
    .run("usr_bob", "admin");
  raw
    .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES ('org_acme', ?, ?)")
    .run("usr_alice", "member");
  // The acme GitHub org's installation, as the installation.created webhook recorded it.
  raw
    .prepare(
      `INSERT INTO github_app_installations
         (installation_id, account_login, account_id, account_type, installer_github_id)
       VALUES (777, 'acme', '99', 'Organization', '4242')`,
    )
    .run();

  app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/", githubAppRouter);
  stub = stubGitHub();
});

afterEach(() => stub.restore());

/** A request authenticated by a bearer token (or by nothing, for `who` null). */
function call(
  who: Who | null,
  method: string,
  path: string,
  body?: Record<string, string>,
  opts: { form?: boolean; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = opts.token ?? (who !== null ? tokenOf(who) : undefined);
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return send(method, path, headers, body, opts.form);
}

function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Record<string, string>,
  form = false,
): Promise<Response> {
  let payload: string | undefined;
  if (body !== undefined) {
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(body).toString();
    } else {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      }),
      env,
    ),
  );
}

/** A browser session for `who`: linking is only ever started from one. */
async function sessionCookie(who: Who, withPasskey = false): Promise<string> {
  const created = await createSession(
    env.DB,
    `usr_${who}`,
    logger,
    true,
    withPasskey ? { secondFactor: "passkey" } : {},
  );
  if (!created.success) throw new Error("session not created");
  return `stratum_session=${created.data.id}`;
}

/** A request authenticated by a session cookie, optionally from a given address. */
function asSession(
  cookie: string,
  method: string,
  path: string,
  body?: Record<string, string>,
  opts: { form?: boolean; ip?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Cookie: cookie };
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  return send(method, path, headers, body, opts.form);
}

function noticeOf(res: Response): string | null {
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location") ?? "", "http://localhost");
  expect(location.pathname).toBe("/github/app/setup");
  return location.searchParams.get("notice");
}

/**
 * The whole link: start it in the browser, approve on GitHub as `persona`, and
 * land back on the callback. Returns the notice the person ends up looking at.
 */
async function linkVia(
  cookie: string,
  persona: GitHubPersona,
  opts: { id?: number; org?: string; ip?: string | null } = {},
): Promise<string | null> {
  const started = await asSession(
    cookie,
    "POST",
    `/api/github/installations/${opts.id ?? 777}/link`,
    opts.org !== undefined ? { org: opts.org } : {},
    { ip: opts.ip ?? null },
  );
  expect(started.status).toBe(200);
  const { authorizeUrl } = (await started.json()) as { authorizeUrl: string };
  const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
  const returned = await asSession(
    cookie,
    "GET",
    `/github/app/callback?code=${stub.approve(persona)}&state=${state}`,
    undefined,
    { ip: opts.ip ?? null },
  );
  return noticeOf(returned);
}

const link = (who: Who, body: Record<string, string> = {}, id = 777) =>
  call(who, "POST", `/api/github/installations/${id}/link`, body);
const unlink = (who: Who, id = 777) =>
  call(who, "POST", `/api/github/installations/${id}/unlink`, {});

function owner(id = 777): { type: string | null; id: string | null } {
  const row = raw
    .prepare(
      "SELECT stratum_owner_type, stratum_owner_id FROM github_app_installations WHERE installation_id = ?",
    )
    .get(id) as { stratum_owner_type: string | null; stratum_owner_id: string | null };
  return { type: row.stratum_owner_type, id: row.stratum_owner_id };
}

function linkToAcme(): void {
  raw
    .prepare(
      "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_acme' WHERE installation_id = 777",
    )
    .run();
}

describe("POST /api/github/installations/:id/link", () => {
  it("sends a browser session to GitHub, and by itself links nothing", async () => {
    const res = await asSession(
      await sessionCookie("alice"),
      "POST",
      "/api/github/installations/777/link",
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; authorizeUrl: string };
    expect(body.ok).toBe(true);
    const target = new URL(body.authorizeUrl);
    expect(`${target.origin}${target.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(target.searchParams.get("client_id")).toBe(STUB_CLIENT_ID);
    expect(target.searchParams.get("redirect_uri")).toBe("http://localhost/github/app/callback");

    // Alice installed the app. That used to be enough; now nothing has happened yet.
    expect(owner()).toEqual({ type: null, id: null });
    expect(stub.calls).toHaveLength(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
  });

  it("names the callback on APP_URL when the deployment has one", async () => {
    env.APP_URL = "https://stratum.example/";
    const res = await asSession(
      await sessionCookie("alice"),
      "POST",
      "/api/github/installations/777/link",
      {},
    );
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(
      "https://stratum.example/github/app/callback",
    );
  });

  it("links to the caller's personal account once GitHub confirms they own the org, and audits it", async () => {
    expect(await linkVia(await sessionCookie("alice"), acmeOwner(4242))).toBe("linked");
    expect(owner()).toEqual({ type: "user", id: "usr_alice" });

    const audit = raw
      .prepare("SELECT action, actor_id, subject FROM audit_log WHERE action LIKE 'github_app.%'")
      .all();
    expect(audit).toEqual([
      { action: "github_app.installation_linked", actor_id: "usr_alice", subject: "777" },
    ]);
  });

  it("links to an org the caller administers", async () => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    expect(await linkVia(await sessionCookie("alice"), acmeOwner(4242), { org: "acme" })).toBe(
      "linked",
    );
    expect(owner()).toEqual({ type: "org", id: "org_acme" });

    const row = raw
      .prepare("SELECT org_id FROM audit_log WHERE action = 'github_app.installation_linked'")
      .get() as { org_id: string };
    expect(row.org_id).toBe("org_acme");
  });

  it("refuses an org the caller is only a member of", async () => {
    const res = await asSession(
      await sessionCookie("alice"),
      "POST",
      "/api/github/installations/777/link",
      { org: "acme" },
    );
    expect(res.status).toBe(400);
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("refuses an org that does not exist", async () => {
    const res = await asSession(
      await sessionCookie("alice"),
      "POST",
      "/api/github/installations/777/link",
      { org: "nope" },
    );
    expect(res.status).toBe(400);
  });

  it("refuses the installer once GitHub no longer lists the installation for them", async () => {
    expect(await linkVia(await sessionCookie("alice"), noAccess(4242))).toBe("not_found");
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("hides the installation from a user with no claim on it", async () => {
    expect(await linkVia(await sessionCookie("mallory"), noAccess(666))).toBe("not_found");
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("does not let a Stratum org admin link it without a GitHub account to confirm with", async () => {
    // bob administers the Stratum org it would be linked to, but has nothing
    // to prove control with on GitHub: admin of the target is not control of
    // the source.
    const res = await asSession(
      await sessionCookie("bob"),
      "POST",
      "/api/github/installations/777/link",
      { org: "acme" },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("GITHUB_ACCOUNT_REQUIRED");
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("tells a caller who holds the current link, but not the GitHub account, why they were refused", async () => {
    linkToAcme();
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    // An admin of the linked org already sees the installation, so there is
    // nothing to hide from them: say "not authorized", not "not found".
    expect(await linkVia(await sessionCookie("alice"), noAccess(4242))).toBe("not_authorized");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });

  it("says nothing about whether an installation id exists until GitHub has answered", async () => {
    const cookie = await sessionCookie("alice");
    const known = await asSession(cookie, "POST", "/api/github/installations/777/link", {});
    const unknown = await asSession(cookie, "POST", "/api/github/installations/123456/link", {});
    expect(unknown.status).toBe(known.status);
    expect(Object.keys((await unknown.json()) as object)).toEqual(
      Object.keys((await known.json()) as object),
    );
    // An id that is not recorded is refused on return like one that is not theirs.
    expect(await linkVia(cookie, acmeOwner(4242), { id: 123456 })).toBe("not_found");
  });

  it("rejects a malformed id", async () => {
    const res = await call("alice", "POST", "/api/github/installations/abc/link", {});
    expect(res.status).toBe(404);
  });

  it("does not let a stranger move an existing link", async () => {
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'user', stratum_owner_id = 'usr_alice'",
      )
      .run();
    const cookie = await sessionCookie("mallory");
    expect(await linkVia(cookie, noAccess(666))).toBe("not_found");
    // Not even one GitHub would vouch for: the link is its Stratum owner's to move.
    expect(await linkVia(cookie, acmeOwner(666))).toBe("linked_elsewhere");
    expect(owner()).toEqual({ type: "user", id: "usr_alice" });
  });

  it("lets the owner of a personal-account installation link it", async () => {
    raw
      .prepare(
        `INSERT INTO github_app_installations
           (installation_id, account_login, account_id, account_type)
         VALUES (888, 'mallory', '666', 'User')`,
      )
      .run();
    const persona: GitHubPersona = {
      id: 666,
      installations: [{ id: 888, account: { id: 666, login: "mallory", type: "User" } }],
    };
    expect(await linkVia(await sessionCookie("mallory"), persona, { id: 888 })).toBe("linked");
    expect(owner(888)).toEqual({ type: "user", id: "usr_mallory" });
  });

  it("does not treat an org account id as a personal account", async () => {
    raw
      .prepare(
        `INSERT INTO github_app_installations
           (installation_id, account_login, account_id, account_type)
         VALUES (889, 'evil-org', '666', 'Organization')`,
      )
      .run();
    // The org's account id happens to equal mallory's user id; she is not its admin.
    const persona: GitHubPersona = {
      id: 666,
      installations: [{ id: 889, account: { id: 666, login: "evil-org", type: "Organization" } }],
    };
    expect(await linkVia(await sessionCookie("mallory"), persona, { id: 889 })).toBe(
      "not_authorized",
    );
    expect(owner(889)).toEqual({ type: null, id: null });
  });

  it("requires authentication", async () => {
    const res = await call(null, "POST", "/api/github/installations/777/link", {});
    expect(res.status).toBe(401);
  });

  it("refuses a bearer token, which cannot be walked through GitHub's consent screen", async () => {
    const res = await link("alice");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("BROWSER_REQUIRED");
    expect(body.error).toContain("/github/app/setup");
    expect(owner()).toEqual({ type: null, id: null });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM github_app_link_states").get()).toEqual({ n: 0 });
  });

  it("is not fooled by a session cookie riding along with a bearer token", async () => {
    const res = await send(
      "POST",
      "/api/github/installations/777/link",
      { Authorization: `Bearer ${tokenOf("alice")}`, Cookie: await sessionCookie("alice") },
      {},
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("BROWSER_REQUIRED");
  });

  it("is unreachable with a bound token", async () => {
    const minted = await createApiToken(env.DB, logger, {
      userId: "usr_alice",
      name: "bound",
      scope: "read_write",
      binding: { kind: "org", orgId: "org_acme" },
    });
    expect(minted.success).toBe(true);
    if (!minted.success) return;
    const res = await call(
      null,
      "POST",
      "/api/github/installations/777/link",
      {},
      { token: minted.data.plaintext },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("redirects a form submission to GitHub", async () => {
    const res = await asSession(
      await sessionCookie("alice"),
      "POST",
      "/api/github/installations/777/link",
      { org: "" },
      { form: true },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?/,
    );
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("redirects a refused form submission back to the setup page with a fixed notice", async () => {
    const res = await asSession(
      await sessionCookie("alice"),
      "POST",
      "/api/github/installations/777/link",
      { org: "nope" },
      { form: true },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/github/app/setup?notice=bad_target");
  });
});

describe("POST /github/app/authorize", () => {
  it("requires authentication", async () => {
    const res = await call(null, "POST", "/github/app/authorize", {});
    expect(res.status).toBe(401);
  });

  it("refuses a bearer token and an account with no GitHub identity", async () => {
    const bearer = await call("alice", "POST", "/github/app/authorize", {});
    expect(bearer.status).toBe(403);
    expect(((await bearer.json()) as { code: string }).code).toBe("BROWSER_REQUIRED");

    const noGitHub = await asSession(
      await sessionCookie("bob"),
      "POST",
      "/github/app/authorize",
      {},
    );
    expect(noGitHub.status).toBe(403);
    expect(((await noGitHub.json()) as { code: string }).code).toBe("GITHUB_ACCOUNT_REQUIRED");
  });

  it("lists what GitHub says the caller can link, for that browser only", async () => {
    const cookie = await sessionCookie("alice");
    const started = await asSession(cookie, "POST", "/github/app/authorize", {}, { form: true });
    expect(started.status).toBe(303);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const returned = await asSession(
      cookie,
      "GET",
      `/github/app/callback?code=${stub.approve(acmeOwner(4242))}&state=${state}`,
    );
    expect(noticeOf(returned)).toBe("access_checked");
    expect(owner()).toEqual({ type: null, id: null });

    const mine = await asSession(cookie, "GET", "/api/github/installations");
    expect(((await mine.json()) as { installations: unknown[] }).installations).toEqual([
      expect.objectContaining({ installationId: 777, canLink: true, canUnlink: false }),
    ]);
    // The same account over a token is told nothing: the answer was the browser's.
    const viaToken = await call("alice", "GET", "/api/github/installations");
    expect(((await viaToken.json()) as { installations: unknown[] }).installations).toEqual([]);
  });
});

describe("POST /api/github/installations/:id/unlink", () => {
  beforeEach(() => linkToAcme());

  it("lets an admin of the linked org unlink it", async () => {
    const res = await unlink("bob");
    expect(res.status).toBe(200);
    expect(owner()).toEqual({ type: null, id: null });
    const audit = raw
      .prepare("SELECT org_id FROM audit_log WHERE action = 'github_app.installation_unlinked'")
      .get() as { org_id: string };
    expect(audit.org_id).toBe("org_acme");
  });

  it("does not let the installer unlink an org's link without being its admin", async () => {
    // alice installed the app but is only a member of acme: nothing on the
    // GitHub side is authority over the Stratum org the link now belongs to.
    const res = await unlink("alice");
    expect(res.status).toBe(404);
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });

  it("does not let a GitHub org owner move an org's link to themselves", async () => {
    expect(await linkVia(await sessionCookie("alice"), acmeOwner(4242))).toBe("linked_elsewhere");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });

  it("lets a GitHub org owner link it once the org's admin has unlinked it", async () => {
    expect((await unlink("bob")).status).toBe(200);
    expect(await linkVia(await sessionCookie("alice"), acmeOwner(4242))).toBe("linked");
    expect(owner()).toEqual({ type: "user", id: "usr_alice" });
  });

  it("lets a GitHub org owner who also administers the linked org move it", async () => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    expect(await linkVia(await sessionCookie("alice"), acmeOwner(4242))).toBe("linked");
    expect(owner()).toEqual({ type: "user", id: "usr_alice" });
  });

  it("hides it from anyone else", async () => {
    const res = await unlink("mallory");
    expect(res.status).toBe(404);
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });
});

describe("malformed link bodies", () => {
  it("answers a broken multipart body as a controlled error, not a 500", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/github/installations/777/link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenOf("alice")}`,
          "Content-Type": "multipart/form-data; boundary=missing",
        },
        body: "this is not multipart",
      }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/github/app/setup?notice=error");
    expect(owner()).toEqual({ type: null, id: null });
  });
});

describe("GET /api/github/installations", () => {
  it("lists the installations linked to what the caller holds", async () => {
    linkToAcme();
    const res = await call("bob", "GET", "/api/github/installations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installations: Array<Record<string, unknown>>;
      githubLinked: boolean;
      linkingConfigured: boolean;
    };
    expect(body.githubLinked).toBe(false);
    expect(body.linkingConfigured).toBe(true);
    expect(body.installations).toEqual([
      expect.objectContaining({
        installationId: 777,
        linkedTo: "@acme",
        canUnlink: true,
        // A token cannot start a link, and bob has no GitHub account to confirm with.
        canLink: false,
      }),
    ]);
  });

  it("does not list an installation for the person who installed it", async () => {
    // Being the recorded installer is an audit fact, not a claim on the installation.
    for (const res of [
      await call("alice", "GET", "/api/github/installations"),
      await asSession(await sessionCookie("alice"), "GET", "/api/github/installations"),
    ]) {
      const body = (await res.json()) as { installations: unknown[]; githubLinked: boolean };
      expect(body.githubLinked).toBe(true);
      expect(body.installations).toEqual([]);
    }
  });

  it("says a browser session may start moving a link it holds", async () => {
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'user', stratum_owner_id = 'usr_alice'",
      )
      .run();
    const res = await asSession(await sessionCookie("alice"), "GET", "/api/github/installations");
    const body = (await res.json()) as { installations: unknown[] };
    expect(body.installations).toEqual([
      expect.objectContaining({ installationId: 777, canLink: true, canUnlink: true }),
    ]);
  });

  it("lists nothing for a stranger", async () => {
    const res = await call("mallory", "GET", "/api/github/installations");
    const body = (await res.json()) as { installations: unknown[] };
    expect(body.installations).toEqual([]);
  });
});

describe("GET /github/app/setup", () => {
  it("offers the installation GitHub just redirected back with, by number", async () => {
    const res = await asSession(
      await sessionCookie("alice"),
      "GET",
      "/github/app/setup?installation_id=777&setup_action=install",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Link installation 777 to:");
    expect(html).toContain('action="/api/github/installations/777/link"');
    expect(html).toContain('action="/github/app/authorize"');
    // Typing an id into the URL must not reveal whose installation it is.
    expect(html).not.toContain("Organization");
  });

  it("ignores a notice that is not one of its own keys", async () => {
    const cards = (html: string) => html.split('class="card"').length;
    const baseline = cards(await (await call("alice", "GET", "/github/app/setup")).text());
    for (const notice of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const res = await call("alice", "GET", `/github/app/setup?notice=${notice}`);
      expect(res.status).toBe(200);
      expect(cards(await res.text())).toBe(baseline);
    }
    const real = await call("alice", "GET", "/github/app/setup?notice=linked");
    expect(cards(await real.text())).toBe(baseline + 1);
  });

  it("waits, self-refreshing, for an installation the webhook hasn't recorded yet", async () => {
    const res = await call("alice", "GET", "/github/app/setup?installation_id=999");
    const html = await res.text();
    expect(html).toContain("Waiting for GitHub to confirm installation 999");
    expect(html).toContain('http-equiv="refresh"');
  });

  it("asks a user without a linked GitHub account to sign in with GitHub", async () => {
    const res = await asSession(
      await sessionCookie("bob"),
      "GET",
      "/github/app/setup?installation_id=777",
    );
    const html = await res.text();
    expect(html).toContain("/auth/github?next=");
    expect(html).not.toContain("/api/github/installations/777/link");
    expect(html).not.toContain("/github/app/authorize");
  });

  it("only shows notices from the fixed set", async () => {
    const res = await call("alice", "GET", "/github/app/setup?notice=<script>alert(1)</script>");
    const html = await res.text();
    expect(html).not.toContain("alert(1)");
  });

  it("sends a signed-out visitor to log in", async () => {
    const res = await call(null, "GET", "/github/app/setup?installation_id=777");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
  });
});

describe("org second-factor policy (#256)", () => {
  // The policy governs interactive sign-in, so these go through real sessions.
  beforeEach(() => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    raw.prepare("UPDATE orgs SET require_second_factor = 1 WHERE id = 'org_acme'").run();
  });

  it("refuses to link to the org, and leaves it out of the link targets, until the policy is met", async () => {
    const weak = await sessionCookie("alice");
    const refused = await asSession(weak, "POST", "/api/github/installations/777/link", {
      org: "acme",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "SECOND_FACTOR_REQUIRED", org: "acme" });
    expect(owner()).toEqual({ type: null, id: null });
    // Refused before the trip to GitHub, not after it.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM github_app_link_states").get()).toEqual({ n: 0 });

    const page = await asSession(weak, "GET", "/github/app/setup?installation_id=777");
    expect(await page.text()).not.toContain('value="acme"');

    const strong = await sessionCookie("alice", true);
    const strongPage = await asSession(strong, "GET", "/github/app/setup?installation_id=777");
    expect(await strongPage.text()).toContain('value="acme"');
    expect(await linkVia(strong, acmeOwner(4242), { org: "acme" })).toBe("linked");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });

  it("refuses to unlink from, or move a link away from, the org until the policy is met", async () => {
    linkToAcme();
    const weak = await sessionCookie("alice");

    const unlinkRes = await asSession(weak, "POST", "/api/github/installations/777/unlink", {});
    expect(unlinkRes.status).toBe(403);
    expect(await unlinkRes.json()).toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });

    // The installation is only looked at once GitHub has answered, so a move
    // is refused on return — GitHub's blessing does not stand in for the factor.
    expect(await linkVia(weak, acmeOwner(4242))).toBe("second_factor_required");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });

    const listed = await asSession(weak, "GET", "/api/github/installations");
    const body = (await listed.json()) as { installations: Array<{ canUnlink: boolean }> };
    expect(body.installations[0]?.canUnlink).toBe(false);

    const strong = await sessionCookie("alice", true);
    const ok = await asSession(strong, "POST", "/api/github/installations/777/unlink", {});
    expect(ok.status).toBe(200);
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("refuses the target org on return if the policy stopped being met while at GitHub", async () => {
    raw.prepare("UPDATE orgs SET require_second_factor = 0 WHERE id = 'org_acme'").run();
    const weak = await sessionCookie("alice");
    const started = await asSession(weak, "POST", "/api/github/installations/777/link", {
      org: "acme",
    });
    const { authorizeUrl } = (await started.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";

    raw.prepare("UPDATE orgs SET require_second_factor = 1 WHERE id = 'org_acme'").run();
    const returned = await asSession(
      weak,
      "GET",
      `/github/app/callback?code=${stub.approve(acmeOwner(4242))}&state=${state}`,
    );
    expect(noticeOf(returned)).toBe("second_factor_required");
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("sends a browser form back to the setup page with the notice", async () => {
    const weak = await sessionCookie("alice");
    const res = await app.fetch(
      new Request("http://localhost/api/github/installations/777/link", {
        method: "POST",
        headers: { Cookie: weak, "Content-Type": "application/x-www-form-urlencoded" },
        body: "org=acme",
      }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/github/app/setup?notice=second_factor_required");
  });
});

describe("org IP allowlist (#399)", () => {
  const OFFICE = "203.0.113.7";
  const ELSEWHERE = "198.51.100.9";

  function from(ip: string | null, method: string, path: string, body?: Record<string, string>) {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokenOf("alice")}` };
    if (ip !== null) headers["CF-Connecting-IP"] = ip;
    return send(method, path, headers, body);
  }

  beforeEach(() => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    raw
      .prepare("UPDATE orgs SET ip_allowlist = ? WHERE id = 'org_acme'")
      .run(JSON.stringify(["203.0.113.0/24"]));
  });

  it("refuses an org admin outside the allowlist to link the installation to the org", async () => {
    const cookie = await sessionCookie("alice");
    const refused = await asSession(
      cookie,
      "POST",
      "/api/github/installations/777/link",
      { org: "acme" },
      { ip: ELSEWHERE },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "IP_NOT_ALLOWED" });
    expect(owner()).toEqual({ type: null, id: null });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM github_app_link_states").get()).toEqual({ n: 0 });

    expect(await linkVia(cookie, acmeOwner(4242), { org: "acme", ip: OFFICE })).toBe("linked");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });

  it("refuses the target org on return if the browser has left the allowed network", async () => {
    const cookie = await sessionCookie("alice");
    const started = await asSession(
      cookie,
      "POST",
      "/api/github/installations/777/link",
      { org: "acme" },
      { ip: OFFICE },
    );
    const { authorizeUrl } = (await started.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    const returned = await asSession(
      cookie,
      "GET",
      `/github/app/callback?code=${stub.approve(acmeOwner(4242))}&state=${state}`,
      undefined,
      { ip: ELSEWHERE },
    );
    expect(noticeOf(returned)).toBe("ip_not_allowed");
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("refuses to unlink or move the org's link from outside the allowlist, failing closed with no address", async () => {
    linkToAcme();

    const canUnlinkFrom = async (ip: string) => {
      const listed = await from(ip, "GET", "/api/github/installations");
      const body = (await listed.json()) as { installations: Array<{ canUnlink: boolean }> };
      return body.installations[0]?.canUnlink;
    };
    expect(await canUnlinkFrom(ELSEWHERE)).toBe(false);
    expect(await canUnlinkFrom(OFFICE)).toBe(true);

    const cookie = await sessionCookie("alice");
    for (const ip of [ELSEWHERE, null]) {
      const unlinked = await from(ip, "POST", "/api/github/installations/777/unlink", {});
      expect(unlinked.status).toBe(403);
      expect(await unlinked.json()).toMatchObject({ code: "IP_NOT_ALLOWED" });
      // A move is refused on return from GitHub, where the installation is first looked at.
      expect(await linkVia(cookie, acmeOwner(4242), { ip })).toBe("ip_not_allowed");
    }
    expect(owner()).toEqual({ type: "org", id: "org_acme" });

    const ok = await from(OFFICE, "POST", "/api/github/installations/777/unlink", {});
    expect(ok.status).toBe(200);
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("sends a browser form back to the setup page with the notice, and audits it", async () => {
    // Its own org: denial audits are sampled per org and caller, in memory, so
    // the earlier tests' refusals would otherwise suppress this one.
    raw
      .prepare(
        "INSERT INTO orgs (id, name, slug, owner_id, ip_allowlist) VALUES ('org_form', 'Form', 'form', 'usr_alice', ?)",
      )
      .run(JSON.stringify(["203.0.113.0/24"]));
    raw
      .prepare(
        "INSERT INTO org_members (org_id, user_id, role) VALUES ('org_form', 'usr_alice', 'admin')",
      )
      .run();
    const res = await asSession(
      await sessionCookie("alice"),
      "POST",
      "/api/github/installations/777/link",
      { org: "form" },
      { form: true, ip: ELSEWHERE },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/github/app/setup?notice=ip_not_allowed");
    // The redirect never reaches the IP middleware, so the route must audit it.
    const audited = raw
      .prepare("SELECT org_id FROM audit_log WHERE action = 'org.ip_access_denied'")
      .all() as Array<{ org_id: string }>;
    expect(audited).toEqual([{ org_id: "org_form" }]);
  });
});
