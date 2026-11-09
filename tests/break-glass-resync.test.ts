/**
 * Break-glass resync (#418), through the whole Worker.
 *
 * Requests go in through `app.fetch`, queue messages through `app.queue`, and
 * D1 is real SQLite with the production migrations applied. Nothing in git is
 * mocked: the project's repository (behind its Artifacts URL) and the GitHub
 * repositories are real git servers in memory (`helpers/fake-git-server.ts`)
 * behind `globalThis.fetch`, so the clone, the depth-limited fetch, the
 * fast-forward check and the push all run for real. What the tests assert is
 * what ended up in each repository.
 *
 * Two things are replaced: minting the Artifacts token (there is no Artifacts
 * binding to mint one) and the policy loader.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/git-ops", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/git-ops")>()),
  freshRepoToken: vi.fn(async () => ({ success: true, data: "artifacts-token" })),
}));

vi.mock("../src/evaluation/policy-loader", async (importActual) => ({
  ...(await importActual<typeof import("../src/evaluation/policy-loader")>()),
  loadPolicy: vi.fn(async () => ({ evaluators: [] })),
}));

import worker from "../src/index";
import { RepoDO } from "../src/queue/repo-do";
import { createApiToken } from "../src/storage/api-tokens";
import { linkInstallation, upsertInstallation } from "../src/storage/github-installations";
import { issueTokens, registerClient } from "../src/storage/oauth";
import { addOrgMember, createOrg } from "../src/storage/orgs";
import { getPushMirror } from "../src/storage/push-mirrors";
import { createSession } from "../src/storage/sessions";
import { addTeamMember, createTeam } from "../src/storage/teams";
import type { Env, Message, MessageBatch } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { FakeGitRemote } from "./helpers/fake-git-server";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const ORIGIN = "https://stratum.test";
const PROJECT_ID = "proj_acme_app";
const PROJECT_REMOTE = "https://acct.artifacts.cloudflare.net/git/x/acme__app.git";
const MIRROR_REPO = "acme-gh/app-mirror";
const SOURCE_REPO = "acme-gh/app-source";
const INSTALLATION_ID = 77;
const SCOPED_TOKEN = "ghs_scoped_to_one_repo";
const RESYNC = "/api/projects/@acme/app/resync";
const INSIDE_IP = "203.0.113.7";
const OUTSIDE_IP = "198.51.100.9";

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
/** The project's own repository, as Artifacts serves it. */
let project: FakeGitRemote;
/** GitHub repositories, by lower-case `owner/repo`. */
let github: Map<string, FakeGitRemote>;
/** Bodies of the installation-token requests, to check the token is narrowed. */
let tokenRequests: unknown[];
/** When set, the App is installed nowhere. */
let uninstalled: boolean;
let privatePem = "";
let queued: unknown[];
let orgId = "";
const cookies = { admin: "", writer: "", outsider: "" };

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** GitHub's REST API and git endpoints, and the project's Artifacts remote. */
async function fakeNetwork(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers);

  if (url.host === "api.github.com") {
    const installation = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/);
    if (installation) {
      const fullName = `${installation[1]}/${installation[2]}`.toLowerCase();
      return github.has(fullName) && !uninstalled
        ? Response.json({ id: INSTALLATION_ID })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      tokenRequests.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
      return Response.json({
        token: SCOPED_TOKEN,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  }

  const unauthorized = () =>
    new Response("auth required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="git"' },
    });

  if (url.host === "github.com") {
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\.git\//);
    const repo = match ? github.get((match[1] as string).toLowerCase()) : undefined;
    if (!repo) return new Response("not found", { status: 404 });
    // The only credential that opens a GitHub repository is the installation
    // token the App narrowed to it.
    if (headers.get("Authorization") !== `Basic ${btoa(`x-access-token:${SCOPED_TOKEN}`)}`) {
      return unauthorized();
    }
    return repo.serve(url, init);
  }

  if (`${url.origin}${url.pathname}`.startsWith(`${PROJECT_REMOTE}/`)) {
    if (headers.get("Authorization") !== `Basic ${btoa("x:artifacts-token")}`) {
      return unauthorized();
    }
    return project.serve(url, init);
  }
  return new Response("not found", { status: 404 });
}

async function request(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Origin", ORIGIN);
  return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, ctx);
}

