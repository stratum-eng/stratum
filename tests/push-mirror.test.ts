/**
 * Push mirror (#417), through the whole Worker.
 *
 * Requests go in through `app.fetch`, queue messages through `app.queue`, and
 * D1 is real SQLite with the production migrations applied. Two things are
 * replaced, at the boundaries where the process would otherwise reach the
 * network:
 *
 * - **GitHub is a fake behind `globalThis.fetch`.** It speaks enough of the
 *   REST API to hand out an App installation token and enough smart-HTTP git to
 *   advertise refs and accept a push. It keeps a real git object store, so what
 *   the tests assert is what actually arrived: which ref, at which commit. It
 *   accepts a non-fast-forward or a deletion exactly as GitHub would — and
 *   records it — so "nothing was overwritten" is an observation about what the
 *   mirror sent, not about what the fake refused.
 * - **The project's own repository** is a real isomorphic-git repo in memory.
 *   The four git-ops functions that would read it from Artifacts are pointed at
 *   it; everything they return is genuine git data.
 *
 * The push itself — isomorphic-git's ref discovery, its fast-forward check, its
 * pack, the report-status parse — runs for real against the fake.
 */
import git from "isomorphic-git";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  readAdvertisedRefs: null as null | (() => Promise<unknown>),
  cloneRepo: null as null | ((opts: { fullHistory?: boolean }) => Promise<unknown>),
}));

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "artifacts-token" })),
    readAdvertisedRefs: vi.fn(async () => harness.readAdvertisedRefs?.()),
    cloneRepo: vi.fn(async (_remote: string, _token: string, _logger: unknown, opts: object) =>
      harness.cloneRepo?.(opts),
    ),
    // Every tag is already in the in-memory repo the fake clone hands back.
    fetchRemoteTag: vi.fn(async () => ({})),
  };
});

vi.mock("../src/evaluation/policy-loader", async (importActual) => ({
  ...(await importActual<typeof import("../src/evaluation/policy-loader")>()),
  loadPolicy: vi.fn(async () => ({ evaluators: [] })),
}));

import {
  MIRROR_MAX_ATTEMPTS,
  mirrorBackoffSeconds,
  requestPushMirror,
  sweepPushMirrors,
} from "../src/github/mirror";
import { parseGitHubRepo } from "../src/github/remote";
import { ensureCanonicalProject } from "../src/github/repo-authorization";
import worker from "../src/index";
import { syncAllProjects } from "../src/routes/sync";
import { linkInstallation, upsertInstallation } from "../src/storage/github-installations";
import { MemoryFS } from "../src/storage/memory-fs";
import { addOrgMember, createOrg } from "../src/storage/orgs";
import { getPushMirror } from "../src/storage/push-mirrors";
import { createSession } from "../src/storage/sessions";
import { addTeamMember, createTeam } from "../src/storage/teams";
import type { Env, Message, MessageBatch } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import {
  ZERO_OID,
  buildReportStatus,
  encodePktLine,
  parseReceivePackRequest,
} from "../src/utils/git-protocol";
import type { Logger } from "../src/utils/logger";
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
const MIRROR_REPO = "acme-gh/app-mirror";
const INSTALLATION_ID = 77;
const SCOPED_TOKEN = "ghs_scoped_to_one_repo";

type GitFs = Parameters<typeof git.init>[0]["fs"];
const author = { name: "t", email: "t@example.com", timestamp: 1_700_000_000, timezoneOffset: 0 };

// ---------------------------------------------------------------------------
// A real git repository in memory
// ---------------------------------------------------------------------------

class Repo {
  readonly fs: GitFs = new MemoryFS().toNodeFS() as unknown as GitFs;
  readonly dir = "/";
  private n = 0;

  async init(): Promise<void> {
    await git.init({ fs: this.fs, dir: this.dir, defaultBranch: "main" });
  }

  /** Adds a commit on `main` and returns its sha. */
  async commit(message = "commit"): Promise<string> {
    const path = `file-${this.n++}.txt`;
    await (
      this.fs as unknown as { promises: { writeFile(p: string, d: string): Promise<void> } }
    ).promises.writeFile(`/${path}`, `${message} ${this.n}`);
    await git.add({ fs: this.fs, dir: this.dir, filepath: path });
    return git.commit({
      fs: this.fs,
      dir: this.dir,
      message,
      author: { ...author, timestamp: author.timestamp + this.n },
    });
  }

