import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { githubAppRouter } from "../src/routes/github-app";
import { createApiToken } from "../src/storage/api-tokens";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { createLogger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * Linking GitHub App installations to Stratum owners, end to end against real
 * SQLite. The property under test: only someone who controls an installation
 * on GitHub (its recorded installer, or the owner of the personal account it
 * is on) can decide which Stratum owner's projects may use it.
 */

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

const logger = createLogger({ component: "Test" });
let raw: Raw;
let env: Env;
let app: Hono<{ Bindings: Env }>;

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

beforeEach(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = { ARTIFACTS: {} as Env["ARTIFACTS"], STATE: makeFakeKV(), DB: sqlite.db };
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
});

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
  let payload: string | undefined;
  if (body !== undefined) {
    if (opts.form) {
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

describe("POST /api/github/installations/:id/link", () => {
  it("lets the installer link it to their personal account, and audits it", async () => {
    const res = await link("alice");
    expect(res.status).toBe(200);
    expect(owner()).toEqual({ type: "user", id: "usr_alice" });

    const audit = raw
      .prepare("SELECT action, actor_id, subject FROM audit_log WHERE action LIKE 'github_app.%'")
      .all();
    expect(audit).toEqual([
      { action: "github_app.installation_linked", actor_id: "usr_alice", subject: "777" },
    ]);
  });

  it("lets the installer link it to an org they administer", async () => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    const res = await link("alice", { org: "acme" });
    expect(res.status).toBe(200);
    expect(owner()).toEqual({ type: "org", id: "org_acme" });

    const row = raw
      .prepare("SELECT org_id FROM audit_log WHERE action = 'github_app.installation_linked'")
      .get() as { org_id: string };
    expect(row.org_id).toBe("org_acme");
  });

  it("refuses an org the installer is only a member of", async () => {
    const res = await link("alice", { org: "acme" });
    expect(res.status).toBe(400);
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("refuses an org that does not exist", async () => {
    const res = await link("alice", { org: "nope" });
    expect(res.status).toBe(400);
  });

  it("hides the installation from a user with no claim on it", async () => {
    const res = await link("mallory");
    expect(res.status).toBe(404);
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("does not let an org admin link it without controlling it on GitHub", async () => {
    // bob administers the Stratum org it would be linked to, but never proved
    // anything on GitHub — admin of the target is not control of the source.
    const res = await link("bob", { org: "acme" });
    expect(res.status).toBe(404);
  });

  it("answers 403, not 404, to a caller who can see it but not link it", async () => {
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_acme'",
      )
      .run();
    const res = await link("bob", { org: "acme" });
    expect(res.status).toBe(403);
  });

  it("does not let an unknown installation id be linked", async () => {
    const res = await link("alice", {}, 123456);
    expect(res.status).toBe(404);
  });

  it("rejects a malformed id", async () => {
    const res = await call("alice", "POST", "/api/github/installations/abc/link", {});
    expect(res.status).toBe(404);
  });

  it("does not let a re-link by a stranger move an existing link", async () => {
    await link("alice");
    const res = await link("mallory");
    expect(res.status).toBe(404);
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
    const res = await link("mallory", {}, 888);
    expect(res.status).toBe(200);
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
    const res = await link("mallory", {}, 889);
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await call(null, "POST", "/api/github/installations/777/link", {});
    expect(res.status).toBe(401);
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

  it("redirects a form submission back to the setup page with a fixed notice", async () => {
    const res = await call(
      "alice",
      "POST",
      "/api/github/installations/777/link",
      { org: "" },
      { form: true },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/github/app/setup?notice=linked");
    expect(owner()).toEqual({ type: "user", id: "usr_alice" });
  });
});

describe("POST /api/github/installations/:id/unlink", () => {
  beforeEach(() => {
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_acme'",
      )
      .run();
  });

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
    // alice installed the app but is only a member of acme: the GitHub-side
    // proof is not authority over the Stratum org the link now belongs to.
    const res = await unlink("alice");
    expect(res.status).toBe(404);
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });

  it("does not let the installer move an org's link to themselves", async () => {
    const res = await link("alice");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("LINKED_ELSEWHERE");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });

    const listed = await call("alice", "GET", "/api/github/installations");
    const body = (await listed.json()) as { installations: Array<{ canLink: boolean }> };
    expect(body.installations[0]?.canLink).toBe(false);
  });

  it("lets the installer relink once the org's admin has unlinked it", async () => {
    expect((await unlink("bob")).status).toBe(200);
    expect((await link("alice")).status).toBe(200);
    expect(owner()).toEqual({ type: "user", id: "usr_alice" });
  });

  it("lets an installer who also administers the linked org move it", async () => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    expect((await link("alice")).status).toBe(200);
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
  it("lists what the caller can manage", async () => {
    const res = await call("alice", "GET", "/api/github/installations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installations: Array<{ installationId: number; canLink: boolean; linkedTo: string | null }>;
      githubLinked: boolean;
    };
    expect(body.githubLinked).toBe(true);
    expect(body.installations).toEqual([
      expect.objectContaining({ installationId: 777, canLink: true, linkedTo: null }),
    ]);
  });

  it("lists nothing for a stranger", async () => {
    const res = await call("mallory", "GET", "/api/github/installations");
    const body = (await res.json()) as { installations: unknown[] };
    expect(body.installations).toEqual([]);
  });
});

describe("GET /github/app/setup", () => {
  it("renders the installer's installation with a link form", async () => {
    const res = await call(
      "alice",
      "GET",
      "/github/app/setup?installation_id=777&setup_action=install",
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("acme");
    expect(html).toContain('action="/api/github/installations/777/link"');
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
    const res = await call("bob", "GET", "/github/app/setup");
    const html = await res.text();
    expect(html).toContain("/auth/github?next=");
    expect(html).not.toContain("/api/github/installations/777/link");
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
  async function sessionCookie(userId: string, withPasskey: boolean): Promise<string> {
    const { createSession } = await import("../src/storage/sessions");
    const created = await createSession(
      env.DB,
      userId,
      logger,
      true,
      withPasskey ? { secondFactor: "passkey" } : {},
    );
    if (!created.success) throw new Error("session not created");
    return `stratum_session=${created.data.id}`;
  }

  function asSession(cookie: string, method: string, path: string, body?: Record<string, string>) {
    return app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          Cookie: cookie,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
  }

  beforeEach(() => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    raw.prepare("UPDATE orgs SET require_second_factor = 1 WHERE id = 'org_acme'").run();
  });

  it("refuses to link to the org, and leaves it out of the link targets, until the policy is met", async () => {
    const weak = await sessionCookie("usr_alice", false);
    const refused = await asSession(weak, "POST", "/api/github/installations/777/link", {
      org: "acme",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "SECOND_FACTOR_REQUIRED", org: "acme" });
    expect(owner()).toEqual({ type: null, id: null });

    const page = await asSession(weak, "GET", "/github/app/setup");
    expect(await page.text()).not.toContain('value="acme"');

    const strong = await sessionCookie("usr_alice", true);
    const strongPage = await asSession(strong, "GET", "/github/app/setup");
    expect(await strongPage.text()).toContain('value="acme"');
    const linked = await asSession(strong, "POST", "/api/github/installations/777/link", {
      org: "acme",
    });
    expect(linked.status).toBe(200);
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });

  it("refuses to unlink from, or move a link away from, the org until the policy is met", async () => {
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_acme' WHERE installation_id = 777",
      )
      .run();
    const weak = await sessionCookie("usr_alice", false);

    const unlinkRes = await asSession(weak, "POST", "/api/github/installations/777/unlink", {});
    expect(unlinkRes.status).toBe(403);
    expect(await unlinkRes.json()).toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });

    const moveRes = await asSession(weak, "POST", "/api/github/installations/777/link", {});
    expect(moveRes.status).toBe(403);
    expect(await moveRes.json()).toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
    expect(owner()).toEqual({ type: "org", id: "org_acme" });

    const listed = await asSession(weak, "GET", "/api/github/installations");
    const body = (await listed.json()) as { installations: Array<{ canUnlink: boolean }> };
    expect(body.installations[0]?.canUnlink).toBe(false);

    const strong = await sessionCookie("usr_alice", true);
    const ok = await asSession(strong, "POST", "/api/github/installations/777/unlink", {});
    expect(ok.status).toBe(200);
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("sends a browser form back to the setup page with the notice", async () => {
    const weak = await sessionCookie("usr_alice", false);
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

  function from(ip: string | null, method: string, path: string, body?: Record<string, string>) {
    const headers: Record<string, string> = { Authorization: `Bearer ${tokenOf("alice")}` };
    if (ip !== null) headers["CF-Connecting-IP"] = ip;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
  }

  beforeEach(() => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    raw
      .prepare("UPDATE orgs SET ip_allowlist = ? WHERE id = 'org_acme'")
      .run(JSON.stringify(["203.0.113.0/24"]));
  });

  it("refuses an org admin outside the allowlist to link the installation to the org", async () => {
    const refused = await from("198.51.100.9", "POST", "/api/github/installations/777/link", {
      org: "acme",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "IP_NOT_ALLOWED" });
    expect(owner()).toEqual({ type: null, id: null });

    const ok = await from(OFFICE, "POST", "/api/github/installations/777/link", { org: "acme" });
    expect(ok.status).toBe(200);
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });

  it("refuses to unlink or move the org's link from outside the allowlist, failing closed with no address", async () => {
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_acme' WHERE installation_id = 777",
      )
      .run();

    const canUnlinkFrom = async (ip: string) => {
      const listed = await from(ip, "GET", "/api/github/installations");
      const body = (await listed.json()) as { installations: Array<{ canUnlink: boolean }> };
      return body.installations[0]?.canUnlink;
    };
    expect(await canUnlinkFrom("198.51.100.9")).toBe(false);
    expect(await canUnlinkFrom(OFFICE)).toBe(true);

    for (const ip of ["198.51.100.9", null]) {
      const unlink = await from(ip, "POST", "/api/github/installations/777/unlink", {});
      expect(unlink.status).toBe(403);
      expect(await unlink.json()).toMatchObject({ code: "IP_NOT_ALLOWED" });
      const move = await from(ip, "POST", "/api/github/installations/777/link", {});
      expect(move.status).toBe(403);
      expect(await move.json()).toMatchObject({ code: "IP_NOT_ALLOWED" });
    }
    expect(owner()).toEqual({ type: "org", id: "org_acme" });

    const ok = await from(OFFICE, "POST", "/api/github/installations/777/unlink", {});
    expect(ok.status).toBe(200);
    expect(owner()).toEqual({ type: null, id: null });
  });

  it("sends a browser form back to the setup page with the notice", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/github/installations/777/link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenOf("alice")}`,
          "CF-Connecting-IP": "198.51.100.9",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "org=acme",
      }),
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/github/app/setup?notice=ip_not_allowed");
  });
});