function json(
  path: string,
  cookie: string,
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return request(path, cookie, {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function form(path: string, cookie: string, fields: Record<string, string>): Promise<Response> {
  return request(path, cookie, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function bearer(token: string, body?: unknown): Promise<Response> {
  return json(RESYNC, "", "POST", body ?? {}, { Authorization: `Bearer ${token}` });
}

/** Hand every queued mirror message to the Worker's queue handler, in order. */
async function drain(): Promise<void> {
  while (queued.length > 0) {
    const body = queued.shift();
    const message = {
      id: crypto.randomUUID(),
      body,
      attempts: 1,
      timestamp: new Date(),
      ack: () => {},
      retry: () => {},
    } as unknown as Message<unknown>;
    await worker.queue(
      {
        queue: "stratum-mirrors",
        messages: [message],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<unknown>,
      env,
    );
  }
}

async function mirrorRow() {
  const row = await getPushMirror(env.DB, logger, PROJECT_ID);
  if (!row.success || row.data === null) throw new Error("no mirror row");
  return row.data;
}

function rows<T>(sql: string, ...binds: unknown[]): T[] {
  return raw.prepare(sql).all(...binds) as T[];
}

function audit(action: string): { actor_id: string | null; detail: Record<string, unknown> }[] {
  return rows<{ actor_id: string | null; detail: string }>(
    "SELECT actor_id, detail FROM audit_log WHERE action = ? ORDER BY created_at",
    action,
  ).map((row) => ({ actor_id: row.actor_id, detail: JSON.parse(row.detail) }));
}

function resyncEvents(): {
  actor_type: string;
  actor_id: string | null;
  project_id: string | null;
  payload: Record<string, unknown>;
}[] {
  return rows<{
    actor_type: string;
    actor_id: string | null;
    project_id: string | null;
    payload: string;
  }>(
    "SELECT actor_type, actor_id, project_id, payload FROM events WHERE type = 'branch.resynced'",
  ).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

async function session(userId: string, opts: { secondFactor?: "passkey" } = {}): Promise<string> {
  const s = await createSession(env.DB, userId, logger, true, opts);
  if (!s.success) throw s.error;
  return `stratum_session=${s.data.id}`;
}

function mirror(): FakeGitRemote {
  const repo = github.get(MIRROR_REPO);
  if (!repo) throw new Error("no mirror repository");
  return repo;
}

/** Configure the mirror as the org admin and let the first push run. */
async function configureMirror(): Promise<void> {
  const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
    repo: MIRROR_REPO,
  });
  expect(res.status).toBe(200);
  await drain();
  expect(await mirror().repo.tip()).toBe(await project.repo.tip());
  expect(await mirrorRow()).toMatchObject({ state: "ok" });
}

/**
 * The incident this feature exists for: the mirror is in step, then a fix is
 * committed straight to GitHub because Stratum could not merge.
 *
 * @returns The project's tip, and the fix commits on GitHub, oldest first
 */
async function landFixOnMirror(count = 2): Promise<{ before: string; fixes: string[] }> {
  await configureMirror();
  const before = await project.repo.tip();
  const fixes: string[] = [];
  for (let i = 1; i <= count; i++) {
    fixes.push(await mirror().repo.commit(`hotfix ${i}`, "On-call Maintainer"));
  }
  return { before, fixes };
}

async function writeProject(extra: Record<string, unknown> = {}): Promise<void> {
  await env.STATE.put(
    "project:@acme:app",
    JSON.stringify({
      id: PROJECT_ID,
      name: "app",
      slug: "app",
      namespace: "@acme",
      ownerId: orgId,
      ownerType: "org",
      visibility: "private",
      remote: PROJECT_REMOTE,
      createdAt: new Date().toISOString(),
      ...extra,
    }),
  );
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  let binary = "";
  for (const byte of new Uint8Array(der)) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  privatePem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
});

beforeEach(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  queued = [];
  tokenRequests = [];
  uninstalled = false;

  project = new FakeGitRemote();
  await project.init();
  await project.repo.commit("initial");
  await project.repo.commit("second");
  github = new Map();
  for (const name of [MIRROR_REPO, SOURCE_REPO]) {
    const repo = new FakeGitRemote();
    await repo.init();
    github.set(name, repo);
  }

  env = {
    DB: sqlite.db,
    STATE: makeFakeKV(),
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: privatePem,
    ARTIFACTS: {},
    MIRROR_QUEUE: {
      send: async (message: unknown) => {
        queued.push(message);
      },
    },
  } as unknown as Env;

  for (const [id, username] of [
    ["usr_admin", "admin"],
    ["usr_writer", "writer"],
    ["usr_outsider", "outsider"],
    ["usr_solo", "solo"],
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(`legacy-${id}`))
      .run();
  }
  const org = await createOrg(env.DB, logger, "usr_admin", "Acme", "acme");
  if (!org.success) throw new Error("org setup");
  orgId = org.data.id;
  await addOrgMember(env.DB, logger, orgId, "usr_admin", "admin");
  // A writer who is not an admin: a plain member, in a team with write access.
  await addOrgMember(env.DB, logger, orgId, "usr_writer", "member");
  const team = await createTeam(env.DB, logger, orgId, "Devs", "devs", "write");
  if (!team.success) throw new Error("team setup");
  await addTeamMember(env.DB, logger, team.data.id, "usr_writer");

  await writeProject();

  await upsertInstallation(
    env.DB,
    {
      installationId: INSTALLATION_ID,
      accountLogin: "acme-gh",
      accountId: "9001",
      accountType: "Organization",
    },
    logger,
  );
  const linked = await linkInstallation(
    env.DB,
    INSTALLATION_ID,
    { type: "org", id: orgId },
    "usr_admin",
    logger,
  );
  if (!linked.success) throw linked.error;

  cookies.admin = await session("usr_admin");
  cookies.writer = await session("usr_writer");
  cookies.outsider = await session("usr_outsider");

  vi.stubGlobal("fetch", vi.fn(fakeNetwork));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("resyncing from the mirror", () => {
  it("fast-forwards the default branch for an org admin, and says what came in", async () => {
    const { before, fixes } = await landFixOnMirror();
    const [fix1, fix2] = fixes as [string, string];
    tokenRequests.length = 0;

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "fast-forwarded",
      branch: "main",
      source: { kind: "mirror", repo: MIRROR_REPO },
      oldSha: before,
      newSha: fix2,
      commitCount: 2,
      commitsTruncated: false,
      evaluated: false,
    });
    // Newest first, with the summary and the author's name — no e-mail.
    expect(body.commits).toEqual([
      { sha: fix2, summary: "hotfix 2", author: "On-call Maintainer" },
      { sha: fix1, summary: "hotfix 1", author: "On-call Maintainer" },
    ]);
    expect(JSON.stringify(body)).not.toContain("author@example.com");

    // The project's branch really moved, by exactly one fast-forward push.
    expect(await project.repo.tip()).toBe(fix2);
    expect(project.updates).toEqual([{ ref: "refs/heads/main", oldOid: before, newOid: fix2 }]);
    expect(project.overwrites).toEqual([]);
    expect(project.deletions).toEqual([]);

    // GitHub was read with a token narrowed to that repository, read-only.
    expect(tokenRequests).toEqual([
      { repositories: ["app-mirror"], permissions: { contents: "read" } },
    ]);
    // A two-commit fix is settled inside the shallow window on both sides.
    expect(mirror().fetches.every((fetch) => fetch.depth !== null)).toBe(true);
  });

  it("writes the request and the move to the audit log, and emits branch.resynced, with both SHAs and the actor", async () => {
    const { before, fixes } = await landFixOnMirror();
    const after = fixes[1];

    expect((await json(RESYNC, cookies.admin, "POST", {})).status).toBe(200);

    expect(audit("branch.resync_requested")).toEqual([
      {
        actor_id: "usr_admin",
        detail: { project: "app", repo: MIRROR_REPO, source: "mirror" },
      },
    ]);
    const moved = audit("branch.resynced");
    expect(moved).toHaveLength(1);
    expect(moved[0]?.actor_id).toBe("usr_admin");
    expect(moved[0]?.detail).toMatchObject({
      project: "app",
      branch: "main",
      oldSha: before,
      newSha: after,
      repo: MIRROR_REPO,
      source: "mirror",
      commitCount: 2,
      commitsTruncated: false,
      // The record itself says these commits skipped the evaluation gate.
      evaluated: false,
    });
    expect(moved[0]?.detail.commits).toHaveLength(2);
    // Scoped to the project and its org, so the org's audit log shows it.
    expect(
      rows("SELECT org_id, project_id FROM audit_log WHERE action = 'branch.resynced'"),
    ).toEqual([{ org_id: orgId, project_id: PROJECT_ID }]);

    const events = resyncEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: "user",
      actor_id: "usr_admin",
      project_id: PROJECT_ID,
      payload: {
        branch: "main",
        oldSha: before,
        newSha: after,
        repo: MIRROR_REPO,
        source: "mirror",
        commitCount: 2,
        evaluated: false,
      },
    });
    expect(events[0]?.payload.commits).toHaveLength(2);
  });

  it("is a no-op, not a failure, when the project already has everything", async () => {
    await configureMirror();
    const tip = await project.repo.tip();

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "up-to-date",
      branch: "main",
      projectSha: tip,
      upstreamSha: tip,
    });
    expect(project.pushCount()).toBe(0);
    expect(audit("branch.resynced")).toEqual([]);
    expect(resyncEvents()).toEqual([]);
    // The attempt is still on record.
    expect(audit("branch.resync_requested")).toHaveLength(1);
  });

  it("is a no-op when the project is AHEAD of GitHub", async () => {
    await configureMirror();
    const behind = await mirror().repo.tip();
    // A merge landed and the mirror has not been pushed yet.
    const ahead = await project.repo.commit("merged on stratum");

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "up-to-date",
      projectSha: ahead,
      upstreamSha: behind,
    });
    expect(await project.repo.tip()).toBe(ahead);
    expect(project.pushCount()).toBe(0);
  });

  it("refuses a non-fast-forward, names both commits, and moves nothing", async () => {
    await configureMirror();
    const onGitHub = await mirror().repo.commit("hotfix on github");
    const onStratum = await project.repo.commit("merged on stratum");

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body).toMatchObject({
      code: "RESYNC_DIVERGED",
      projectSha: onStratum,
      upstreamSha: onGitHub,
    });
    expect(body.error).toContain("diverged");
    expect(body.error).toContain(onStratum);
    expect(body.error).toContain(onGitHub);

    // Nothing moved, on either side, and nothing was even attempted.
    expect(await project.repo.tip()).toBe(onStratum);
    expect(await mirror().repo.tip()).toBe(onGitHub);
    expect(project.updates).toEqual([]);
    expect(mirror().updates.filter((u) => u.newOid === onStratum)).toEqual([]);
    expect(audit("branch.resynced")).toEqual([]);
    expect(resyncEvents()).toEqual([]);
    // Divergence is only ever concluded from full history.
    expect(mirror().fetches.at(-1)?.depth).toBeNull();
  });

  it("loads full history when the fix is longer than the shallow window, and caps the commit list", async () => {
    const { before, fixes } = await landFixOnMirror(60);
    const after = fixes.at(-1);

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commits: { sha: string }[] };
    expect(body).toMatchObject({
      status: "fast-forwarded",
      oldSha: before,
      newSha: after,
      commitCount: 60,
      commitsTruncated: true,
    });
    expect(body.commits).toHaveLength(50);
    expect(body.commits[0]?.sha).toBe(after);
    expect(await project.repo.tip()).toBe(after);
    // The shallow pass could not see the project's tip from GitHub's; the
    // answer came from the full pass.
    expect(mirror().fetches.map((fetch) => fetch.depth !== null)).toEqual([true, false]);
    expect(audit("branch.resynced")[0]?.detail).toMatchObject({
      commitCount: 60,
      commitsTruncated: true,
    });
  });

  it("settles a small fix on top of a long project history without loading it all", async () => {
    for (let i = 0; i < 60; i++) await project.repo.commit(`history ${i}`);
    const { before, fixes } = await landFixOnMirror();
    project.fetches.length = 0;

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "fast-forwarded",
      oldSha: before,
      newSha: fixes[1],
      commitCount: 2,
    });
    expect(await project.repo.tip()).toBe(fixes[1]);
    expect(project.fetches.every((fetch) => fetch.depth !== null)).toBe(true);
    expect(mirror().fetches.every((fetch) => fetch.depth !== null)).toBe(true);
  });

  it("does not miscount when the fix merges in a commit from past the project's shallow window", async () => {
    const old = await project.repo.tip();
    for (let i = 0; i < 60; i++) await project.repo.commit(`history ${i}`);
    await configureMirror();
    const before = await project.repo.tip();
    const fix = await mirror().repo.commit("hotfix");
    // A merge whose second parent is an old project commit: an ancestor of the
    // project's tip that a 50-commit window cannot see.
    const merge = await mirror().repo.commit("merge old line", "On-call Maintainer", [old]);
    mirror().fetches.length = 0;

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commits: { sha: string }[] };
    expect(body).toMatchObject({
      status: "fast-forwarded",
      oldSha: before,
      newSha: merge,
      // Exactly the two new commits: `old` was already the project's.
      commitCount: 2,
    });
    expect(body.commits.map((commit) => commit.sha).sort()).toEqual([fix, merge].sort());
    // The window could not prove what `old` was, so everything was loaded.
    expect(mirror().fetches.map((fetch) => fetch.depth !== null)).toEqual([true, false]);
    expect(await project.repo.tip()).toBe(merge);
    expect(project.overwrites).toEqual([]);
  });

  it("only fast-forwards to the commit the admin pinned", async () => {
    const { before, fixes } = await landFixOnMirror();
    const [reviewed, after] = fixes as [string, string];

    // GitHub has moved past the commit that was reviewed.
    const stale = await json(RESYNC, cookies.admin, "POST", { expectedSha: reviewed });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "RESYNC_SHA_MISMATCH",
      projectSha: before,
      upstreamSha: after,
    });
    expect(await project.repo.tip()).toBe(before);
    expect(project.pushCount()).toBe(0);

    const malformed = await json(RESYNC, cookies.admin, "POST", { expectedSha: "abc123" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "RESYNC_INVALID_SHA" });

    // Upper case is the same commit.
    const pinned = await json(RESYNC, cookies.admin, "POST", {
      expectedSha: after.toUpperCase(),
    });
    expect(pinned.status).toBe(200);
    expect(await project.repo.tip()).toBe(after);
    expect(audit("branch.resynced")[0]?.detail).toMatchObject({ expectedSha: after });
  });

  it("reports a merge that landed mid-resync instead of overwriting it", async () => {
    const { fixes } = await landFixOnMirror();
    let merged = "";
    // The push is on the wire when a merge moves the project's branch.
    project.beforeReceivePack = async () => {
      project.beforeReceivePack = null;
      merged = await project.repo.commit("merged during the resync");
    };

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RESYNC_PROJECT_MOVED",
      projectSha: merged,
      upstreamSha: fixes[1],
    });
    // The merge survived; the resync's push was refused, not forced.
    expect(await project.repo.tip()).toBe(merged);
    expect(project.overwrites).toEqual([]);
    expect(audit("branch.resynced")).toEqual([]);
    expect(resyncEvents()).toEqual([]);
  });

  it("accepts a request with no body at all", async () => {
    const { fixes } = await landFixOnMirror();
    const res = await request(RESYNC, cookies.admin, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "fast-forwarded", newSha: fixes[1] });
  });
});