  async ref(ref: string): Promise<string | undefined> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
    } catch {
      return undefined;
    }
  }

  async refs(prefix: "refs/heads" | "refs/tags"): Promise<Record<string, string>> {
    const names =
      prefix === "refs/heads"
        ? await git.listBranches({ fs: this.fs, dir: this.dir })
        : await git.listTags({ fs: this.fs, dir: this.dir });
    const out: Record<string, string> = {};
    for (const name of names) {
      const oid = await this.ref(`${prefix}/${name}`);
      if (oid !== undefined) out[name] = oid;
    }
    return out;
  }

  async setRef(ref: string, oid: string): Promise<void> {
    await git.writeRef({ fs: this.fs, dir: this.dir, ref, value: oid, force: true });
  }

  async has(oid: string): Promise<boolean> {
    try {
      await git.readObject({ fs: this.fs, dir: this.dir, oid, format: "deflated" });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// The fake GitHub
// ---------------------------------------------------------------------------

interface RefUpdate {
  ref: string;
  oldOid: string;
  newOid: string;
}

class FakeGitHub {
  repo = new Repo();
  /** Every ref update a push asked for, accepted or not, in order. */
  updates: RefUpdate[] = [];
  /** Updates that were not fast-forwards. The mirror must never send one. */
  overwrites: RefUpdate[] = [];
  /** Ref deletions. The mirror must never send one. */
  deletions: RefUpdate[] = [];
  /** Bodies of the installation-token requests, to check the token is narrowed. */
  tokenRequests: unknown[] = [];
  /** Requests seen, as `METHOD url`. */
  requests: string[] = [];
  /** Answer this many receive-pack POSTs with HTTP 500 before behaving. */
  failPushes = 0;
  /** When set, the App is not installed on the mirror repository. */
  uninstalled = false;
  /** When set, every receive-pack POST waits on this before answering. */
  gate: Promise<void> | null = null;
  /** Permissions the App installation was granted. */
  granted = new Set(["contents", "workflows"]);
  /** When set, every ref in a push is refused with this reason. */
  rejectWith: string | null = null;

  async init(): Promise<void> {
    await this.repo.init();
  }

  private advertisement(service: string, refs: Record<string, string>): Response {
    const caps =
      service === "git-receive-pack" ? "report-status side-band-64k delete-refs" : "side-band-64k";
    const lines: Uint8Array[] = [encodePktLine(`# service=${service}\n`), flush()];
    const entries = Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : 1));
    entries.forEach(([name, oid], index) => {
      lines.push(encodePktLine(index === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
    });
    lines.push(flush());
    return new Response(concat(lines), {
      status: 200,
      headers: { "Content-Type": `application/x-${service}-advertisement` },
    });
  }

  private async allRefs(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, oid] of Object.entries(await this.repo.refs("refs/heads"))) {
      out[`refs/heads/${name}`] = oid;
    }
    for (const [name, oid] of Object.entries(await this.repo.refs("refs/tags"))) {
      out[`refs/tags/${name}`] = oid;
    }
    return out;
  }

  private async receivePack(body: Uint8Array): Promise<Response> {
    const parsed = parseReceivePackRequest(body);
    if (!parsed.success) return new Response("bad request", { status: 400 });

    const packAt = indexOf(body, new TextEncoder().encode("PACK"));
    if (packAt >= 0) {
      const pack = body.subarray(packAt);
      const count = new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
      if (count > 0) {
        const name = `objects/pack/pack-${crypto.randomUUID().replace(/-/g, "")}.pack`;
        const promises = (
          this.repo.fs as unknown as {
            promises: {
              mkdir(p: string, o?: object): Promise<void>;
              writeFile(p: string, d: Uint8Array): Promise<void>;
            };
          }
        ).promises;
        await promises.mkdir("/.git/objects/pack", { recursive: true }).catch(() => {});
        await promises.writeFile(`/.git/${name}`, pack);
        await git.indexPack({ fs: this.repo.fs, dir: "/", filepath: `.git/${name}` });
      }
    }

    const results: { ref: string; ok: boolean; reason?: string }[] = [];
    for (const command of parsed.data.commands) {
      if (this.rejectWith !== null) {
        results.push({ ref: command.ref, ok: false, reason: this.rejectWith });
        continue;
      }
      this.updates.push(command);
      const current = (await this.repo.ref(command.ref)) ?? ZERO_OID;
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: "stale info" });
        continue;
      }
      if (command.newOid === ZERO_OID) {
        this.deletions.push(command);
        results.push({ ref: command.ref, ok: true });
        continue;
      }
      // Like GitHub with no branch protection: a non-fast-forward is accepted.
      // It is only recorded, so a test can prove none was ever sent.
      if (current !== ZERO_OID) {
        const fastForward = await git
          .isDescendent({
            fs: this.repo.fs,
            dir: "/",
            oid: command.newOid,
            ancestor: current,
            depth: -1,
          })
          .catch(() => false);
        if (!fastForward) this.overwrites.push(command);
      }
      await this.repo.setRef(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
    }
    return new Response(buildReportStatus({ unpack: "ok", results, sideband: true }), {
      status: 200,
      headers: { "Content-Type": "application/x-git-receive-pack-result" },
    });
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    this.requests.push(`${method} ${url.origin}${url.pathname}${url.search}`);

    if (url.host === "api.github.com") {
      const installation = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/);
      if (installation) {
        const fullName = `${installation[1]}/${installation[2]}`;
        return fullName.toLowerCase() === MIRROR_REPO && !this.uninstalled
          ? Response.json({ id: INSTALLATION_ID })
          : Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        this.tokenRequests.push(body);
        const asked = Object.keys((body as { permissions?: object } | null)?.permissions ?? {});
        if (!asked.every((permission) => this.granted.has(permission))) {
          return Response.json(
            { message: "The permissions requested are not granted to this installation." },
            { status: 422 },
          );
        }
        return Response.json({
          token: SCOPED_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }

    if (
      url.host === "github.com" &&
      url.pathname.toLowerCase().startsWith(`/${MIRROR_REPO}.git/`)
    ) {
      // Git over HTTP authenticates with Basic; the only credential that works
      // is the installation token narrowed to this repository.
      if (headers.get("Authorization") !== `Basic ${btoa(`x-access-token:${SCOPED_TOKEN}`)}`) {
        return new Response("auth required", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="GitHub"' },
        });
      }
      if (url.pathname.endsWith("/info/refs")) {
        return this.advertisement(url.searchParams.get("service") ?? "", await this.allRefs());
      }
      if (url.pathname.endsWith("/git-receive-pack") && method === "POST") {
        if (this.failPushes > 0) {
          this.failPushes--;
          return new Response("upstream on fire", { status: 500 });
        }
        if (this.gate) await this.gate;
        return this.receivePack(new Uint8Array(init?.body as ArrayBuffer));
      }
    }
    return new Response("not found", { status: 404 });
  }

  pushCount(): number {
    return this.requests.filter((r) => r.startsWith("POST") && r.includes("git-receive-pack"))
      .length;
  }
}

const flush = () => new TextEncoder().encode("0000");

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Worker environment
// ---------------------------------------------------------------------------

