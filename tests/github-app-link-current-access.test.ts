/**
 * Linking a GitHub App installation is decided by what the person can manage on
 * GitHub at the moment they link (#442), not by who installed the app.
 *
 * These run the whole Worker (`src/index.ts`, so the real auth, CSRF and org
 * policy middleware) against a real SQLite D1, with GitHub replaced at
 * `globalThis.fetch` by a script of what each person can reach right now. The
 * logger is replaced by one that keeps every line, so "the user token is never
 * logged" is checked against everything the Worker tried to log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../src/utils/logger", () => {
  const serialize = (value: unknown): string => {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Error) {
        return { ...item, name: item.name, message: item.message, stack: item.stack };
      }
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
  };
  const make = (context: Record<string, unknown> = {}): Record<string, unknown> => {
    const line =
      (level: string) =>
      (msg: string, ...rest: unknown[]): void => {
        recorded.lines.push(serialize({ level, ...context, msg, rest }));
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
const logger = createLogger({ component: "Test" });

type Raw = ReturnType<typeof makeSqliteD1>["raw"];
let raw: Raw;
let env: Env;
let kv: ReturnType<typeof makeFakeKV>;
let stub: GitHubStub;
let consoleOutput: string[];
const background: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (promise: Promise<unknown>) => {
    background.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** The acme GitHub org, and the app's installation on it. */
const ACME = { id: 99, login: "acme", type: "Organization" as const };
const ACME_INSTALLATION = { id: 777, account: ACME };
const DAVE_INSTALLATION = { id: 888, account: { id: 7171, login: "dave", type: "User" as const } };
const adminOf = (organizationId: number) =>
  ({ state: "active", role: "admin", organizationId }) as const;

/** What GitHub says about each person at the moment they authorize. */
const github = {
  // Alice installed the app on acme, then left the org: GitHub lists nothing.
  aliceAfterLeaving: { id: 4242, installations: [] },
  // …or left but kept one repository as an outside collaborator: still listed.
  aliceAsCollaborator: { id: 4242, installations: [ACME_INSTALLATION] },
  // …or stayed, demoted from owner to member.
  aliceDemoted: {
    id: 4242,
    installations: [ACME_INSTALLATION],
    memberships: { acme: { state: "active", role: "member", organizationId: 99 } },
  },
  aliceStillOwner: {
    id: 4242,
    installations: [ACME_INSTALLATION],
    memberships: { acme: adminOf(99) },
  },
  // Bob owns the acme GitHub org today. He did not install the app.
  bobOwner: { id: 5151, installations: [ACME_INSTALLATION], memberships: { acme: adminOf(99) } },
  // Carol is an ordinary member of the acme GitHub org.
  carolMember: {
    id: 6161,
    installations: [ACME_INSTALLATION],
    memberships: { acme: { state: "active", role: "member", organizationId: 99 } },
  },
  // Dave installed the app on his own account; Erin collaborates on one of his repos.
  dave: { id: 7171, installations: [DAVE_INSTALLATION] },
  erinCollaborator: { id: 8181, installations: [DAVE_INSTALLATION] },
} satisfies Record<string, GitHubPersona>;

const USERS: Record<string, string | null> = {
  alice: "4242",
  bob: "5151",
  carol: "6161",
  dave: "7171",
  erin: "8181",
  frank: null,
};
const cookies: Record<string, string> = {};

async function session(userId: string, secondFactor?: "passkey"): Promise<string> {
  const created = await createSession(
    env.DB,
    userId,
    logger,
    true,
    secondFactor !== undefined ? { secondFactor } : {},
  );
  if (!created.success) throw created.error;
  return `stratum_session=${created.data.id}`;
}