describe("who may resync", () => {
  it("refuses a non-admin and a non-member without revealing the project", async () => {
    const { before } = await landFixOnMirror();
    const missing = await json("/api/projects/@acme/nope/resync", cookies.outsider, "POST", {});
    expect(missing.status).toBe(404);

    // Someone with no access gets exactly the answer a missing project gives.
    const outsider = await json(RESYNC, cookies.outsider, "POST", {});
    expect(outsider.status).toBe(404);
    const outsiderBody = JSON.stringify(await outsider.json());
    expect(outsiderBody).toBe(JSON.stringify(await missing.json()).replaceAll("nope", "app"));
    expect(outsiderBody).not.toContain(MIRROR_REPO);

    // A writer can merge here, and still may not resync.
    const writer = await json(RESYNC, cookies.writer, "POST", {});
    expect(writer.status).toBe(403);
    expect(JSON.stringify(await writer.json())).not.toContain(MIRROR_REPO);

    // Signed out.
    expect((await json(RESYNC, "", "POST", {})).status).toBe(401);

    // The form is the same route, with the same answers.
    expect((await form(RESYNC, cookies.outsider, { confirm: MIRROR_REPO })).status).toBe(404);
    expect((await form(RESYNC, cookies.writer, { confirm: MIRROR_REPO })).status).toBe(403);

    expect(await project.repo.tip()).toBe(before);
    expect(project.pushCount()).toBe(0);
    expect(audit("branch.resync_requested")).toEqual([]);
  });

  it("lets the owner of a personal project resync it, and nobody else", async () => {
    await writeProject({ ownerId: "usr_solo", ownerType: "user" });
    // The App installation is linked to the org; link it to the user instead.
    const linked = await linkInstallation(
      env.DB,
      INSTALLATION_ID,
      { type: "user", id: "usr_solo" },
      "usr_solo",
      logger,
    );
    if (!linked.success) throw linked.error;
    const solo = await session("usr_solo");

    const configured = await json("/api/projects/@acme/app/mirror", solo, "PUT", {
      repo: MIRROR_REPO,
    });
    expect(configured.status).toBe(200);
    await drain();
    const fix = await mirror().repo.commit("hotfix");

    // The org admin is nobody to a personal project.
    expect((await json(RESYNC, cookies.admin, "POST", {})).status).toBe(404);

    const res = await json(RESYNC, solo, "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "fast-forwarded", newSha: fix });
    expect(audit("branch.resynced")[0]?.actor_id).toBe("usr_solo");
  });

  it("refuses an OAuth grant, even one held by the admin, and accepts their personal token", async () => {
    const { before, fixes } = await landFixOnMirror();

    const client = await registerClient(env.DB, logger, {
      clientName: "Editor",
      redirectUris: ["http://127.0.0.1:9000/cb"],
    });
    if (!client.success) throw client.error;
    const grant = await issueTokens(env.DB, logger, {
      clientId: client.data.client.id,
      userId: "usr_admin",
      scope: "mcp:read mcp:write",
    });
    if (!grant.success) throw grant.error;

    const delegated = await bearer(grant.data.accessToken);
    expect(delegated.status).toBe(403);
    expect(await delegated.json()).toMatchObject({ code: "ADMIN_REQUIRES_DIRECT_CREDENTIAL" });
    expect(await project.repo.tip()).toBe(before);
    expect(audit("branch.resync_requested")).toEqual([]);

    // A read-only personal token cannot write.
    const readOnly = await createApiToken(env.DB, logger, {
      userId: "usr_admin",
      name: "viewer",
      scope: "read",
    });
    if (!readOnly.success) throw readOnly.error;
    expect((await bearer(readOnly.data.plaintext)).status).toBe(403);
    expect(await project.repo.tip()).toBe(before);

    // A direct credential the admin minted themselves is not delegated.
    const direct = await createApiToken(env.DB, logger, {
      userId: "usr_admin",
      name: "break-glass",
      scope: "read_write",
    });
    if (!direct.success) throw direct.error;
    const res = await bearer(direct.data.plaintext);
    expect(res.status).toBe(200);
    expect(await project.repo.tip()).toBe(fixes[1]);
  });

  it("is not reachable through MCP", async () => {
    const dispatch = await import("../src/mcp/dispatch?raw");
    expect((dispatch as { default: string }).default).not.toContain("resync");
  });

  it("applies the org's second-factor policy", async () => {
    const { before, fixes } = await landFixOnMirror();
    raw.prepare("UPDATE orgs SET require_second_factor = 1 WHERE id = ?").run(orgId);

    // The admin's password-only session no longer administers the org.
    const weak = await json(RESYNC, cookies.admin, "POST", {});
    expect(weak.status).toBe(403);
    expect(await weak.json()).toMatchObject({ code: "SECOND_FACTOR_REQUIRED", org: "acme" });
    expect(await project.repo.tip()).toBe(before);
    expect(project.pushCount()).toBe(0);

    const strong = await session("usr_admin", { secondFactor: "passkey" });
    const res = await json(RESYNC, strong, "POST", {});
    expect(res.status).toBe(200);
    expect(await project.repo.tip()).toBe(fixes[1]);
  });

  it("applies the org's IP allowlist", async () => {
    const { before, fixes } = await landFixOnMirror();
    raw
      .prepare("UPDATE orgs SET ip_allowlist = ? WHERE id = ?")
      .run(JSON.stringify(["203.0.113.0/24"]), orgId);

    const outside = await json(
      RESYNC,
      cookies.admin,
      "POST",
      {},
      { "CF-Connecting-IP": OUTSIDE_IP },
    );
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ code: "IP_NOT_ALLOWED", org: "acme" });
    expect(await project.repo.tip()).toBe(before);
    expect(project.pushCount()).toBe(0);

    const inside = await json(RESYNC, cookies.admin, "POST", {}, { "CF-Connecting-IP": INSIDE_IP });
    expect(inside.status).toBe(200);
    expect(await project.repo.tip()).toBe(fixes[1]);
  });
});