interface Delivered {
  body: unknown;
  acked: boolean;
  retried?: { delaySeconds?: number };
}

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let source: Repo;
let github: FakeGitHub;
let privatePem = "";
/** Messages waiting on the mirror queue. */
let queued: unknown[];
/** When set, `MIRROR_QUEUE.send` rejects. */
let queueDown: boolean;
const cookies = { admin: "", writer: "", outsider: "" };
let cloneCalls: { fullHistory?: boolean }[];
/** Make non-full clones look shallow at the tip, as a depth-limited clone is. */
let simulateShallow: boolean;
let changeSeq = 0;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

async function request(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Origin", ORIGIN);
  return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, ctx);
}

function json(path: string, cookie: string, method: string, body?: unknown): Promise<Response> {
  return request(path, cookie, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Hand every queued mirror message to the Worker's queue handler, in order. */
async function drain(): Promise<Delivered[]> {
  const delivered: Delivered[] = [];
  while (queued.length > 0) {
    const body = queued.shift();
    delivered.push(await deliver(body));
  }
  return delivered;
}

async function deliver(body: unknown): Promise<Delivered> {
  const record: Delivered = { body, acked: false };
  const message = {
    id: crypto.randomUUID(),
    body,
    attempts: 1,
    timestamp: new Date(),
    ack: () => {
      record.acked = true;
    },
    retry: (opts?: { delaySeconds?: number }) => {
      record.retried = opts ?? {};
    },
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
  return record;
}

async function mirrorRow() {
  const row = await getPushMirror(env.DB, logger, PROJECT_ID);
  if (!row.success || row.data === null) throw new Error("no mirror row");
  return row.data;
}

function rows<T>(sql: string, ...binds: unknown[]): T[] {
  return raw.prepare(sql).all(...binds) as T[];
}

/** Configure the mirror as the org admin and let the first push run. */
async function configureMirror(): Promise<void> {
  const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
    repo: MIRROR_REPO,
  });
  expect(res.status).toBe(200);
  await drain();
}

/**
 * Merge a change through `POST /api/changes/:id/merge`. The merge queue stub
 * lands a real commit on the project's repository, which is what a merge is as
 * far as the mirror can tell.
 */
async function merge(): Promise<{ res: Response; sha: string }> {
  const id = `chg_mirror_${++changeSeq}`;
  raw
    .prepare(
      "INSERT INTO changes (id, project, project_id, workspace, status) VALUES (?, ?, ?, ?, 'accepted')",
    )
    .run(id, "@acme/app", PROJECT_ID, `ws-${changeSeq}`);
  const res = await request(`/api/changes/${id}/merge`, cookies.admin, { method: "POST" });
  const sha = (await source.ref("refs/heads/main")) ?? "";
  return { res, sha };
}

async function session(userId: string): Promise<string> {
  const s = await createSession(env.DB, userId, logger, true, {});
  if (!s.success) throw s.error;
  return `stratum_session=${s.data.id}`;
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
  queueDown = false;
  cloneCalls = [];
  simulateShallow = false;

  source = new Repo();
  await source.init();
  await source.commit("initial");
  github = new FakeGitHub();
  await github.init();

  env = {
    DB: sqlite.db,
    STATE: makeFakeKV(),
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: privatePem,
    ARTIFACTS: {},
    MIRROR_QUEUE: {
      send: async (message: unknown) => {
        if (queueDown) throw new Error("queue unavailable");
        queued.push(message);
      },
    },
    // The route takes this path for a plain merge. A real merge queue pushes
    // the merged commit to the project's repository and marks the change.
    MERGE_QUEUE: {
      idFromName: (name: string) => name,
      get: () => ({
        merge: async (changeId: string) => {
          const commit = await source.commit(`merge ${changeId}`);
          raw
            .prepare("UPDATE changes SET status = 'merged', merged_at = ? WHERE id = ?")
            .run(new Date().toISOString(), changeId);
          return { success: true, transitioned: true, commit };
        },
      }),
    },
  } as unknown as Env;

  for (const [id, username] of [
    ["usr_admin", "admin"],
    ["usr_writer", "writer"],
    ["usr_outsider", "outsider"],
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(`legacy-${id}`))
      .run();
  }
  const org = await createOrg(env.DB, logger, "usr_admin", "Acme", "acme");
  if (!org.success) throw new Error("org setup");
  await addOrgMember(env.DB, logger, org.data.id, "usr_admin", "admin");
  // A writer who is not an admin: a plain member, in a team with write access.
  await addOrgMember(env.DB, logger, org.data.id, "usr_writer", "member");
  const team = await createTeam(env.DB, logger, org.data.id, "Devs", "devs", "write");
  if (!team.success) throw new Error("team setup");
  await addTeamMember(env.DB, logger, team.data.id, "usr_writer");

  await env.STATE.put(
    "project:@acme:app",
    JSON.stringify({
      id: PROJECT_ID,
      name: "app",
      slug: "app",
      namespace: "@acme",
      ownerId: org.data.id,
      ownerType: "org",
      visibility: "private",
      remote: "https://acct.artifacts.cloudflare.net/git/x/acme__app.git",
      createdAt: new Date().toISOString(),
    }),
  );

  // The GitHub App is installed on the mirror's account and linked to the org.
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
    { type: "org", id: org.data.id },
    "usr_admin",
    logger,
  );
  if (!linked.success) throw linked.error;

  cookies.admin = await session("usr_admin");
  cookies.writer = await session("usr_writer");
  cookies.outsider = await session("usr_outsider");

  harness.readAdvertisedRefs = async () => ({
    success: true,
    data: {
      branches: await source.refs("refs/heads"),
      tags: await source.refs("refs/tags"),
      peeledTags: {},
    },
  });
  harness.cloneRepo = async (opts) => {
    cloneCalls.push({ fullHistory: opts.fullHistory === true });
    const promises = (
      source.fs as unknown as {
        promises: {
          writeFile(p: string, d: string): Promise<void>;
          unlink(p: string): Promise<void>;
        };
      }
    ).promises;
    if (simulateShallow && opts.fullHistory !== true) {
      await promises.writeFile("/.git/shallow", `${await source.ref("refs/heads/main")}\n`);
    } else {
      await promises.unlink("/.git/shallow").catch(() => {});
    }
    return { success: true, data: { fs: source.fs, dir: "/" } };
  };

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => github.handle(input, init)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("configuring a mirror", () => {
  it("lets a project admin set it, with a token narrowed to the mirror repository", async () => {
    const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
      repo: MIRROR_REPO,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mirror: Record<string, unknown> };
    expect(body.mirror).toMatchObject({
      repo: MIRROR_REPO,
      url: `https://github.com/${MIRROR_REPO}`,
      enabled: true,
      pending: true,
    });

    // The credential is the App's, for this one repository, to write contents.
    expect(github.tokenRequests).toEqual([
      {
        repositories: ["app-mirror"],
        permissions: { contents: "write", workflows: "write" },
      },
    ]);
    // A narrowed token must never land in the installation-wide token cache.
    const cache = (env.STATE as unknown as { store: Map<string, string> }).store;
    expect([...cache.keys()].some((key) => key.startsWith("github_inst_token:"))).toBe(false);

    expect(
      rows("SELECT action, actor_id FROM audit_log WHERE action = 'mirror.configured'"),
    ).toEqual([{ action: "mirror.configured", actor_id: "usr_admin" }]);
    // Saving asks for the first push.
    expect(queued).toEqual([{ type: "mirror.push", projectId: PROJECT_ID }]);
  });

  it("refuses everyone who is not an admin of the project", async () => {
    const attempt = (cookie: string) =>
      json("/api/projects/@acme/app/mirror", cookie, "PUT", { repo: MIRROR_REPO });

    // Signed out.
    expect((await attempt("")).status).toBe(401);
    // Someone with no access gets the same answer as a missing project.
    expect((await attempt(cookies.outsider)).status).toBe(404);
    // A writer can merge here, and still may not decide where it is published.
    expect((await attempt(cookies.writer)).status).toBe(403);

    for (const cookie of [cookies.outsider, cookies.writer]) {
      expect((await request("/api/projects/@acme/app/mirror", cookie)).status).not.toBe(200);
      expect((await json("/api/projects/@acme/app/mirror/resume", cookie, "POST")).status).not.toBe(
        202,
      );
      expect((await json("/api/projects/@acme/app/mirror", cookie, "DELETE")).status).not.toBe(200);
    }

    expect(rows("SELECT * FROM push_mirrors")).toEqual([]);
    expect(queued).toEqual([]);
    expect(github.tokenRequests).toEqual([]);
  });

  it("keeps the repository name as typed, and treats another casing as the same target", async () => {
    const typed = "Acme-GH/App-Mirror";
    const first = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
      repo: typed,
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { mirror: { repo: string } }).mirror.repo).toBe(typed);
    // GitHub's API is given the name verbatim.
    expect(github.tokenRequests[0]).toMatchObject({ repositories: ["App-Mirror"] });
    await drain();
    const pushed = (await mirrorRow()).lastPushedSha;
    expect(pushed).toBe(await source.ref("refs/heads/main"));

    // Saving it again in lower case is not a new target: the status survives.
    const again = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
      repo: MIRROR_REPO,
    });
    expect(again.status).toBe(200);
    expect(await mirrorRow()).toMatchObject({ repoName: "app-mirror", lastPushedSha: pushed });
  });

  it("starts over when the mirror is pointed at a different repository", async () => {
    await configureMirror();
    raw
      .prepare("UPDATE push_mirrors SET state = 'diverged', last_error = 'x' WHERE project_id = ?")
      .run(PROJECT_ID);

    // Re-saving the same target does not clear a divergence...
    await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", { repo: MIRROR_REPO });
    expect(await mirrorRow()).toMatchObject({ state: "diverged" });

    // ...but the old target's status says nothing about a new one.
    raw
      .prepare("UPDATE push_mirrors SET repo_name = 'old-mirror' WHERE project_id = ?")
      .run(PROJECT_ID);
    await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", { repo: MIRROR_REPO });
    const mirror = await mirrorRow();
    expect(mirror.lastError).toBeUndefined();
    expect(mirror.state).not.toBe("diverged");
  });

  it("refuses a target that is not a plain owner/repo", async () => {
    for (const repo of ["", "acme-gh", "acme-gh/a/b", "https://evil.test/acme-gh/app", "../x/y"]) {
      const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", { repo });
      expect(res.status).toBe(400);
    }
    expect(rows("SELECT * FROM push_mirrors")).toEqual([]);
  });

  it("saves nothing when the GitHub App is not installed on the target", async () => {
    const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
      repo: "acme-gh/somewhere-else",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "not-installed" });
    expect(rows("SELECT * FROM push_mirrors")).toEqual([]);
  });

  it("works with an App that was not granted the Workflows permission", async () => {
    github.granted = new Set(["contents"]);
    const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
      repo: MIRROR_REPO,
    });
    expect(res.status).toBe(200);
    // Asked for with workflows, refused, asked again for contents alone.
    expect(github.tokenRequests).toEqual([
      { repositories: ["app-mirror"], permissions: { contents: "write", workflows: "write" } },
      { repositories: ["app-mirror"], permissions: { contents: "write" } },
    ]);
    await drain();
    expect(await github.repo.ref("refs/heads/main")).toBe(await source.ref("refs/heads/main"));
  });

  it("refuses to save when the App cannot write contents on the target", async () => {
    github.granted = new Set();
    const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
      repo: MIRROR_REPO,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "no-permission" });
    expect(rows("SELECT * FROM push_mirrors")).toEqual([]);
  });

  it("keeps the mirror's repository when another project names it as a source", async () => {
    await configureMirror();
    // The mirroring project has no source URL at all; it holds the repository
    // because it mirrors to it.
    const claimant = {
      id: "proj_other",
      namespace: "@acme",
      slug: "other",
    };
    const project = JSON.parse((await env.STATE.get("project:@acme:app")) ?? "{}");
    await env.STATE.put(
      "project:@acme:other",
      JSON.stringify({
        ...project,
        ...claimant,
        name: "other",
        sourceUrl: `https://github.com/${MIRROR_REPO}`,
      }),
    );
    const canonical = await ensureCanonicalProject(env, "acme-gh", "app-mirror", claimant, logger);
    expect(canonical).toEqual({ success: true, data: false });

    // And a second mirror onto the same repository is refused outright.
    const res = await json("/api/projects/@acme/other/mirror", cookies.admin, "PUT", {
      repo: MIRROR_REPO,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "taken" });
  });

  it("answers the settings form with a redirect, and shows the mirror on the page", async () => {
    const res = await request("/api/projects/@acme/app/mirror", cookies.admin, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ repo: MIRROR_REPO, enabled: "on" }).toString(),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/@acme/app/settings?mirror=saved#mirror");
    await drain();

    const page = await request("/@acme/app/settings?mirror=saved", cookies.admin);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("GitHub mirror");
    expect(html).toContain(MIRROR_REPO);
    expect(html).toContain("Up to date.");
    expect(html).toContain(((await source.ref("refs/heads/main")) ?? "").slice(0, 12));

    // A writer sees the settings page, without the admin-only mirror card.
    const writerPage = await request("/@acme/app/settings", cookies.writer);
    expect(writerPage.status).toBe(200);
    expect(await writerPage.text()).not.toContain("GitHub mirror");
  });

  it("reports the mirror in the sync status API", async () => {
    await configureMirror();
    const tip = await source.ref("refs/heads/main");

    const res = await request("/api/projects/@acme/app/sync/status", cookies.admin);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mirror: unknown }).mirror).toMatchObject({
      repo: MIRROR_REPO,
      enabled: true,
      state: "ok",
      pending: false,
      lastPushedSha: tip,
      lastError: null,
    });
  });

  it("removes the mirror without touching the GitHub repository", async () => {
    await configureMirror();
    const before = await github.repo.ref("refs/heads/main");
    const pushes = github.pushCount();

    const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "DELETE");
    expect(res.status).toBe(200);
    expect(rows("SELECT * FROM push_mirrors")).toEqual([]);
    expect(await github.repo.ref("refs/heads/main")).toBe(before);
    expect(github.pushCount()).toBe(pushes);
    expect(github.deletions).toEqual([]);

    // And a merge afterwards mirrors nothing.
    await merge();
    expect(queued).toEqual([]);
  });
});

