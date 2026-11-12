/**
 * Connecting a GitHub account so promoted pull requests are opened as the
 * person promoting, not as the app (migration 086).
 *
 * Like the installation-link tests, these run the whole Worker against a real
 * SQLite D1 with GitHub replaced at `globalThis.fetch`, and keep every log
 * line: this is the one flow that stores a GitHub user token, so "no token is
 * logged, and none is stored in the clear" is checked against everything the
 * Worker wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../src/utils/logger", () => {
  const make = (context: Record<string, unknown> = {}): Record<string, unknown> => {
    const line =
      (level: string) =>
      (msg: string, ...rest: unknown[]): void => {
        recorded.lines.push(
          JSON.stringify({ level, ...context, msg, rest }, (_key, item: unknown) =>
            item instanceof Error ? { name: item.name, message: item.message } : item,
          ),
        );
      };
    return {
      trace: line("trace"),
      debug: line("debug"),
      info: line("info"),
      warn: line("warn"),
      error: line("error"),
      fatal: line("fatal"),
      child: (more: Record<string, unknown>) => make({ ...context, ...more }),
    };
  };
  return { createLogger: make, defaultLogger: make() };
});

import app from "../src/index";
import { resolvePrAuthor } from "../src/services/github-pr-author";
import { deleteAccountCascade } from "../src/storage/deletion";
import { REFRESH_LEASE_SECONDS } from "../src/storage/github-user-connections";
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

const ORIGIN = "https://stratum.test";
const TOKEN_SECRET = "a-long-random-secret-for-user-tokens";
const WEBHOOK_SECRET = "webhook-secret";
const logger = createLogger({ component: "Test" });

type Raw = ReturnType<typeof makeSqliteD1>["raw"];
let raw: Raw;
let env: Env;
let stub: GitHubStub;
const background: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    background.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const ALICE: GitHubPersona = { id: 4242, installations: [] };
const MALLORY: GitHubPersona = { id: 6666, installations: [] };
const ACME = { id: 99, login: "acme", type: "Organization" as const };
const BOB_OWNER: GitHubPersona = {
  id: 5151,
  installations: [{ id: 777, account: ACME }],
  memberships: { acme: { state: "active", role: "admin", organizationId: 99 } },
};

/** Stratum users → the GitHub id their account is known by. Frank signed up by email. */
const USERS: Record<string, string | null> = { alice: "4242", bob: "5151", frank: null };
const cookies: Record<string, string> = {};

function setUp(options: { expiring?: boolean } = {}): void {
  stub?.restore();
  stub = stubGitHub(options);
}

beforeEach(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = {
    DB: sqlite.db,
    STATE: makeFakeKV(),
    GITHUB_APP_CLIENT_ID: STUB_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: STUB_CLIENT_SECRET,
    GITHUB_USER_TOKEN_SECRET: TOKEN_SECRET,
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
  } as unknown as Env;
  for (const [who, githubId] of Object.entries(USERS)) {
    raw
      .prepare(
        "INSERT INTO users (id, email, username, token_hash, github_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        `usr_${who}`,
        `${who}@example.com`,
        who,
        await hashToken(`stratum_user_${who}_token`),
        githubId,
      );
    const created = await createSession(env.DB, `usr_${who}`, logger, true, {});
    if (!created.success) throw created.error;
    cookies[who] = `stratum_session=${created.data.id}`;
  }
  raw
    .prepare(
      `INSERT INTO github_app_installations
         (installation_id, account_login, account_id, account_type, installer_github_id)
       VALUES (777, 'acme', '99', 'Organization', '5151')`,
    )
    .run();
  setUp({ expiring: true });
  recorded.lines.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      recorded.lines.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  stub.restore();
  vi.restoreAllMocks();
});

async function call(
  path: string,
  init: { method?: string; cookie?: string; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers({ Origin: ORIGIN });
  if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  } else if (init.method === "POST") {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = "";
  }
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body }),
    env,
    ctx,
  );
  await Promise.all(background.splice(0));
  return res;
}