describe("where a resync reads from", () => {
  it("gives a clear error for a project with neither a mirror nor a linked upstream", async () => {
    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body).toMatchObject({ code: "RESYNC_NO_UPSTREAM" });
    expect(body.error).toContain("no push mirror and no linked GitHub repository");
    expect(audit("branch.resync_requested")).toEqual([]);
  });

  it("uses the linked GitHub repository when the project has no mirror", async () => {
    await writeProject({ githubUrl: `https://github.com/${SOURCE_REPO}` });
    const upstream = github.get(SOURCE_REPO) as FakeGitRemote;
    // Same history as the project, then one commit more.
    await upstream.repo.commit("initial");
    await upstream.repo.commit("second");
    expect(await upstream.repo.tip()).toBe(await project.repo.tip());
    const before = await project.repo.tip();
    const fix = await upstream.repo.commit("upstream fix");

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "fast-forwarded",
      source: { kind: "source", repo: SOURCE_REPO },
      oldSha: before,
      newSha: fix,
      mirror: null,
    });
    expect(await project.repo.tip()).toBe(fix);
    expect(tokenRequests.at(-1)).toEqual({
      repositories: ["app-source"],
      permissions: { contents: "read" },
    });
    expect(resyncEvents()[0]?.payload).toMatchObject({ source: "source", repo: SOURCE_REPO });
  });

  it("prefers the mirror over the linked source, and takes no repository from the request", async () => {
    await writeProject({ githubUrl: `https://github.com/${SOURCE_REPO}` });
    const { fixes } = await landFixOnMirror();
    const elsewhere = github.get(SOURCE_REPO) as FakeGitRemote;

    const res = await json(RESYNC, cookies.admin, "POST", {
      repo: SOURCE_REPO,
      source: SOURCE_REPO,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      source: { kind: "mirror", repo: MIRROR_REPO },
      newSha: fixes[1],
    });
    expect(elsewhere.requests).toEqual([]);
  });

  it("explains itself when the App is not installed on the repository", async () => {
    await writeProject({ githubUrl: `https://github.com/${SOURCE_REPO}` });
    uninstalled = true;
    const before = await project.repo.tip();

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "GITHUB_APP_NOT_INSTALLED" });
    expect(await project.repo.tip()).toBe(before);

    const viaForm = await form(RESYNC, cookies.admin, { confirm: SOURCE_REPO });
    expect(viaForm.headers.get("Location")).toBe("/@acme/app/settings?resync=not-installed#resync");
  });

  it("explains itself when GitHub is down or the branch is missing", async () => {
    const { before } = await landFixOnMirror();

    mirror().down = 503;
    const down = await json(RESYNC, cookies.admin, "POST", {});
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ code: "RESYNC_UPSTREAM_UNAVAILABLE" });
    mirror().down = null;

    const emptied = new FakeGitRemote();
    await emptied.init();
    github.set(MIRROR_REPO, emptied);
    const noBranch = await json(RESYNC, cookies.admin, "POST", {});
    expect(noBranch.status).toBe(409);
    expect(await noBranch.json()).toMatchObject({
      code: "RESYNC_UPSTREAM_BRANCH_MISSING",
      projectSha: before,
    });

    expect(await project.repo.tip()).toBe(before);
    expect(project.pushCount()).toBe(0);
  });

  it("does not populate an empty project", async () => {
    const upstream = github.get(SOURCE_REPO) as FakeGitRemote;
    const tip = await upstream.repo.commit("initial");
    await writeProject({ githubUrl: `https://github.com/${SOURCE_REPO}` });
    project = new FakeGitRemote();
    await project.init();

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RESYNC_PROJECT_BRANCH_MISSING",
      upstreamSha: tip,
    });
    expect(project.pushCount()).toBe(0);
  });
});