describe("a project without a mirror", () => {
  it("merges without queueing anything or calling GitHub", async () => {
    const { res } = await merge();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ merged: true });

    expect(queued).toEqual([]);
    expect(github.requests).toEqual([]);
    await sweepPushMirrors(env, logger);
    expect(github.requests).toEqual([]);
  });
});

describe("mirroring merges", () => {
  it("pushes the whole history on the first push", async () => {
    await source.commit("second");
    const tip = await source.ref("refs/heads/main");
    await configureMirror();

    expect(await github.repo.ref("refs/heads/main")).toBe(tip);
    // An empty target needs every commit, so the clone was not a shallow one.
    expect(cloneCalls).toEqual([{ fullHistory: true }]);
    expect(await mirrorRow()).toMatchObject({ state: "ok", lastPushedSha: tip, attempts: 0 });
  });

  it("pushes the default branch at the merged commit after a merge", async () => {
    await configureMirror();
    github.updates = [];

    const { res, sha } = await merge();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { commit: string }).commit).toBe(sha);
    // Queued by the merge, not run by it.
    expect(queued).toEqual([{ type: "mirror.push", projectId: PROJECT_ID }]);
    expect(github.updates).toEqual([]);

    const [delivered] = await drain();
    expect(delivered?.acked).toBe(true);

    expect(github.updates).toHaveLength(1);
    expect(github.updates[0]).toMatchObject({ ref: "refs/heads/main", newOid: sha });
    expect(await github.repo.ref("refs/heads/main")).toBe(sha);
    expect(await github.repo.has(sha)).toBe(true);
    expect(github.overwrites).toEqual([]);
    expect(await mirrorRow()).toMatchObject({ state: "ok", lastPushedSha: sha });
  });

  it("ends at the later of two merges, whatever order their messages run in", async () => {
    await configureMirror();

    const first = await merge();
    const second = await merge();
    expect(queued).toHaveLength(2);
    // Deliver the later merge's message first.
    queued.reverse();
    const delivered = await drain();

    expect(delivered.every((d) => d.acked)).toBe(true);
    expect(await github.repo.ref("refs/heads/main")).toBe(second.sha);
    expect(second.sha).not.toBe(first.sha);
    expect(github.overwrites).toEqual([]);
    expect(await mirrorRow()).toMatchObject({ state: "ok", lastPushedSha: second.sha });
  });

  it("does not race: a merge that lands mid-push is pushed by the run already going", async () => {
    await configureMirror();
    github.updates = [];

    const first = await merge();
    let open: () => void = () => {};
    github.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pushesBefore = github.pushCount();
    // The first push is now parked inside GitHub's receive-pack.
    const running = deliver(queued.shift());
    await vi.waitFor(() => expect(github.pushCount()).toBe(pushesBefore + 1));

    // A second merge lands, and its message is consumed while the first run
    // still holds the project's lease.
    const second = await merge();
    const overlapping = await deliver(queued.shift());
    expect(overlapping.acked).toBe(true);
    expect(overlapping.retried).toBeUndefined();
    // It pushed nothing itself: the only push in flight is still the first.
    expect(github.pushCount()).toBe(pushesBefore + 1);

    github.gate = null;
    open();
    await running;

    // The run that held the lease saw the second request and went round again.
    expect(github.updates.map((u) => u.newOid)).toEqual([first.sha, second.sha]);
    expect(await github.repo.ref("refs/heads/main")).toBe(second.sha);
    expect(github.overwrites).toEqual([]);
    const mirror = await mirrorRow();
    expect(mirror).toMatchObject({ state: "ok", lastPushedSha: second.sha });
    expect(mirror.leaseExpiresAt).toBeUndefined();
  });

  it("does not mistake a target more than a clone window behind for divergence", async () => {
    await configureMirror();
    await source.commit("local 1");
    await source.commit("local 2");
    simulateShallow = true;
    cloneCalls = [];

    const { sha } = await merge();
    await drain();

    // The shallow clone could not see the target's tip, so it looked again
    // with full history before deciding anything.
    expect(cloneCalls).toEqual([{ fullHistory: false }, { fullHistory: true }]);
    expect(await github.repo.ref("refs/heads/main")).toBe(sha);
    expect(await mirrorRow()).toMatchObject({ state: "ok" });
  });

  it("fetches no objects when the mirror is already current", async () => {
    await configureMirror();
    cloneCalls = [];
    const pushes = github.pushCount();

    const res = await json("/api/projects/@acme/app/mirror/resume", cookies.admin, "POST");
    expect(res.status).toBe(202);
    await drain();

    expect(cloneCalls).toEqual([]);
    expect(github.pushCount()).toBe(pushes);
    expect(await mirrorRow()).toMatchObject({ state: "ok" });
  });
});