beforeEach(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  kv = makeFakeKV();
  env = {
    DB: sqlite.db,
    STATE: kv,
    GITHUB_APP_CLIENT_ID: STUB_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET: STUB_CLIENT_SECRET,
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
    cookies[who] = await session(`usr_${who}`);
  }
  // The Stratum org. Bob administers it; Alice is an ordinary member.
  raw
    .prepare(
      "INSERT INTO orgs (id, name, slug, owner_id) VALUES ('org_acme', 'Acme', 'acme', 'usr_bob')",
    )
    .run();
  raw
    .prepare(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ('org_acme', 'usr_bob', 'admin'), ('org_acme', 'usr_alice', 'member')`,
    )
    .run();
  // The installations as their webhooks recorded them. Alice is 777's installer.
  raw
    .prepare(
      `INSERT INTO github_app_installations
         (installation_id, account_login, account_id, account_type, installer_github_id)
       VALUES (777, 'acme', '99', 'Organization', '4242'),
              (888, 'dave', '7171', 'User', '7171')`,
    )
    .run();

  stub = stubGitHub();
  recorded.lines.length = 0;
  consoleOutput = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  stub.restore();
  vi.restoreAllMocks();
});

async function call(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    json?: unknown;
    form?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers({ Origin: ORIGIN, ...init.headers });
  if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  } else if (init.form !== undefined) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  }
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body }),
    env,
    ctx,
  );
  // The token revocation is handed to waitUntil; let it finish before asserting.
  await Promise.all(background.splice(0));
  return res;
}

/** Starts a link and returns the `state` GitHub would be sent. */
async function begin(who: string, installationId = 777, org?: string): Promise<string> {
  const res = await call(`/api/github/installations/${installationId}/link`, {
    method: "POST",
    cookie: cookies[who] ?? "",
    json: org !== undefined ? { org } : {},
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; authorizeUrl: string };
  expect(body.ok).toBe(true);
  const state = new URL(body.authorizeUrl).searchParams.get("state");
  if (!state) throw new Error("authorize URL carried no state");
  return state;
}

/** The person approves on GitHub and their browser lands back on the callback. */
function comeBack(cookie: string, state: string, persona: GitHubPersona): Promise<Response> {
  return call(`/github/app/callback?code=${stub.approve(persona)}&state=${state}`, { cookie });
}

function noticeOf(res: Response): string | null {
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get("location") ?? "", ORIGIN);
  expect(location.pathname).toBe("/github/app/setup");
  return location.searchParams.get("notice");
}

/** One whole round trip; returns the notice the person ends up looking at. */
async function linkAs(
  who: string,
  persona: GitHubPersona,
  installationId = 777,
  org?: string,
): Promise<string | null> {
  const state = await begin(who, installationId, org);
  return noticeOf(await comeBack(cookies[who] ?? "", state, persona));
}

function owner(id = 777): { type: string | null; id: string | null } {
  const row = raw
    .prepare(
      "SELECT stratum_owner_type, stratum_owner_id FROM github_app_installations WHERE installation_id = ?",
    )
    .get(id) as { stratum_owner_type: string | null; stratum_owner_id: string | null };
  return { type: row.stratum_owner_type, id: row.stratum_owner_id };
}

const UNLINKED = { type: null, id: null };

function count(table: string): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function dumpDatabase(): string {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return tables
    .map(({ name }) => `${name}: ${JSON.stringify(raw.prepare(`SELECT * FROM "${name}"`).all())}`)
    .join("\n");
}

async function listed(who: string): Promise<Array<{ installationId: number; canLink: boolean }>> {
  const res = await call("/api/github/installations", { cookie: cookies[who] ?? "" });
  expect(res.status).toBe(200);
  return (
    (await res.json()) as { installations: Array<{ installationId: number; canLink: boolean }> }
  ).installations;
}

describe("who may link an organization's installation", () => {
  it("refuses the person who installed the app once they have left the GitHub org", async () => {
    expect(await linkAs("alice", github.aliceAfterLeaving)).toBe("not_found");
    expect(owner()).toEqual(UNLINKED);
    // GitHub listed nothing for her, so there was no membership left to ask about.
    expect(stub.callsTo("/user/installations")).toHaveLength(1);
    expect(stub.callsTo("/user/memberships")).toHaveLength(0);
    expect(count("audit_log")).toBe(0);
  });

  it("refuses the installer who kept repository access but is no longer in the org", async () => {
    expect(await linkAs("alice", github.aliceAsCollaborator)).toBe("not_authorized");
    expect(owner()).toEqual(UNLINKED);
  });

  it("refuses the installer who was demoted from owner to member", async () => {
    expect(await linkAs("alice", github.aliceDemoted)).toBe("not_authorized");
    expect(owner()).toEqual(UNLINKED);
  });

  it("lets a current org owner who did not install it link it", async () => {
    expect(await linkAs("bob", github.bobOwner)).toBe("linked");
    expect(owner()).toEqual({ type: "user", id: "usr_bob" });

    const audit = raw
      .prepare("SELECT action, actor_id, subject, detail FROM audit_log")
      .all() as Array<{ action: string; actor_id: string; subject: string; detail: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "github_app.installation_linked",
      actor_id: "usr_bob",
      subject: "777",
    });
    expect(JSON.parse(audit[0]?.detail ?? "{}")).toEqual({
      account: "acme",
      ownerType: "user",
      ownerId: "usr_bob",
    });
  });

  it("lets that owner link it to a Stratum org they administer", async () => {
    expect(await linkAs("bob", github.bobOwner, 777, "acme")).toBe("linked");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
    const row = raw.prepare("SELECT org_id FROM audit_log").get() as { org_id: string };
    expect(row.org_id).toBe("org_acme");
  });

  it("refuses an org member who is not an admin", async () => {
    expect(await linkAs("carol", github.carolMember)).toBe("not_authorized");
    expect(owner()).toEqual(UNLINKED);
    expect(stub.callsTo("/user/memberships/orgs/acme")).toHaveLength(1);
  });

  it("refuses an admin invitation that has not been accepted", async () => {
    const invited: GitHubPersona = {
      ...github.carolMember,
      memberships: { acme: { state: "pending", role: "admin", organizationId: 99 } },
    };
    expect(await linkAs("carol", invited)).toBe("not_authorized");
    expect(owner()).toEqual(UNLINKED);
  });

  it("refuses an admin of a different org that now answers to the same login", async () => {
    // Logins are reused; the installation is on account 99, whatever it is called.
    const impostor: GitHubPersona = { ...github.carolMember, memberships: { acme: adminOf(100) } };
    expect(await linkAs("carol", impostor)).toBe("not_authorized");
    expect(owner()).toEqual(UNLINKED);
  });

  it("refuses an installation id GitHub lists on another account than the one recorded", async () => {
    const elsewhere: GitHubPersona = {
      id: 6161,
      installations: [
        { id: 777, account: { id: 12345, login: "carols-org", type: "Organization" } },
      ],
      memberships: { "carols-org": adminOf(12345) },
    };
    expect(await linkAs("carol", elsewhere)).toBe("not_found");
    expect(owner()).toEqual(UNLINKED);
  });

  it("has no rule, and so no way in, for an installation on anything but a user or an org", async () => {
    const enterprise: GitHubPersona = {
      id: 5151,
      installations: [{ id: 777, account: { id: 99, login: "acme", type: "Enterprise" } }],
      memberships: { acme: adminOf(99) },
    };
    expect(await linkAs("bob", enterprise)).toBe("not_authorized");
    expect(owner()).toEqual(UNLINKED);
  });

  it("finds the installation on a later page of GitHub's list", async () => {
    stub.restore();
    stub = stubGitHub({ pageSize: 1 });
    const busy: GitHubPersona = {
      id: 5151,
      installations: [
        { id: 1, account: { id: 1001, login: "one", type: "Organization" } },
        { id: 2, account: { id: 1002, login: "two", type: "Organization" } },
        ACME_INSTALLATION,
      ],
      memberships: { acme: adminOf(99) },
    };
    expect(await linkAs("bob", busy)).toBe("linked");
    expect(owner()).toEqual({ type: "user", id: "usr_bob" });
    const pages = stub
      .callsTo("/user/installations")
      .map((request) => new URL(request.url).searchParams.get("page"));
    expect(pages).toEqual(["1", "2", "3"]);
  });

  it("does not consult who installed the app, even with nothing else to go on", async () => {
    // The installer is still an owner: allowed, like any owner.
    expect(await linkAs("alice", github.aliceStillOwner)).toBe("linked");
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = NULL, stratum_owner_id = NULL",
      )
      .run();
    // The same person, the same recorded installer, and GitHub now says no.
    expect(await linkAs("alice", github.aliceAfterLeaving)).toBe("not_found");
    expect(owner()).toEqual(UNLINKED);
    // And an installation with no installer recorded at all links on GitHub's word.
    raw.prepare("UPDATE github_app_installations SET installer_github_id = NULL").run();
    expect(await linkAs("bob", github.bobOwner)).toBe("linked");
  });
});

describe("who may link a personal account's installation", () => {
  it("lets the account itself link it", async () => {
    expect(await linkAs("dave", github.dave, 888)).toBe("linked");
    expect(owner(888)).toEqual({ type: "user", id: "usr_dave" });
    // A personal account has no membership to ask about.
    expect(stub.callsTo("/user/memberships")).toHaveLength(0);
  });

  it("refuses a collaborator, whom GitHub lists the installation for as well", async () => {
    expect(await linkAs("erin", github.erinCollaborator, 888)).toBe("not_authorized");
    expect(owner(888)).toEqual(UNLINKED);
  });
});

describe("the authorizing GitHub account", () => {
  it("must be the one connected to the Stratum account", async () => {
    // Carol's session, finished with an authorization Bob (a real owner) gave.
    const state = await begin("carol");
    expect(noticeOf(await comeBack(cookies.carol ?? "", state, github.bobOwner))).toBe(
      "github_account_mismatch",
    );
    expect(owner()).toEqual(UNLINKED);
  });

  it("is required: an account with no GitHub identity cannot start", async () => {
    const res = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.frank ?? "",
      json: {},
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "GITHUB_ACCOUNT_REQUIRED" });
    expect(count("github_app_link_states")).toBe(0);
  });
});

describe("when GitHub cannot answer", () => {
  it.each([
    ["the installation list", "/user/installations", 500],
    ["the identity of the user", "/user", 503],
    ["the org membership", "/user/memberships", 500],
  ])("refuses the link if %s is unavailable", async (_what, path, status) => {
    stub.outages.set(path, status);
    expect(await linkAs("bob", github.bobOwner)).toBe("github_unavailable");
    expect(owner()).toEqual(UNLINKED);
    // The token was still handed back for revocation.
    expect(stub.revoked).toEqual(stub.tokens);
  });

  it("treats an org that hides its membership from the app as not an admin", async () => {
    stub.outages.set("/user/memberships", 403);
    expect(await linkAs("bob", github.bobOwner)).toBe("not_authorized");
    expect(owner()).toEqual(UNLINKED);
  });

  it("refuses the link if the code cannot be exchanged", async () => {
    const state = await begin("bob");
    const res = await call(`/github/app/callback?code=never-issued&state=${state}`, {
      cookie: cookies.bob ?? "",
    });
    expect(noticeOf(res)).toBe("github_unavailable");
    expect(owner()).toEqual(UNLINKED);
    expect(stub.callsTo("/user")).toHaveLength(0);
  });

  it("refuses the link if the exchange fails outright", async () => {
    stub.exchangeAnswer = { status: 500, body: "upstream exploded" };
    expect(await linkAs("bob", github.bobOwner)).toBe("github_unavailable");
    expect(owner()).toEqual(UNLINKED);
  });

  it("tells the person nothing changed when they cancel on GitHub", async () => {
    const state = await begin("bob");
    const res = await call(`/github/app/callback?error=access_denied&state=${state}`, {
      cookie: cookies.bob ?? "",
    });
    expect(noticeOf(res)).toBe("authorization_denied");
    expect(stub.calls).toHaveLength(0);
    // Cancelling spends the state like any other return.
    expect(noticeOf(await comeBack(cookies.bob ?? "", state, github.bobOwner))).toBe(
      "state_invalid",
    );
    expect(owner()).toEqual(UNLINKED);
  });
});

describe("the state parameter", () => {
  it("is sent to GitHub's authorize URL with the app's client id and this deployment's callback", async () => {
    const res = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.bob ?? "",
      form: { org: "" },
    });
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get("location") ?? "");
    expect(`${target.origin}${target.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(target.searchParams.get("client_id")).toBe(STUB_CLIENT_ID);
    expect(target.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/github/app/callback`);
    expect(target.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    // The secret stays on the server, and a GitHub App has no scopes to ask for.
    expect([...target.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "state"]);
  });

  it("is stored only as a hash, alongside the hash of the session", async () => {
    const state = await begin("bob");
    const rows = raw
      .prepare("SELECT state_hash, session_hash, user_id FROM github_app_link_states")
      .all();
    const sessionId = (cookies.bob ?? "").replace("stratum_session=", "");
    expect(rows).toEqual([
      {
        state_hash: await hashToken(state),
        session_hash: await hashToken(sessionId),
        user_id: "usr_bob",
      },
    ]);
    expect(dumpDatabase()).not.toContain(state);
    expect(dumpDatabase()).not.toContain(sessionId);
  });

  it("is single-use: replaying it does nothing, even with a fresh authorization", async () => {
    const state = await begin("bob");
    expect(noticeOf(await comeBack(cookies.bob ?? "", state, github.bobOwner))).toBe("linked");
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = NULL, stratum_owner_id = NULL",
      )
      .run();
    const exchanges = stub.callsTo("/login/oauth/access_token").length;

    expect(noticeOf(await comeBack(cookies.bob ?? "", state, github.bobOwner))).toBe(
      "state_invalid",
    );
    expect(owner()).toEqual(UNLINKED);
    // Refused before the code was ever redeemed.
    expect(stub.callsTo("/login/oauth/access_token")).toHaveLength(exchanges);
  });

  it("is spent by a refused attempt too", async () => {
    const state = await begin("carol");
    expect(noticeOf(await comeBack(cookies.carol ?? "", state, github.carolMember))).toBe(
      "not_authorized",
    );
    expect(count("github_app_link_states")).toBe(0);
    expect(noticeOf(await comeBack(cookies.carol ?? "", state, github.carolMember))).toBe(
      "state_invalid",
    );
  });

  it("is bound to the session: another person's browser cannot finish it", async () => {
    // Carol prepares a link of acme's installation to her own account, then
    // gets Bob — who really does own the GitHub org — to land on the callback.
    const state = await begin("carol");
    expect(noticeOf(await comeBack(cookies.bob ?? "", state, github.bobOwner))).toBe(
      "state_invalid",
    );
    expect(owner()).toEqual(UNLINKED);
    expect(stub.calls).toHaveLength(0);
    // And it is burned, not handed back to Carol for another try.
    expect(count("github_app_link_states")).toBe(0);
    expect(noticeOf(await comeBack(cookies.carol ?? "", state, github.carolMember))).toBe(
      "state_invalid",
    );
  });

  it("is bound to the session: the same person's other browser cannot finish it", async () => {
    const state = await begin("bob");
    const otherBrowser = await session("usr_bob");
    expect(noticeOf(await comeBack(otherBrowser, state, github.bobOwner))).toBe("state_invalid");
    expect(owner()).toEqual(UNLINKED);
    expect(stub.calls).toHaveLength(0);
  });

  it("expires", async () => {
    const state = await begin("bob");
    raw
      .prepare("UPDATE github_app_link_states SET expires_at = ?")
      .run(Math.floor(Date.now() / 1000) - 1);
    expect(noticeOf(await comeBack(cookies.bob ?? "", state, github.bobOwner))).toBe(
      "state_invalid",
    );
    expect(owner()).toEqual(UNLINKED);
    expect(stub.calls).toHaveLength(0);
  });

  it.each([
    ["one this server never issued", "f".repeat(64)],
    ["an oversized one", "a".repeat(4096)],
  ])("refuses %s without calling GitHub", async (_what, state) => {
    const res = await call(
      `/github/app/callback?code=${stub.approve(github.bobOwner)}&state=${state}`,
      { cookie: cookies.bob ?? "" },
    );
    expect(noticeOf(res)).toBe("state_invalid");
    expect(stub.calls).toHaveLength(0);
  });

  it("is required: the code GitHub sends after an install is never redeemed", async () => {
    // "Request user authorization (OAuth) during installation" lands people on
    // the callback with a code and no state.
    const code = stub.approve(github.bobOwner);
    const res = await call(
      `/github/app/callback?code=${code}&installation_id=777&setup_action=install`,
      { cookie: cookies.bob ?? "" },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/github/app/setup?installation_id=777");
    expect(stub.calls).toHaveLength(0);
    expect(owner()).toEqual(UNLINKED);
  });

  it("is refused for a bearer token: only a browser session can be walked through GitHub", async () => {
    const state = await begin("bob");
    const res = await call(
      `/github/app/callback?code=${stub.approve(github.bobOwner)}&state=${state}`,
      { headers: { Authorization: "Bearer stratum_user_bob_token" } },
    );
    expect(noticeOf(res)).toBe("state_invalid");
    expect(stub.calls).toHaveLength(0);
    expect(owner()).toEqual(UNLINKED);
  });

  it("sends a signed-out visitor to log in, and back to the setup page rather than the spent URL", async () => {
    const res = await call("/github/app/callback?code=abc&state=def&installation_id=777");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("a deployment without the GitHub App's OAuth credentials", () => {
  it.each([
    ["neither is set", [] as string[]],
    ["only the client id is set", ["GITHUB_APP_CLIENT_ID"]],
    ["only the client secret is set", ["GITHUB_APP_CLIENT_SECRET"]],
    ["they are blank", ["blank"]],
  ])("refuses to link when %s, naming what to set", async (_what, keep) => {
    const configured = { id: env.GITHUB_APP_CLIENT_ID, secret: env.GITHUB_APP_CLIENT_SECRET };
    env.GITHUB_APP_CLIENT_ID = keep.includes("blank") ? "  " : undefined;
    env.GITHUB_APP_CLIENT_SECRET = keep.includes("blank") ? "" : undefined;
    if (keep.includes("GITHUB_APP_CLIENT_ID")) env.GITHUB_APP_CLIENT_ID = configured.id;
    if (keep.includes("GITHUB_APP_CLIENT_SECRET")) {
      env.GITHUB_APP_CLIENT_SECRET = configured.secret;
    }

    // Alice installed the app. Under the old rule that alone would have linked it.
    const res = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.alice ?? "",
      json: {},
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("NOT_CONFIGURED");
    expect(body.error).toContain("GITHUB_APP_CLIENT_ID");
    expect(body.error).toContain("GITHUB_APP_CLIENT_SECRET");

    const form = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.alice ?? "",
      form: { org: "" },
    });
    expect(noticeOf(form)).toBe("not_configured");

    const discover = await call("/github/app/authorize", {
      method: "POST",
      cookie: cookies.alice ?? "",
      form: {},
    });
    expect(noticeOf(discover)).toBe("not_configured");

    expect(owner()).toEqual(UNLINKED);
    expect(count("github_app_link_states")).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("does not use the login OAuth app's credentials instead", async () => {
    env.GITHUB_APP_CLIENT_ID = undefined;
    env.GITHUB_APP_CLIENT_SECRET = undefined;
    env.GITHUB_CLIENT_ID = "login-oauth-app-id";
    env.GITHUB_CLIENT_SECRET = "login-oauth-app-secret";
    const res = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.bob ?? "",
      json: {},
    });
    expect(res.status).toBe(501);
  });

  it("refuses a round trip already under way when the credentials are withdrawn", async () => {
    const state = await begin("bob");
    env.GITHUB_APP_CLIENT_SECRET = undefined;
    expect(noticeOf(await comeBack(cookies.bob ?? "", state, github.bobOwner))).toBe(
      "not_configured",
    );
    expect(owner()).toEqual(UNLINKED);
    expect(stub.calls).toHaveLength(0);
  });

  it("says so on the setup page and in the listing, and offers no link form", async () => {
    env.GITHUB_APP_CLIENT_ID = undefined;
    const page = await call("/github/app/setup?installation_id=777", {
      cookie: cookies.alice ?? "",
    });
    const html = await page.text();
    expect(html).toContain("Linking is not configured on this deployment.");
    expect(html).toContain("GITHUB_APP_CLIENT_SECRET");
    expect(html).not.toContain("/api/github/installations/777/link");
    expect(html).not.toContain("/github/app/authorize");

    const res = await call("/api/github/installations", { cookie: cookies.alice ?? "" });
    expect(await res.json()).toMatchObject({ linkingConfigured: false, installations: [] });
  });

  it("still lets an existing link be removed", async () => {
    env.GITHUB_APP_CLIENT_ID = undefined;
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_acme' WHERE installation_id = 777",
      )
      .run();
    const res = await call("/api/github/installations/777/unlink", {
      method: "POST",
      cookie: cookies.bob ?? "",
      json: {},
    });
    expect(res.status).toBe(200);
    expect(owner()).toEqual(UNLINKED);
  });
});

describe("the user token", () => {
  it("is used within the request, revoked, and leaves no trace in D1, KV, the logs or any response", async () => {
    const responses: string[] = [];
    const states: string[] = [];
    const roundTrip = async (who: string, persona: GitHubPersona, installationId?: number) => {
      const started =
        installationId !== undefined
          ? await call(`/api/github/installations/${installationId}/link`, {
              method: "POST",
              cookie: cookies[who] ?? "",
              json: {},
            })
          : await call("/github/app/authorize", {
              method: "POST",
              cookie: cookies[who] ?? "",
              json: {},
            });
      const { authorizeUrl } = (await started.json()) as { authorizeUrl: string };
      const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
      states.push(state);
      const res = await comeBack(cookies[who] ?? "", state, persona);
      responses.push(JSON.stringify([...res.headers]), await res.text());
      const page = await call(res.headers.get("location") ?? "/", { cookie: cookies[who] ?? "" });
      responses.push(JSON.stringify([...page.headers]), await page.text());
    };

    await roundTrip("bob", github.bobOwner, 777); // linked
    await roundTrip("carol", github.carolMember, 777); // refused by GitHub's answer
    await roundTrip("alice", github.aliceAfterLeaving, 777); // refused: not listed
    await roundTrip("dave", github.dave); // refreshes the linkable list
    await roundTrip("erin", github.bobOwner, 777); // refused: someone else's authorization
    stub.outages.set("/user/memberships", 500);
    await roundTrip("bob", github.bobOwner, 777); // GitHub fails mid-check

    // Each round trip minted a token, and that token is what asked GitHub.
    expect(stub.tokens).toHaveLength(6);
    const bearers = new Set(
      stub.calls
        .filter((request) => request.url.startsWith("https://api.github.com/user"))
        .map((request) => request.authorization),
    );
    expect(bearers).toEqual(new Set(stub.tokens.map((token) => `Bearer ${token}`)));
    // Every one was handed back to GitHub to be invalidated, whatever the outcome.
    expect(stub.revoked).toEqual(stub.tokens);

    const places = {
      d1: dumpDatabase(),
      kv: JSON.stringify([...kv.store]),
      logs: recorded.lines.join("\n"),
      console: consoleOutput.join("\n"),
      responses: responses.join("\n"),
    };
    // The sweep is looking at real content, not at empty strings.
    expect(places.d1).toContain("github_app.installation_linked");
    expect(places.d1).toContain("github_app_access_snapshots");
    expect(places.logs).toContain("GitHub App installation linked");
    expect(places.logs).toContain("GitHub App installation link refused");
    expect(places.responses).toContain("Installation linked.");

    for (const [place, content] of Object.entries(places)) {
      for (const token of stub.tokens) {
        expect(content.includes(token), `user token found in ${place}`).toBe(false);
      }
      // Nor any recognisable piece of one.
      expect(content.includes("ghu_"), `token prefix found in ${place}`).toBe(false);
      expect(content.includes("STUBUSERTOKEN"), `token body found in ${place}`).toBe(false);
      expect(content.includes(STUB_CLIENT_SECRET), `client secret found in ${place}`).toBe(false);
    }
    // The state is a bearer of intent until spent: hashed at rest, never logged.
    for (const state of states) {
      expect(places.d1.includes(state)).toBe(false);
      expect(places.kv.includes(state)).toBe(false);
      expect(places.logs.includes(state)).toBe(false);
    }
  });

  it("is not logged when GitHub's exchange answer is malformed or hostile", async () => {
    stub.exchangeAnswer = {
      status: 200,
      body: JSON.stringify({
        error: "ghu_LEAKED in an error code",
        error_description: "ghu_LEAKED in a description",
        access_token: "",
      }),
    };
    expect(await linkAs("bob", github.bobOwner)).toBe("github_unavailable");
    stub.exchangeAnswer = { status: 400, body: "ghu_LEAKED in a raw body" };
    expect(await linkAs("bob", github.bobOwner)).toBe("github_unavailable");

    expect(recorded.lines.join("\n")).toContain("GitHub App code exchange");
    expect(recorded.lines.join("\n")).not.toContain("ghu_LEAKED");
    expect(dumpDatabase()).not.toContain("ghu_LEAKED");
  });
});

describe("finding the installations a person can link", () => {
  async function discover(who: string, persona: GitHubPersona): Promise<string | null> {
    const started = await call("/github/app/authorize", {
      method: "POST",
      cookie: cookies[who] ?? "",
      form: {},
    });
    expect(started.status).toBe(303);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    return noticeOf(await comeBack(cookies[who] ?? "", state, persona));
  }

  it("shows nobody an unlinked installation until GitHub has vouched for them — the installer included", async () => {
    for (const who of ["alice", "bob", "carol", "frank"]) expect(await listed(who)).toEqual([]);
  });

  it("offers an owner the installations GitHub says they manage, and changes nothing", async () => {
    expect(await discover("bob", github.bobOwner)).toBe("access_checked");
    expect(await listed("bob")).toEqual([
      expect.objectContaining({ installationId: 777, canLink: true }),
    ]);
    expect(owner()).toEqual(UNLINKED);
    expect(count("audit_log")).toBe(0);

    const page = await call("/github/app/setup?notice=access_checked", {
      cookie: cookies.bob ?? "",
    });
    const html = await page.text();
    expect(html).toContain('action="/api/github/installations/777/link"');
    expect(html).toContain("acme");
  });

  it("offers nothing to a member, a collaborator, or someone who has left", async () => {
    expect(await discover("carol", github.carolMember)).toBe("access_checked");
    expect(await discover("erin", github.erinCollaborator)).toBe("access_checked");
    expect(await discover("alice", github.aliceAfterLeaving)).toBe("access_checked");
    for (const who of ["carol", "erin", "alice"]) expect(await listed(who)).toEqual([]);
  });

  it("keeps the answer to the browser that asked, and only for a while", async () => {
    expect(await discover("bob", github.bobOwner)).toBe("access_checked");
    const otherBrowser = await session("usr_bob");
    const elsewhere = await call("/api/github/installations", { cookie: otherBrowser });
    expect(((await elsewhere.json()) as { installations: unknown[] }).installations).toEqual([]);

    raw
      .prepare("UPDATE github_app_access_snapshots SET expires_at = ?")
      .run(Math.floor(Date.now() / 1000) - 1);
    expect(await listed("bob")).toEqual([]);
  });

  it("replaces the earlier answer rather than adding to it", async () => {
    expect(await discover("bob", github.bobOwner)).toBe("access_checked");
    expect(await discover("bob", { id: 5151, installations: [] })).toBe("access_checked");
    expect(await listed("bob")).toEqual([]);
    expect(count("github_app_access_snapshots")).toBe(0);
  });

  it("is only a list of what to offer: the link itself asks GitHub again", async () => {
    expect(await discover("bob", github.bobOwner)).toBe("access_checked");
    expect(await listed("bob")).toHaveLength(1);
    // Bob is removed as an owner on GitHub between looking and clicking.
    const demoted: GitHubPersona = {
      ...github.bobOwner,
      memberships: { acme: { state: "active", role: "member", organizationId: 99 } },
    };
    expect(await linkAs("bob", demoted)).toBe("not_authorized");
    expect(owner()).toEqual(UNLINKED);
  });

  it("skips an installation whose webhook has not been recorded yet", async () => {
    const early: GitHubPersona = {
      id: 5151,
      installations: [
        ACME_INSTALLATION,
        { id: 4040, account: { id: 4041, login: "new-org", type: "Organization" } },
      ],
      memberships: { acme: adminOf(99), "new-org": adminOf(4041) },
    };
    expect(await discover("bob", early)).toBe("access_checked");
    expect((await listed("bob")).map((inst) => inst.installationId)).toEqual([777]);
  });
});

describe("the setup page", () => {
  it("lets its forms follow the redirect to GitHub, and nowhere else", async () => {
    const page = await call("/github/app/setup", { cookie: cookies.bob ?? "" });
    expect(page.status).toBe(200);
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("form-action 'self' https://github.com");
    // Other pages keep the site-wide policy.
    const other = await call("/settings", { cookie: cookies.bob ?? "" });
    expect(other.headers.get("Content-Security-Policy") ?? "").toMatch(/form-action 'self'(;|$)/);
  });

  it("offers a recorded installation by number alone, without saying whose it is", async () => {
    raw
      .prepare(
        "UPDATE github_app_installations SET account_login = 'secret-corp' WHERE installation_id = 777",
      )
      .run();
    const page = await call("/github/app/setup?installation_id=777&setup_action=install", {
      cookie: cookies.carol ?? "",
    });
    const html = await page.text();
    expect(html).toContain("Link installation 777 to:");
    expect(html).toContain('action="/api/github/installations/777/link"');
    expect(html).not.toContain("secret-corp");
  });

  it("starts the same round trip from the form, with the session's Origin enforced", async () => {
    const forged = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.bob ?? "",
      form: { org: "" },
      headers: { Origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
    expect(count("github_app_link_states")).toBe(0);
  });
});

describe("Stratum-side authority is still required, and checked again on return", () => {
  beforeEach(() => {
    raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
  });

  it("refuses a target org the person does not administer before sending them to GitHub", async () => {
    const res = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.carol ?? "",
      json: { org: "acme" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "BAD_TARGET" });
    expect(count("github_app_link_states")).toBe(0);
  });

  it("refuses the target org if the person stopped administering it while at GitHub", async () => {
    const state = await begin("bob", 777, "acme");
    raw.prepare("UPDATE org_members SET role = 'member' WHERE user_id = 'usr_bob'").run();
    raw.prepare("UPDATE orgs SET owner_id = 'usr_alice' WHERE id = 'org_acme'").run();
    expect(noticeOf(await comeBack(cookies.bob ?? "", state, github.bobOwner))).toBe("bad_target");
    expect(owner()).toEqual(UNLINKED);
  });

  it("does not let GitHub-side control move a link away from a Stratum owner", async () => {
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'user', stratum_owner_id = 'usr_dave' WHERE installation_id = 777",
      )
      .run();
    expect(await linkAs("bob", github.bobOwner)).toBe("linked_elsewhere");
    expect(owner()).toEqual({ type: "user", id: "usr_dave" });
  });

  it("lets someone with both GitHub control and the current owner's authority move it", async () => {
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_acme' WHERE installation_id = 777",
      )
      .run();
    expect(await linkAs("bob", github.bobOwner)).toBe("linked");
    expect(owner()).toEqual({ type: "user", id: "usr_bob" });
    const row = raw.prepare("SELECT detail FROM audit_log").get() as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({
      previousOwner: { type: "org", id: "org_acme" },
    });
  });

  it("holds the org's second-factor policy (#256) at the start and on return", async () => {
    raw.prepare("UPDATE orgs SET require_second_factor = 1 WHERE id = 'org_acme'").run();

    // To the org: refused before the trip.
    const refused = await call("/api/github/installations/777/link", {
      method: "POST",
      cookie: cookies.alice ?? "",
      json: { org: "acme" },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "SECOND_FACTOR_REQUIRED", org: "acme" });
    expect(count("github_app_link_states")).toBe(0);

    // Away from the org: the installation is only looked at on return, so that
    // is where a session short of the policy is stopped.
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_acme' WHERE installation_id = 777",
      )
      .run();
    expect(await linkAs("alice", github.aliceStillOwner)).toBe("second_factor_required");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });

    // With the factor, the same person does both.
    cookies.alice = await session("usr_alice", "passkey");
    expect(await linkAs("alice", github.aliceStillOwner)).toBe("linked");
    expect(owner()).toEqual({ type: "user", id: "usr_alice" });
    expect(await linkAs("alice", github.aliceStillOwner, 777, "acme")).toBe("linked");
    expect(owner()).toEqual({ type: "org", id: "org_acme" });
  });
});