describe("the mirror afterwards", () => {
  it("leaves a healthy mirror ok at the new tip, without pushing anything to GitHub", async () => {
    const { fixes } = await landFixOnMirror();
    const pushesBefore = mirror().pushCount();

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mirror: unknown }).mirror).toMatchObject({
      repo: MIRROR_REPO,
      pending: true,
    });
    await drain();

    expect(await mirrorRow()).toMatchObject({ state: "ok", lastPushedSha: fixes[1] });
    // The two already agree, so the queued run had nothing to send.
    expect(mirror().pushCount()).toBe(pushesBefore);
    expect(mirror().overwrites).toEqual([]);
    expect(audit("mirror.resumed")).toEqual([]);
  });

  it("brings a mirror that diverged because the fix landed there first back to ok, without a force", async () => {
    const { fixes } = await landFixOnMirror();
    // A push ran while GitHub was ahead: the mirror saw history the project
    // did not have and stopped.
    await json("/api/projects/@acme/app/mirror/resume", cookies.admin, "POST");
    await drain();
    expect(await mirrorRow()).toMatchObject({ state: "diverged" });
    const pushesBefore = mirror().pushCount();

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "fast-forwarded",
      mirror: { state: "idle", pending: true, lastError: null },
    });
    await drain();

    expect(await mirrorRow()).toMatchObject({ state: "ok", lastPushedSha: fixes[1] });
    expect(await mirror().repo.tip()).toBe(fixes[1]);
    expect(mirror().pushCount()).toBe(pushesBefore);
    expect(mirror().overwrites).toEqual([]);
    expect(mirror().deletions).toEqual([]);
    // Resuming is on the record as part of the resync, with who did it.
    expect(audit("mirror.resumed").at(-1)).toEqual({
      actor_id: "usr_admin",
      detail: { project: "app", repo: MIRROR_REPO, previousState: "diverged", via: "resync" },
    });
  });

  it("leaves a diverged mirror diverged when the resync is refused", async () => {
    await configureMirror();
    await mirror().repo.commit("hotfix on github");
    await project.repo.commit("merged on stratum");
    await json("/api/projects/@acme/app/mirror/resume", cookies.admin, "POST");
    await drain();
    expect(await mirrorRow()).toMatchObject({ state: "diverged" });

    expect((await json(RESYNC, cookies.admin, "POST", {})).status).toBe(409);
    await drain();
    expect(await mirrorRow()).toMatchObject({ state: "diverged" });
    expect(mirror().overwrites).toEqual([]);
  });

  it("still resyncs from a mirror that was disabled during the incident, and pushes nothing", async () => {
    const { fixes } = await landFixOnMirror();
    const disabled = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
      repo: MIRROR_REPO,
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    const pushesBefore = mirror().pushCount();

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "fast-forwarded",
      source: { kind: "mirror", repo: MIRROR_REPO },
      mirror: { enabled: false },
    });
    await drain();
    expect(await project.repo.tip()).toBe(fixes[1]);
    expect(mirror().pushCount()).toBe(pushesBefore);
  });
});