describe("mirroring tags", () => {
  it("creates the project's tags on the mirror at the same objects", async () => {
    await configureMirror();
    const tip = (await source.ref("refs/heads/main")) ?? "";
    await git.tag({ fs: source.fs, dir: "/", ref: "v1.0.0", object: tip });
    await git.annotatedTag({
      fs: source.fs,
      dir: "/",
      ref: "v1.1.0",
      object: tip,
      message: "release",
      tagger: author,
    });
    const annotated = (await source.ref("refs/tags/v1.1.0")) ?? "";
    expect(annotated).not.toBe(tip);

    // Whatever writes a tag to the project asks for a push the same way a merge
    // does; a project remote refuses tag pushes today (#182), so the request is
    // made directly here.
    await requestPushMirror(env, logger, PROJECT_ID, "tag pushed");
    expect(queued).toEqual([{ type: "mirror.push", projectId: PROJECT_ID }]);
    await drain();

    expect(await github.repo.ref("refs/tags/v1.0.0")).toBe(tip);
    expect(await github.repo.ref("refs/tags/v1.1.0")).toBe(annotated);
    // The annotated tag's own object travelled, not just a ref to the commit.
    expect(await github.repo.has(annotated)).toBe(true);
    expect(await mirrorRow()).toMatchObject({ state: "ok" });
  });

  it("never moves a tag the mirror already has somewhere else", async () => {
    await configureMirror();
    const first = (await source.ref("refs/heads/main")) ?? "";
    await merge();
    await drain();
    const second = (await source.ref("refs/heads/main")) ?? "";

    // The mirror's v1 points at the older commit; the project's at the newer.
    await github.repo.setRef("refs/tags/v1", first);
    await git.tag({ fs: source.fs, dir: "/", ref: "v1", object: second });
    await git.tag({ fs: source.fs, dir: "/", ref: "v2", object: second });
    github.updates = [];

    await requestPushMirror(env, logger, PROJECT_ID, "tag pushed");
    await drain();

    expect(await mirrorRow()).toMatchObject({ state: "diverged" });
    expect((await mirrorRow()).lastError).toContain("Tag 'v1'");
    expect(await github.repo.ref("refs/tags/v1")).toBe(first);
    // Nothing is pushed around a divergence, not even the tag that was fine.
    expect(github.updates).toEqual([]);
    expect(await github.repo.ref("refs/tags/v2")).toBeUndefined();
  });
});