/** Where a redirect to the settings page ended, as its notice code. */
function settingsNotice(res: Response): string | null {
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location") ?? "", ORIGIN);
  expect(location.pathname).toBe("/settings");
  expect(location.hash).toBe("#github");
  return location.searchParams.get("notice");
}

/** Presses "Connect GitHub" and returns the state GitHub would be sent. */
async function beginConnect(who: string): Promise<string> {
  const res = await call("/github/app/connect", { method: "POST", cookie: cookies[who] ?? "" });
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
  const state = location.searchParams.get("state");
  if (!state) throw new Error("authorize URL carried no state");
  return state;
}

async function connectAs(who: string, persona: GitHubPersona): Promise<string | null> {
  const state = await beginConnect(who);
  return settingsNotice(
    await call(`/github/app/callback?code=${stub.approve(persona)}&state=${state}`, {
      cookie: cookies[who] ?? "",
    }),
  );
}

interface Row {
  user_id: string;
  github_user_id: string;
  github_login: string;
  access_token: string;
  refresh_token: string | null;
  access_expires_at: number | null;
  refresh_lease_until: number | null;
}

function rows(): Row[] {
  return raw.prepare("SELECT * FROM github_user_connections").all() as Row[];
}

function auditActions(): string[] {
  return (
    raw.prepare("SELECT action FROM audit_log ORDER BY rowid").all() as Array<{ action: string }>
  ).map((row) => row.action);
}

/** Every secret GitHub issued, to look for in logs and in the database. */
function issuedSecrets(): string[] {
  return [...stub.tokens, ...stub.refreshTokens];
}

function dumpDatabase(): string {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return tables
    .map(({ name }) => JSON.stringify(raw.prepare(`SELECT * FROM "${name}"`).all()))
    .join("\n");
}