describe("the read-only mirror rule is otherwise intact", () => {
  it("still refuses sync-from-source and PR promotion, before and after a resync", async () => {
    await writeProject({ githubUrl: `https://github.com/${SOURCE_REPO}` });
    await landFixOnMirror();

    const refused = async () => {
      const sync = await json("/api/projects/@acme/app/sync", cookies.admin, "POST", {});
      expect(sync.status).toBe(409);
      expect(await sync.json()).toMatchObject({ code: "PUSH_MIRROR_ENABLED" });
      const promote = await json("/api/changes/chg_promote/github-pr", cookies.admin, "POST", {});
      expect(promote.status).toBe(409);
      expect(await promote.json()).toMatchObject({ code: "PUSH_MIRROR_ENABLED" });
    };
    raw
      .prepare(
        "INSERT INTO changes (id, project, project_id, workspace, status) VALUES ('chg_promote', '@acme/app', ?, 'ws', 'accepted')",
      )
      .run(PROJECT_ID);

    await refused();
    expect((await json(RESYNC, cookies.admin, "POST", {})).status).toBe(200);
    await refused();
  });
});

describe("with the RepoDO enabled", () => {
  /** A namespace whose one object is a real RepoDO, and a log of how it was entered. */
  function enableRepoDo(): { gated: string[]; store: Map<string, unknown>; names: string[] } {
    const store = new Map<string, unknown>();
    const gated: string[] = [];
    const names: string[] = [];
    const doCtx = {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        sql: { exec: () => ({ toArray: () => [] }) },
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => {
        gated.push("enter");
        const pushesBefore = project.pushCount();
        const result = await fn();
        gated.push(project.pushCount() > pushesBefore ? "pushed" : "no-push");
        return result;
      },
    } as unknown as DurableObjectState;
    const instance = new RepoDO(doCtx, env);
    env.REPO_DO_ENABLED = "true";
    env.REPO_DO = {
      idFromName: (name: string) => {
        names.push(name);
        return name;
      },
      get: () => instance,
    } as unknown as DurableObjectNamespace;
    return { gated, store, names };
  }

  it("moves the branch inside the object's gate and refreshes its cached head", async () => {
    const { fixes } = await landFixOnMirror();
    const repoDo = enableRepoDo();
    repoDo.store.set("head", "stale-head-from-before-the-incident");

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "fast-forwarded", newSha: fixes[1] });

    // Keyed like merges are, so it is the same object a merge would enter.
    expect(repoDo.names).toEqual([PROJECT_ID]);
    // The push — and only the push — ran behind the gate merges take.
    expect(repoDo.gated).toEqual(["enter", "pushed"]);
    expect(repoDo.store.get("head")).toBe(fixes[1]);
    expect(await project.repo.tip()).toBe(fixes[1]);
    expect(audit("branch.resynced")).toHaveLength(1);
  });

  it("does not touch the cached head when the push is refused", async () => {
    await landFixOnMirror();
    const repoDo = enableRepoDo();
    repoDo.store.set("head", "cached");
    project.rejectWith = "pre-receive hook declined";

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "RESYNC_PUSH_REJECTED" });
    expect(repoDo.store.get("head")).toBe("cached");
  });

  it("reports an unknown outcome when the object dies", async () => {
    const { before } = await landFixOnMirror();
    env.REPO_DO_ENABLED = "true";
    env.REPO_DO = {
      idFromName: (name: string) => name,
      get: () => ({
        resync: async () => {
          throw new Error("Durable Object reset");
        },
      }),
    } as unknown as DurableObjectNamespace;

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "RESYNC_FAILED" });
    expect(await project.repo.tip()).toBe(before);
    // The attempt is on record even though nothing reported back.
    expect(audit("branch.resync_requested")).toHaveLength(1);
  });

  it("runs inline, without the object, when the kill switch is off", async () => {
    const { fixes } = await landFixOnMirror();
    const repoDo = enableRepoDo();
    env.REPO_DO_ENABLED = "false";

    const res = await json(RESYNC, cookies.admin, "POST", {});
    expect(res.status).toBe(200);
    expect(repoDo.names).toEqual([]);
    expect(repoDo.gated).toEqual([]);
    expect(await project.repo.tip()).toBe(fixes[1]);
  });
});