describe("divergence", () => {
  /** Someone commits straight to the mirror, on top of what it had. */
  async function commitOnGitHub(): Promise<string> {
    return github.repo.commit("made on GitHub");
  }

  it("is detected, surfaced, and overwrites nothing", async () => {
    await configureMirror();
    const foreign = await commitOnGitHub();
    github.updates = [];

    const { res, sha } = await merge();
    // The merge itself is unaffected.
    expect(res.status).toBe(200);
    const [delivered] = await drain();
    expect(delivered?.acked).toBe(true);

    const mirror = await mirrorRow();
    expect(mirror.state).toBe("diverged");
    expect(mirror.lastError).toContain("not an ancestor");
    expect(mirror.leaseExpiresAt).toBeUndefined();

    // The mirror still holds the commit made there, and was sent nothing.
    expect(await github.repo.ref("refs/heads/main")).toBe(foreign);
    expect(github.updates).toEqual([]);
    expect(github.overwrites).toEqual([]);
    expect(github.deletions).toEqual([]);
    expect(await github.repo.has(sha)).toBe(false);

    // Surfaced as an event...
    const events = rows<{ type: string; project_id: string; payload: string }>(
      "SELECT type, project_id, payload FROM events WHERE type = 'mirror.diverged'",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.project_id).toBe(PROJECT_ID);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({ repo: MIRROR_REPO });
    // ...an audit entry...
    expect(
      rows("SELECT action, actor_type, project_id FROM audit_log WHERE action = 'mirror.diverged'"),
    ).toEqual([{ action: "mirror.diverged", actor_type: "system", project_id: PROJECT_ID }]);
    // ...and in the API.
    const status = await request("/api/projects/@acme/app/mirror", cookies.admin);
    expect(((await status.json()) as { mirror: unknown }).mirror).toMatchObject({
      state: "diverged",
    });
  });

  it("stops pushing until an admin resumes, and resuming never forces", async () => {
    await configureMirror();
    const foreign = await commitOnGitHub();
    await merge();
    await drain();
    const requestsWhenStopped = github.requests.length;

    // Further merges are still accepted, and push nothing.
    const { res } = await merge();
    expect(res.status).toBe(200);
    expect(queued).toEqual([]);
    await sweepPushMirrors(env, logger);
    expect(queued).toEqual([]);
    // Even a stray message does not reach GitHub.
    await deliver({ type: "mirror.push", projectId: PROJECT_ID });
    expect(github.requests.length).toBe(requestsWhenStopped);
    expect(await mirrorRow()).toMatchObject({ state: "diverged" });

    // Only an admin clears it.
    expect(
      (await json("/api/projects/@acme/app/mirror/resume", cookies.writer, "POST")).status,
    ).toBe(403);
    expect(await mirrorRow()).toMatchObject({ state: "diverged" });

    // Resumed while GitHub still has the foreign commit: it stops again.
    const resumed = await json("/api/projects/@acme/app/mirror/resume", cookies.admin, "POST");
    expect(resumed.status).toBe(202);
    await drain();
    expect(await mirrorRow()).toMatchObject({ state: "diverged" });
    expect(await github.repo.ref("refs/heads/main")).toBe(foreign);
    expect(github.overwrites).toEqual([]);
    expect(rows("SELECT id FROM events WHERE type = 'mirror.diverged'")).toHaveLength(2);

    // The admin puts GitHub back to a commit the project has, and resumes.
    const ancestor = (await git.log({ fs: source.fs, dir: "/", ref: "main" })).at(-1)?.oid ?? "";
    await github.repo.setRef("refs/heads/main", ancestor);
    await json("/api/projects/@acme/app/mirror/resume", cookies.admin, "POST");
    await drain();

    const tip = await source.ref("refs/heads/main");
    expect(await github.repo.ref("refs/heads/main")).toBe(tip);
    expect(await mirrorRow()).toMatchObject({ state: "ok", lastPushedSha: tip });
    expect(github.overwrites).toEqual([]);
    expect(
      rows<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'mirror.resumed'").map(
        (row) => JSON.parse(row.detail).previousState,
      ),
    ).toEqual(["diverged", "diverged"]);
  });
});