describe("connecting a GitHub account", () => {
  it("lets the settings page's Connect form follow the redirect to GitHub", async () => {
    // Chromium and WebKit check every hop of a form's redirect chain against
    // the submitting page's `form-action`; under `'self'` alone the button did
    // nothing in production.
    const page = await call("/settings", { cookie: cookies.alice ?? "" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('action="/github/app/connect"');
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("form-action 'self' https://github.com");

    // Once connected the form is gone, and so is the exception.
    await connectAs("alice", ALICE);
    const after = await call("/settings", { cookie: cookies.alice ?? "" });
    expect(await after.text()).not.toContain('action="/github/app/connect"');
    expect(after.headers.get("Content-Security-Policy") ?? "").toMatch(/form-action 'self'(;|$)/);
  });

  it("stores the authorization encrypted, keeps the token alive, and records who", async () => {
    expect(await connectAs("alice", ALICE)).toBe("github-connected");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      user_id: "usr_alice",
      github_user_id: "4242",
      github_login: "user4242",
    });
    // Kept, not revoked: this is the one round trip whose token has a use.
    expect(stub.revoked).toEqual([]);
    expect(auditActions()).toEqual(["github.account_connected"]);

    const everything = `${dumpDatabase()}\n${recorded.lines.join("\n")}`;
    expect(issuedSecrets()).toHaveLength(2);
    for (const secret of issuedSecrets()) expect(everything).not.toContain(secret);
    expect(everything).not.toContain(TOKEN_SECRET);
  });

  it("refuses an authorization made as a different GitHub account, and revokes it", async () => {
    expect(await connectAs("alice", MALLORY)).toBe("github-connect-mismatch");
    expect(rows()).toEqual([]);
    expect(stub.revoked).toEqual(stub.tokens);
    expect(auditActions()).toEqual([]);
  });

  it("stores nothing when the person declines on GitHub", async () => {
    const state = await beginConnect("alice");
    const res = await call(`/github/app/callback?error=access_denied&state=${state}`, {
      cookie: cookies.alice ?? "",
    });
    expect(settingsNotice(res)).toBe("github-connect-declined");
    expect(rows()).toEqual([]);
    expect(stub.callsTo("/login/oauth/access_token")).toEqual([]);
  });

  it("does not let a connect state be redeemed in another person's session", async () => {
    const state = await beginConnect("alice");
    const res = await call(`/github/app/callback?code=${stub.approve(BOB_OWNER)}&state=${state}`, {
      cookie: cookies.bob ?? "",
    });
    expect(res.status).toBe(303);
    expect(rows()).toEqual([]);
    expect(stub.tokens).toEqual([]);
  });

  it("needs a GitHub identity on the account to check the authorization against", async () => {
    const res = await call("/github/app/connect", { method: "POST", cookie: cookies.frank ?? "" });
    expect(settingsNotice(res)).toBe("github-connect-needs-github");
  });

  it("is off, and says so, without the encryption secret", async () => {
    env = { ...env, GITHUB_USER_TOKEN_SECRET: undefined } as unknown as Env;
    const res = await call("/github/app/connect", { method: "POST", cookie: cookies.alice ?? "" });
    expect(settingsNotice(res)).toBe("github-connect-unavailable");
    expect(await resolvePrAuthor(env, "usr_alice", logger)).toEqual({
      kind: "app",
      reason: "not_configured",
    });
  });

  it("refuses a bearer token: connecting is a person in a browser", async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/github/app/connect`, {
        method: "POST",
        headers: { Authorization: "Bearer stratum_user_alice_token" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM github_app_link_states").get()).toEqual({ n: 0 });
  });

  it("replaces an earlier connection when the person connects again", async () => {
    await connectAs("alice", ALICE);
    const first = rows()[0]?.access_token;
    await connectAs("alice", ALICE);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.access_token).not.toBe(first);
    // The replaced pair is revoked: nothing on record could do it later.
    expect(stub.revoked).toEqual([stub.tokens[0]]);
    expect(await resolvePrAuthor(env, "usr_alice", logger)).toMatchObject({
      kind: "user",
      token: stub.tokens[1],
    });
  });
});

describe("linking an installation beside a connection", () => {
  it("still revokes the link's own token and leaves the stored one working", async () => {
    await connectAs("bob", BOB_OWNER);
    const stored = stub.tokens[0];

    const begun = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.bob ?? "",
      json: {},
    });
    const state = new URL(
      ((await begun.json()) as { authorizeUrl: string }).authorizeUrl,
    ).searchParams.get("state");
    const res = await call(`/github/app/callback?code=${stub.approve(BOB_OWNER)}&state=${state}`, {
      cookie: cookies.bob ?? "",
    });
    expect(new URL(res.headers.get("location") ?? "", ORIGIN).searchParams.get("notice")).toBe(
      "linked",
    );

    expect(stub.revoked).toEqual([stub.tokens[1]]);
    const author = await resolvePrAuthor(env, "usr_bob", logger);
    expect(author).toMatchObject({ kind: "user", token: stored, githubLogin: "user5151" });
  });
});

describe("disconnecting", () => {
  it("removes the connection and revokes the token at GitHub", async () => {
    await connectAs("alice", ALICE);
    const res = await call("/github/app/disconnect", {
      method: "POST",
      cookie: cookies.alice ?? "",
    });
    expect(settingsNotice(res)).toBe("github-disconnected");
    expect(rows()).toEqual([]);
    expect(stub.revoked).toEqual(stub.tokens);
    expect(auditActions()).toEqual(["github.account_connected", "github.account_disconnected"]);
    expect(await resolvePrAuthor(env, "usr_alice", logger)).toEqual({
      kind: "app",
      reason: "not_connected",
    });
  });

  it("still removes a connection the deployment can no longer decrypt", async () => {
    await connectAs("alice", ALICE);
    env = { ...env, GITHUB_USER_TOKEN_SECRET: "a-different-secret-entirely" } as unknown as Env;
    expect(await resolvePrAuthor(env, "usr_alice", logger)).toEqual({
      kind: "app",
      reason: "unavailable",
    });
    await call("/github/app/disconnect", { method: "POST", cookie: cookies.alice ?? "" });
    expect(rows()).toEqual([]);
  });

  it("removes the connection when GitHub reports the authorization revoked", async () => {
    await connectAs("alice", ALICE);
    await connectAs("bob", BOB_OWNER);
    const payload = JSON.stringify({ action: "revoked", sender: { id: 4242, login: "user4242" } });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const signature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/webhooks/github`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hub-signature-256": `sha256=${signature}`,
          "x-github-event": "github_app_authorization",
          "x-github-delivery": "delivery-1",
        },
        body: payload,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(rows().map((row) => row.user_id)).toEqual(["usr_bob"]);
  });

  it("revokes the token and removes the connection when the account is erased", async () => {
    await connectAs("alice", ALICE);
    const erased = await deleteAccountCascade(env, "usr_alice", logger);
    expect(erased.success).toBe(true);
    expect(rows()).toEqual([]);
    expect(stub.revoked).toEqual(stub.tokens);
  });
});