describe("the settings page", () => {
  it("offers the resync to admins only, with a typed confirmation and no script", async () => {
    await landFixOnMirror();

    const page = await request("/@acme/app/settings", cookies.admin);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="resync"');
    expect(html).toContain("Break-glass: resync from GitHub");
    expect(html).toContain('action="/api/projects/@acme/app/resync"');
    expect(html).toContain('name="confirm"');
    expect(html).toContain('name="expected_sha"');
    expect(html).toContain("not evaluated");
    const card = html.slice(html.indexOf('id="resync"'), html.indexOf('id="resync"') + 4000);
    expect(card).not.toContain("<script");
    expect(card).not.toContain("onclick");

    const writerPage = await request("/@acme/app/settings", cookies.writer);
    expect(writerPage.status).toBe(200);
    expect(await writerPage.text()).not.toContain('id="resync"');
  });

  it("says there is nothing to resync from when the project has no upstream", async () => {
    const page = await request("/@acme/app/settings", cookies.admin);
    const html = await page.text();
    expect(html).toContain('id="resync"');
    expect(html).toContain("nothing to resync from");
    expect(html).not.toContain('action="/api/projects/@acme/app/resync"');
  });

  it("does nothing until the repository is typed out, then resyncs and reports both commits", async () => {
    const { before, fixes } = await landFixOnMirror();
    const after = fixes[1] as string;

    for (const fields of [{}, { confirm: "" }, { confirm: "acme-gh/other" }, { confirm: "yes" }]) {
      const res = await form(RESYNC, cookies.admin, fields as Record<string, string>);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/@acme/app/settings?resync=confirm#resync");
    }
    expect(await project.repo.tip()).toBe(before);
    expect(audit("branch.resync_requested")).toEqual([]);

    const badSha = await form(RESYNC, cookies.admin, { confirm: MIRROR_REPO, expected_sha: "zz" });
    expect(badSha.headers.get("Location")).toBe("/@acme/app/settings?resync=invalid-sha#resync");
    expect(await project.repo.tip()).toBe(before);

    const res = await form(RESYNC, cookies.admin, { confirm: MIRROR_REPO, expected_sha: "" });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toBe(`/@acme/app/settings?resync=done&from=${before}&to=${after}#resync`);
    expect(await project.repo.tip()).toBe(after);

    const html = await (await request(location.replace("#resync", ""), cookies.admin)).text();
    expect(html).toContain("Fast-forwarded.");
    expect(html).toContain(before);
    expect(html).toContain(after);

    const again = await form(RESYNC, cookies.admin, { confirm: MIRROR_REPO });
    expect(again.headers.get("Location")).toBe(
      `/@acme/app/settings?resync=up-to-date&from=${after}&to=${after}#resync`,
    );
  });

  it("redirects a refused form post with both commits, and never echoes anything else", async () => {
    await configureMirror();
    const onGitHub = await mirror().repo.commit("hotfix on github");
    const onStratum = await project.repo.commit("merged on stratum");

    const res = await form(RESYNC, cookies.admin, { confirm: MIRROR_REPO });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/@acme/app/settings?resync=diverged&from=${onStratum}&to=${onGitHub}#resync`,
    );

    const html = await (
      await request(
        `/@acme/app/settings?resync=diverged&from=${onStratum}&to=${onGitHub}`,
        cookies.admin,
      )
    ).text();
    expect(html).toContain("have diverged");
    expect(html).toContain(onStratum);
    expect(html).toContain(onGitHub);

    // Only a known code and well-formed SHAs are ever rendered.
    const forged = await (
      await request(
        "/@acme/app/settings?resync=<b>pwned</b>&from=<i>x</i>&to=not-a-sha",
        cookies.admin,
      )
    ).text();
    expect(forged).not.toContain("pwned");
    expect(forged).not.toContain("<i>x</i>");
    const halfForged = await (
      await request("/@acme/app/settings?resync=done&from=EVIL&to=EVIL", cookies.admin)
    ).text();
    expect(halfForged).toContain("Fast-forwarded.");
    expect(halfForged).not.toContain("EVIL");
  });
});