describe("a failing mirror", () => {
  it("never fails or blocks the merge, and retries with backoff", async () => {
    await configureMirror();
    github.failPushes = 2;

    const { res, sha } = await merge();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ merged: true, commit: sha });

    // First attempt: the queue is asked to redeliver after the first backoff.
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await deliver(queued.shift());
    expect(first.acked).toBe(false);
    expect(first.retried).toEqual({ delaySeconds: 30 });
    let mirror = await mirrorRow();
    expect(mirror).toMatchObject({ state: "retrying", attempts: 1 });
    expect(mirror.lastError).toContain("500");
    expect(mirror.nextAttemptAt).toBeDefined();

    // A duplicate delivered before the backoff is up does nothing.
    const early = await deliver({ type: "mirror.push", projectId: PROJECT_ID });
    expect(early.acked).toBe(true);
    expect((await mirrorRow()).attempts).toBe(1);

    // Second attempt fails too; the delay doubles.
    vi.advanceTimersByTime(31_000);
    const second = await deliver(first.body);
    expect(second.retried).toEqual({ delaySeconds: 60 });
    expect(await mirrorRow()).toMatchObject({ state: "retrying", attempts: 2 });

    // Third attempt reaches a healthy GitHub.
    vi.advanceTimersByTime(61_000);
    const third = await deliver(first.body);
    expect(third.acked).toBe(true);
    mirror = await mirrorRow();
    expect(mirror).toMatchObject({ state: "ok", attempts: 0, lastPushedSha: sha });
    expect(mirror.lastError).toBeUndefined();
    expect(await github.repo.ref("refs/heads/main")).toBe(sha);
  });

  it("gives up after a bounded number of attempts and leaves a visible failed state", async () => {
    await configureMirror();
    github.failPushes = 1_000;
    const before = await github.repo.ref("refs/heads/main");
    await merge();
    const message = queued.shift();

    vi.useFakeTimers({ toFake: ["Date"] });
    const delays: (number | undefined)[] = [];
    let last: Delivered | undefined;
    for (let attempt = 1; attempt <= MIRROR_MAX_ATTEMPTS; attempt++) {
      last = await deliver(message);
      delays.push(last.retried?.delaySeconds);
      vi.advanceTimersByTime(16 * 60 * 1000);
    }

    expect(delays).toEqual([30, 60, 120, 240, undefined]);
    expect(last?.acked).toBe(true);
    const mirror = await mirrorRow();
    expect(mirror).toMatchObject({ state: "failed", attempts: MIRROR_MAX_ATTEMPTS });
    expect(mirror.nextAttemptAt).toBeUndefined();
    expect(await github.repo.ref("refs/heads/main")).toBe(before);
    expect(rows("SELECT id FROM events WHERE type = 'mirror.failed'")).toHaveLength(1);

    // Left alone it stays failed: the sweep does not hammer a dead target.
    const pushes = github.pushCount();
    await sweepPushMirrors(env, logger);
    await deliver(message);
    expect(queued).toEqual([]);
    expect(github.pushCount()).toBe(pushes);

    // The next merge is a new reason to try, and GitHub has recovered.
    github.failPushes = 0;
    const next = await merge();
    expect(next.res.status).toBe(200);
    await drain();
    expect(await mirrorRow()).toMatchObject({ state: "ok", lastPushedSha: next.sha });
    expect(await github.repo.ref("refs/heads/main")).toBe(next.sha);
  });

  it("fails at once, without retrying, when the App has lost the repository", async () => {
    await configureMirror();
    // The installation was removed and its cached lookup has expired.
    github.uninstalled = true;
    await env.STATE.delete(`github_installation:${MIRROR_REPO}`);

    const { res } = await merge();
    expect(res.status).toBe(200);
    const [delivered] = await drain();

    expect(delivered?.acked).toBe(true);
    expect(delivered?.retried).toBeUndefined();
    const mirror = await mirrorRow();
    expect(mirror.state).toBe("failed");
    expect(mirror.lastError).toContain("not installed");
  });

  it("does not retry a push GitHub refuses for want of the Workflows permission", async () => {
    await configureMirror();
    github.rejectWith =
      "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission";

    const { res } = await merge();
    expect(res.status).toBe(200);
    const [delivered] = await drain();

    expect(delivered?.acked).toBe(true);
    expect(delivered?.retried).toBeUndefined();
    const mirror = await mirrorRow();
    expect(mirror.state).toBe("failed");
    expect(mirror.lastError).toContain("workflows");
  });

  it("retries a push GitHub refuses for any other reason", async () => {
    await configureMirror();
    github.rejectWith = "protected branch hook declined";
    await merge();
    const [delivered] = await drain();
    expect(delivered?.retried).toEqual({ delaySeconds: 30 });
    expect(await mirrorRow()).toMatchObject({ state: "retrying", attempts: 1 });
    expect((await mirrorRow()).lastError).toContain("protected branch hook declined");
  });

  it("acks a message it cannot read instead of redelivering it forever", async () => {
    for (const body of [null, "push", { type: "mirror.push" }, { type: "other", projectId: "x" }]) {
      const delivered = await deliver(body);
      expect(delivered.acked).toBe(true);
      expect(delivered.retried).toBeUndefined();
    }
    // A well-formed message for a project with no mirror is acked the same way.
    expect((await deliver({ type: "mirror.push", projectId: "proj_unknown" })).acked).toBe(true);
    expect(github.requests).toEqual([]);
  });

  it("still merges when the mirror queue is down, and the sweep recovers the push", async () => {
    await configureMirror();
    queueDown = true;

    const { res, sha } = await merge();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ merged: true });
    expect(queued).toEqual([]);
    expect(await mirrorRow()).toMatchObject({ requestedSeq: 2, pushedSeq: 1 });

    queueDown = false;
    await sweepPushMirrors(env, logger);
    expect(queued).toEqual([{ type: "mirror.push", projectId: PROJECT_ID }]);
    await drain();
    expect(await github.repo.ref("refs/heads/main")).toBe(sha);
  });

  it("pushes from the sweep when no mirror queue is bound at all", async () => {
    await configureMirror();
    const unbound = { ...env, MIRROR_QUEUE: undefined } as unknown as Env;
    env = unbound;

    const { res, sha } = await merge();
    expect(res.status).toBe(200);
    expect(await github.repo.ref("refs/heads/main")).not.toBe(sha);

    await sweepPushMirrors(env, logger);
    expect(await github.repo.ref("refs/heads/main")).toBe(sha);
  });

  it("recovers a push whose run died holding the lease", async () => {
    await configureMirror();
    const { sha } = await merge();
    queued = [];
    // A run claimed the lease ten minutes and a bit ago, and never came back.
    raw
      .prepare(
        "UPDATE push_mirrors SET state = 'pushing', lease_expires_at = ? WHERE project_id = ?",
      )
      .run(new Date(Date.now() - 1_000).toISOString(), PROJECT_ID);

    await sweepPushMirrors(env, logger);
    await drain();
    expect(await github.repo.ref("refs/heads/main")).toBe(sha);
    expect(await mirrorRow()).toMatchObject({ state: "ok" });
  });
});