describe("the token a promotion is given", () => {
  const HOUR = 3600_000;

  it("is the stored one while it has life left, with no call to GitHub", async () => {
    await connectAs("alice", ALICE);
    const before = stub.calls.length;
    const author = await resolvePrAuthor(env, "usr_alice", logger, Date.now() + HOUR);
    expect(author).toEqual({
      kind: "user",
      userId: "usr_alice",
      githubLogin: "user4242",
      token: stub.tokens[0],
    });
    expect(stub.calls).toHaveLength(before);
  });

  it("is refreshed once expired, and the new pair replaces the old on record", async () => {
    await connectAs("alice", ALICE);
    const before = rows()[0];
    const later = Date.now() + 9 * HOUR;

    const author = await resolvePrAuthor(env, "usr_alice", logger, later);
    expect(author).toMatchObject({ kind: "user", token: stub.tokens[1] });
    const after = rows()[0];
    expect(after?.access_token).not.toBe(before?.access_token);
    expect(after?.refresh_token).not.toBe(before?.refresh_token);
    expect(after?.refresh_lease_until).toBeNull();
    expect(after?.access_expires_at).toBe(Math.floor(later / 1000) + 28800);

    // The stored pair is the live one: the next expiry refreshes again.
    const again = await resolvePrAuthor(env, "usr_alice", logger, later + 9 * HOUR);
    expect(again).toMatchObject({ kind: "user", token: stub.tokens[2] });

    const everything = `${dumpDatabase()}\n${recorded.lines.join("\n")}`;
    for (const secret of issuedSecrets()) expect(everything).not.toContain(secret);
  });

  it("lets only one of two promotions spend the refresh token", async () => {
    await connectAs("alice", ALICE);
    const later = Date.now() + 9 * HOUR;
    const [one, two] = await Promise.all([
      resolvePrAuthor(env, "usr_alice", logger, later),
      resolvePrAuthor(env, "usr_alice", logger, later),
    ]);
    const kinds = [one, two].map((a) => (a.kind === "user" ? "user" : a.reason)).sort();
    expect(kinds).toEqual(["refresh_in_progress", "user"]);
    expect(stub.refreshTokens).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });

  it("takes over a refresh whose lease ran out", async () => {
    await connectAs("alice", ALICE);
    const later = Date.now() + 9 * HOUR;
    const laterSeconds = Math.floor(later / 1000);
    raw
      .prepare("UPDATE github_user_connections SET refresh_lease_until = ?")
      .run(laterSeconds + REFRESH_LEASE_SECONDS);
    expect(await resolvePrAuthor(env, "usr_alice", logger, later)).toEqual({
      kind: "app",
      reason: "refresh_in_progress",
    });
    const afterLease = later + (REFRESH_LEASE_SECONDS + 1) * 1000;
    expect(await resolvePrAuthor(env, "usr_alice", logger, afterLease)).toMatchObject({
      kind: "user",
    });
  });

  it("removes a connection GitHub will no longer refresh", async () => {
    await connectAs("alice", ALICE);
    // The person revoked the app on GitHub: the refresh token is gone there.
    const revoked = stub.tokens[0] ?? "";
    await fetch(`https://api.github.com/applications/${STUB_CLIENT_ID}/token`, {
      method: "DELETE",
      headers: { Authorization: `Basic ${btoa(`${STUB_CLIENT_ID}:${STUB_CLIENT_SECRET}`)}` },
      body: JSON.stringify({ access_token: revoked }),
    });
    expect(await resolvePrAuthor(env, "usr_alice", logger, Date.now() + 9 * HOUR)).toEqual({
      kind: "app",
      reason: "connection_expired",
    });
    expect(rows()).toEqual([]);
  });

  it("keeps the connection when GitHub could not be asked", async () => {
    await connectAs("alice", ALICE);
    stub.refreshOutage = 503;
    const later = Date.now() + 9 * HOUR;
    expect(await resolvePrAuthor(env, "usr_alice", logger, later)).toEqual({
      kind: "app",
      reason: "unavailable",
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.refresh_lease_until).toBeNull();

    stub.refreshOutage = undefined;
    expect(await resolvePrAuthor(env, "usr_alice", logger, later)).toMatchObject({ kind: "user" });
  });

  it("keeps every connection when GitHub rejects the app's own credentials", async () => {
    await connectAs("alice", ALICE);
    // The operator rotated the client secret and the deployment has the old one.
    env = { ...env, GITHUB_APP_CLIENT_SECRET: "no-longer-the-secret" } as unknown as Env;
    const later = Date.now() + 9 * HOUR;
    expect(await resolvePrAuthor(env, "usr_alice", logger, later)).toEqual({
      kind: "app",
      reason: "unavailable",
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.refresh_lease_until).toBeNull();

    env = { ...env, GITHUB_APP_CLIENT_SECRET: STUB_CLIENT_SECRET } as unknown as Env;
    expect(await resolvePrAuthor(env, "usr_alice", logger, later)).toMatchObject({ kind: "user" });
  });

  it("removes a connection whose refresh token has itself expired", async () => {
    await connectAs("alice", ALICE);
    const muchLater = Date.now() + 200 * 24 * HOUR;
    expect(await resolvePrAuthor(env, "usr_alice", logger, muchLater)).toEqual({
      kind: "app",
      reason: "connection_expired",
    });
    expect(rows()).toEqual([]);
    expect(stub.callsTo("/login/oauth/access_token")).toHaveLength(1);
  });

  it("never expires when the app issues tokens that do not", async () => {
    setUp({ expiring: false });
    await connectAs("alice", ALICE);
    expect(rows()[0]).toMatchObject({ refresh_token: null, access_expires_at: null });
    const author = await resolvePrAuthor(env, "usr_alice", logger, Date.now() + 5000 * HOUR);
    expect(author).toMatchObject({ kind: "user", token: stub.tokens[0] });
  });

  it("is the app's for someone who never connected, or for nobody", async () => {
    expect(await resolvePrAuthor(env, "usr_bob", logger)).toEqual({
      kind: "app",
      reason: "not_connected",
    });
    expect(await resolvePrAuthor(env, undefined, logger)).toEqual({
      kind: "app",
      reason: "not_connected",
    });
  });
});

describe("the settings page", () => {
  const page = async (who: string) =>
    (await call("/settings", { cookie: cookies[who] ?? "" })).text();

  it("offers to connect, saying what is kept and what it is used for", async () => {
    const html = await page("alice");
    expect(html).toContain('action="/github/app/connect"');
    expect(html).toContain("opened as you");
    expect(html).toContain("encrypted");
  });

  it("names the connected account and offers to disconnect", async () => {
    await connectAs("alice", ALICE);
    const html = await page("alice");
    expect(html).toContain("@user4242");
    expect(html).toContain('action="/github/app/disconnect"');
    expect(html).not.toContain('action="/github/app/connect"');
  });

  it("explains what is missing to an account with no GitHub identity", async () => {
    const html = await page("frank");
    expect(html).not.toContain('action="/github/app/connect"');
    expect(html).toContain("Sign in with GitHub");
  });

  it("has no GitHub section when the deployment has not turned the feature on", async () => {
    env = { ...env, GITHUB_USER_TOKEN_SECRET: undefined } as unknown as Env;
    const html = await page("alice");
    expect(html).not.toContain('id="github"');
    expect(html).not.toContain('href="#github"');
  });
});