describe("forge mode excludes layer mode", () => {
  it("refuses to sync from the source while the mirror is enabled", async () => {
    await configureMirror();
    const res = await json("/api/projects/@acme/app/sync", cookies.admin, "POST", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PUSH_MIRROR_ENABLED" });
  });

  it("refuses to promote a change to a GitHub pull request", async () => {
    await configureMirror();
    raw
      .prepare(
        "INSERT INTO changes (id, project, project_id, workspace, status) VALUES ('chg_promote', '@acme/app', ?, 'ws', 'accepted')",
      )
      .run(PROJECT_ID);
    const res = await json("/api/changes/chg_promote/github-pr", cookies.admin, "POST", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PUSH_MIRROR_ENABLED" });
  });

  it("skips the project in the scheduled auto-sync", async () => {
    const project = JSON.parse((await env.STATE.get("project:@acme:app")) ?? "{}");
    await env.STATE.put(
      "project:@acme:app",
      JSON.stringify({
        ...project,
        sourceUrl: `https://github.com/${MIRROR_REPO}`,
        autoSyncEnabled: true,
      }),
    );
    await configureMirror();
    const requestsBefore = github.requests.length;

    expect(await syncAllProjects(env)).toEqual({ synced: 0, failed: 0, skipped: 1 });
    // Skipped before anything asked GitHub what is new.
    expect(github.requests.length).toBe(requestsBefore);
  });

  it("allows both again once the mirror is disabled", async () => {
    await configureMirror();
    const res = await json("/api/projects/@acme/app/mirror", cookies.admin, "PUT", {
      repo: MIRROR_REPO,
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(await mirrorRow()).toMatchObject({ enabled: false });

    // Not refused for the mirror any more (it has no source, so 400 instead).
    const sync = await json("/api/projects/@acme/app/sync", cookies.admin, "POST", {});
    expect(sync.status).toBe(400);
    // And a disabled mirror pushes nothing.
    await merge();
    expect(queued).toEqual([]);
  });
});

describe("helpers", () => {
  it("backs off exponentially, capped", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(mirrorBackoffSeconds)).toEqual([
      30, 60, 120, 240, 480, 900, 900,
    ]);
  });

  it("parses owner/repo and nothing that could aim a credential elsewhere", () => {
    expect(parseGitHubRepo("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
    expect(parseGitHubRepo("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseGitHubRepo(" acme/wid.gets/ ")).toEqual({ owner: "acme", repo: "wid.gets" });
    for (const bad of [
      undefined,
      42,
      "",
      "acme",
      "acme/",
      "/widgets",
      "acme/widgets/extra",
      "acme/..",
      "ac me/widgets",
      "acme/wid gets",
      "https://gitlab.com/acme/widgets",
      "acme@evil.test/widgets",
      "-acme/widgets",
    ]) {
      expect(parseGitHubRepo(bad)).toBeNull();
    }
  });
});
