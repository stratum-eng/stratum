/**
 * GitHub issue import (#421): the queue job against a real SQLite engine with
 * every migration applied, GitHub faked at the fetch boundary, plus the API
 * route, the queue dispatch, the pure transforms and the rendering of imported
 * (untrusted) text.
 */
import { Hono } from "hono";
import { renderToString } from "hono/jsx/dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCircuitBreakersForTests } from "../src/github/client";
import {
  ISSUES_PER_PAGE,
  parseIssueImportMessage,
  processIssueImportMessage,
} from "../src/github/issue-import";
import {
  parseGitHubComment,
  parseGitHubIssue,
  rewriteIssueReferences,
} from "../src/github/issue-import-transform";
import { authMiddleware } from "../src/middleware/auth";
import { handleImportQueue } from "../src/queue/import-queue";
import { issueImportNotice, issueImportRouter } from "../src/routes/issue-import";
import { DELETED_USER_SENTINEL, anonymizeUserContributions } from "../src/storage/deletion";
import { createIssueImportRun, getIssueImportRun } from "../src/storage/github-issue-import";
import { listIssueComments } from "../src/storage/issue-comments";
import { listIssueLabels } from "../src/storage/issue-labels";
import { createIssue, getIssueByNumber, listIssues } from "../src/storage/issues";
import type { Env, IssueImportJobMessage, Message, MessageBatch, ProjectEntry } from "../src/types";
import { IssueDetailPage } from "../src/ui/pages/issues";
import { ProjectSettingsPage } from "../src/ui/pages/project-settings";
import { hashToken } from "../src/utils/crypto";
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
};

const OWNER_TOKEN = "stratum_user_ownertoken0000000000000000";
const WRITER_TOKEN = "stratum_user_writertoken000000000000000";
const OWNER_AUTH = { Authorization: `Bearer ${OWNER_TOKEN}` };
const WRITER_AUTH = { Authorization: `Bearer ${WRITER_TOKEN}` };
const PROJECT_ID = "proj_import";
const REPO = "acme/widgets";
const API = "/api/projects/testns/widgets/issues/import/github";

// ---------------------------------------------------------------------------
// GitHub fixtures and a fake API
// ---------------------------------------------------------------------------

interface FakeIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  user: { login: string; id: number } | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  html_url: string;
  pull_request?: { url: string };
}

interface FakeComment {
  id: number;
  body: string;
  user: { login: string; id: number } | null;
  created_at: string;
  html_url: string;
}

function ghIssue(number: number, overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body of ${number}`,
    state: "open",
    user: { login: "octocat", id: 1 },
    labels: [],
    created_at: `2020-01-${String(number % 28 || 1).padStart(2, "0")}T10:00:00Z`,
    updated_at: "2021-01-01T00:00:00Z",
    closed_at: null,
    comments: 0,
    html_url: `https://github.com/${REPO}/issues/${number}`,
    ...overrides,
  };
}

function ghComment(id: number, issueNumber: number, body: string): FakeComment {
  return {
    id,
    body,
    user: { login: "hubot", id: 2 },
    created_at: "2020-02-01T12:00:00Z",
    html_url: `https://github.com/${REPO}/issues/${issueNumber}#issuecomment-${id}`,
  };
}

interface FakeGitHub {
  issues: FakeIssue[];
  comments: Map<number, FakeComment[]>;
  isPrivate: boolean;
  /** Next N issue-listing requests answer with a primary rate limit. */
  rateLimitListings: number;
  requests: string[];
}

function installFakeGitHub(gh: FakeGitHub) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    gh.requests.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const slice = <T,>(items: T[]) => items.slice((page - 1) * perPage, page * perPage);

    if (url.pathname === `/repos/${REPO}`) {
      return json({ private: gh.isPrivate, visibility: gh.isPrivate ? "private" : "public" });
    }
    if (url.pathname === `/repos/${REPO}/issues`) {
      if (gh.rateLimitListings > 0) {
        gh.rateLimitListings--;
        return new Response("rate limited", {
          status: 403,
          headers: {
            "X-RateLimit-Remaining": "0",
            // Far enough out that the client does not sleep in-process.
            "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 600),
          },
        });
      }
      return json(slice(gh.issues));
    }
    const commentsMatch = url.pathname.match(/^\/repos\/acme\/widgets\/issues\/(\d+)\/comments$/);
    if (commentsMatch) {
      return json(slice(gh.comments.get(Number(commentsMatch[1])) ?? []));
    }
    return json({ message: "Not Found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

interface SentMessage {
  body: IssueImportJobMessage;
  delaySeconds: number | undefined;
}

async function makeEnv(projectOverrides: Partial<ProjectEntry> = {}) {
  const { db, raw } = makeSqliteD1();
  const now = "2026-01-01T00:00:00.000Z";
  const insertUser = raw.prepare(
    "INSERT INTO users (id, email, username, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertUser.run("user_owner", "owner@example.com", "owner", await hashToken(OWNER_TOKEN), now);
  insertUser.run("user_writer", "writer@example.com", "writer", await hashToken(WRITER_TOKEN), now);

  const project = {
    id: PROJECT_ID,
    name: "widgets",
    slug: "widgets",
    namespace: "testns",
    ownerId: "user_owner",
    ownerType: "user",
    remote: "https://artifacts.example.com/repos/widgets",
    createdAt: now,
    sourceUrl: `https://github.com/${REPO}`,
    sourceProvider: "github",
    ...projectOverrides,
  } as ProjectEntry;
  const kv = makeFakeKV();
  await kv.put("project:testns:widgets", JSON.stringify(project));

  const sent: SentMessage[] = [];
  const queue = {
    send: vi.fn(async (body: IssueImportJobMessage, opts?: { delaySeconds?: number }) => {
      sent.push({ body, delaySeconds: opts?.delaySeconds });
    }),
  };
  const env = {
    DB: db,
    STATE: kv,
    IMPORT_QUEUE: queue,
    GITHUB_TOKEN: "ghp_instance",
    // The instance token acts only for an owner the operator binds.
    GITHUB_ALLOWED_OWNERS: "acme=user:user_owner",
  } as unknown as Env;
  return { db, raw, env, kv, project, sent };
}

/** Start a run and process queued pages until the chain ends; returns the outcomes. */
async function runImport(ctx: Awaited<ReturnType<typeof makeEnv>>, initiatedBy = "user_owner") {
  const run = await createIssueImportRun(ctx.db, logger, {
    projectId: PROJECT_ID,
    githubRepo: REPO,
    initiatedBy,
  });
  if (!run.success) throw new Error(run.error.message);
  ctx.sent.push({
    body: {
      type: "github.issues.import",
      runId: run.data.id,
      projectId: PROJECT_ID,
      namespace: "testns",
      slug: "widgets",
      page: 1,
      timestamp: new Date().toISOString(),
    },
    delaySeconds: undefined,
  });
  const outcomes: string[] = [];
  for (let guard = 0; ctx.sent.length > 0 && guard < 100; guard++) {
    const next = ctx.sent.shift() as SentMessage;
    const result = await processIssueImportMessage(ctx.env, next.body, logger);
    if (!result.success) throw new Error(result.error.message);
    outcomes.push(next.delaySeconds !== undefined ? `${result.data}(delayed)` : result.data);
  }
  return { runId: run.data.id, outcomes };
}

async function issueByNumber(db: D1Database, number: number) {
  const result = await getIssueByNumber(db, logger, "widgets", number, { projectId: PROJECT_ID });
  if (!result.success) throw new Error(`issue #${number} missing`);
  return result.data;
}

let gh: FakeGitHub;
beforeEach(() => {
  resetCircuitBreakersForTests();
  gh = { issues: [], comments: new Map(), isPrivate: false, rateLimitListings: 0, requests: [] };
  installFakeGitHub(gh);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

describe("GitHub issue import job", () => {
  function seedRepo() {
    gh.issues = [
      ghIssue(1, {
        title: "Open bug",
        body: "Crashes on start, see #2 and #3.",
        labels: [{ name: "bug" }, { name: "p1" }],
        comments: 2,
      }),
      ghIssue(2, { title: "A pull request", pull_request: { url: "https://api.github.com/x" } }),
      ghIssue(3, {
        title: "Closed feature",
        state: "closed",
        closed_at: "2020-03-04T05:06:07Z",
        labels: [{ name: "enhancement" }],
        comments: 1,
        body: "Follow-up to #1",
      }),
    ];
    gh.comments.set(1, [ghComment(101, 1, "Same here"), ghComment(102, 1, "Fixed by #3?")]);
    gh.comments.set(3, [ghComment(301, 3, "Shipped")]);
  }

  it("imports open and closed issues with labels, comments, timestamps and back-links", async () => {
    seedRepo();
    const ctx = await makeEnv();
    const { runId, outcomes } = await runImport(ctx);
    expect(outcomes).toEqual(["completed"]);

    const issues = await listIssues(ctx.db, logger, "widgets", undefined, {
      projectId: PROJECT_ID,
    });
    expect(issues.success && issues.data.map((i) => i.title).sort()).toEqual([
      "Closed feature",
      "Open bug",
    ]);

    const open = await issueByNumber(ctx.db, 1);
    expect(open.status).toBe("open");
    expect(open.externalUrl).toBe(`https://github.com/${REPO}/issues/1`);
    expect(open.externalAuthor).toBe("octocat");
    // No linked Stratum account: the importer is the accountable author.
    expect(open.authorId).toBe("user_owner");
    expect(open.createdAt).toBe("2020-01-01T10:00:00.000Z");
    // #2 is a pull request (never imported) and #3 is imported after #1, so on a
    // first run both stay explicit references to GitHub.
    expect(open.body).toBe(`Crashes on start, see ${REPO}#2 and ${REPO}#3.`);
    const openLabels = await listIssueLabels(ctx.db, logger, open.id);
    expect(openLabels.success && openLabels.data).toEqual(["bug", "p1"]);

    const closed = await issueByNumber(ctx.db, 2);
    expect(closed.title).toBe("Closed feature");
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBe("2020-03-04T05:06:07.000Z");
    expect(closed.externalUrl).toBe(`https://github.com/${REPO}/issues/3`);
    // GitHub #1 became Stratum #1, so the back-reference resolves locally.
    expect(closed.body).toBe("Follow-up to #1");

    const comments = await listIssueComments(ctx.db, logger, open.id);
    expect(comments.success && comments.data.map((c) => c.body)).toEqual([
      "Same here",
      `Fixed by ${REPO}#3?`,
    ]);
    expect(comments.success && comments.data[0]?.externalAuthor).toBe("hubot");
    expect(comments.success && comments.data[0]?.externalUrl).toBe(
      `https://github.com/${REPO}/issues/1#issuecomment-101`,
    );

    const run = await getIssueImportRun(ctx.db, logger, runId);
    expect(run.success && run.data).toMatchObject({
      status: "completed",
      issuesCreated: 2,
      issuesUpdated: 0,
      commentsImported: 3,
      pullsSkipped: 1,
    });
    // The pull request's comments were never even requested.
    expect(gh.requests.some((r) => r.includes("/issues/2/comments"))).toBe(false);
  });

  it("a re-run updates in place and creates no duplicates", async () => {
    seedRepo();
    const ctx = await makeEnv();
    await runImport(ctx);

    gh.issues[0] = { ...(gh.issues[0] as FakeIssue), title: "Open bug (renamed)", comments: 3 };
    gh.comments.set(1, [...(gh.comments.get(1) ?? []), ghComment(103, 1, "One more")]);
    const { runId } = await runImport(ctx);

    const issues = await listIssues(ctx.db, logger, "widgets", undefined, {
      projectId: PROJECT_ID,
    });
    expect(issues.success && issues.data).toHaveLength(2);
    const open = await issueByNumber(ctx.db, 1);
    expect(open.title).toBe("Open bug (renamed)");
    // The forward reference to #3 resolves now that #3 has been imported.
    expect(open.body).toBe(`Crashes on start, see ${REPO}#2 and #2.`);
    const comments = await listIssueComments(ctx.db, logger, open.id);
    expect(comments.success && comments.data.map((c) => c.body)).toEqual([
      "Same here",
      "Fixed by #2?",
      "One more",
    ]);
    const labels = await listIssueLabels(ctx.db, logger, open.id);
    expect(labels.success && labels.data).toEqual(["bug", "p1"]);

    const run = await getIssueImportRun(ctx.db, logger, runId);
    expect(run.success && run.data).toMatchObject({
      issuesCreated: 0,
      issuesUpdated: 2,
      commentsImported: 1,
    });
    const mapRows = ctx.raw.prepare("SELECT COUNT(*) AS n FROM github_issue_map").get() as {
      n: number;
    };
    expect(mapRows.n).toBe(2);
  });

  it("numbers imported issues after the project's existing ones", async () => {
    seedRepo();
    const ctx = await makeEnv();
    await createIssue(ctx.db, logger, {
      project: "widgets",
      projectId: PROJECT_ID,
      title: "Native issue",
      authorType: "user",
      authorId: "user_owner",
    });
    await runImport(ctx);
    expect((await issueByNumber(ctx.db, 2)).title).toBe("Open bug");
    const closed = await issueByNumber(ctx.db, 3);
    expect(closed.title).toBe("Closed feature");
    // GitHub #1 is Stratum #2 here, not the unrelated native #1.
    expect(closed.body).toBe("Follow-up to #2");
  });

  it("attributes issues to the Stratum user linked to the GitHub account", async () => {
    gh.issues = [ghIssue(1, { user: { login: "writer-gh", id: 4242 } })];
    const ctx = await makeEnv();
    ctx.raw.prepare("UPDATE users SET github_id = '4242' WHERE id = 'user_writer'").run();
    await runImport(ctx);
    const issue = await issueByNumber(ctx.db, 1);
    expect(issue.authorId).toBe("user_writer");
    expect(issue.externalAuthor).toBeUndefined();
  });

  it("pages through large repositories one queue message per page", async () => {
    gh.issues = Array.from({ length: ISSUES_PER_PAGE + 3 }, (_, i) => ghIssue(i + 1));
    const ctx = await makeEnv();
    const { runId, outcomes } = await runImport(ctx);
    expect(outcomes).toEqual(["continued", "completed"]);
    const issues = await listIssues(ctx.db, logger, "widgets", undefined, {
      projectId: PROJECT_ID,
    });
    expect(issues.success && issues.data).toHaveLength(ISSUES_PER_PAGE + 3);
    const run = await getIssueImportRun(ctx.db, logger, runId);
    expect(run.success && run.data?.nextPage).toBe(3);
  });

  describe("bounding the work of one queue message", () => {
    const commentsFor = (number: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        ghComment(number * 100_000 + i, number, `Comment ${i}`),
      );
    const count = (ctx: Awaited<ReturnType<typeof makeEnv>>, table: string) =>
      (ctx.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    /** Run a whole import, counting the D1 statements each message prepares. */
    async function mostQueriesInOneMessage(ctx: Awaited<ReturnType<typeof makeEnv>>) {
      let queries = 0;
      ctx.env.DB = new Proxy(ctx.db, {
        get(target, prop) {
          if (prop !== "prepare") return Reflect.get(target, prop, target);
          return (sql: string) => {
            queries++;
            return target.prepare(sql);
          };
        },
      });
      const run = await createIssueImportRun(ctx.db, logger, {
        projectId: PROJECT_ID,
        githubRepo: REPO,
        initiatedBy: "user_owner",
      });
      if (!run.success) throw run.error;
      let body: IssueImportJobMessage = {
        type: "github.issues.import",
        runId: run.data.id,
        projectId: PROJECT_ID,
        namespace: "testns",
        slug: "widgets",
        page: 1,
        timestamp: new Date().toISOString(),
      };
      let most = 0;
      for (;;) {
        queries = 0;
        const result = await processIssueImportMessage(ctx.env, body, logger);
        if (!result.success) throw result.error;
        most = Math.max(most, queries);
        const next = ctx.sent.shift();
        if (!next) return most;
        body = next.body;
      }
    }

    it("spreads a long thread over several messages, importing each comment once", async () => {
      gh.issues = [ghIssue(1, { comments: 650 }), ghIssue(2, { comments: 3 })];
      gh.comments.set(1, commentsFor(1, 650));
      gh.comments.set(2, commentsFor(2, 3));
      const ctx = await makeEnv();
      const { runId, outcomes } = await runImport(ctx);

      expect(outcomes.length).toBeGreaterThan(1);
      expect(outcomes.at(-1)).toBe("completed");
      expect(outcomes.slice(0, -1).every((outcome) => outcome === "continued")).toBe(true);
      expect(count(ctx, "issue_comments")).toBe(653);
      const run = await getIssueImportRun(ctx.db, logger, runId);
      if (!run.success || !run.data) throw new Error("run missing");
      expect(run.data).toMatchObject({ issuesCreated: 2, issuesUpdated: 0, commentsImported: 653 });
      expect(run.data.resume).toBeUndefined();
    });

    it("keeps every message within D1's per-invocation query limit", async () => {
      gh.issues = [1, 2, 3].map((number) => ghIssue(number, { comments: 500 }));
      for (const issue of [1, 2, 3]) gh.comments.set(issue, commentsFor(issue, 500));
      const ctx = await makeEnv();
      const most = await mostQueriesInOneMessage(ctx);
      expect(count(ctx, "issue_comments")).toBe(1500);
      expect(most).toBeLessThan(1000);
    });

    it("imports every comment of a thread past the old 3,000 cap", async () => {
      gh.issues = [ghIssue(1, { comments: 3050 })];
      gh.comments.set(1, commentsFor(1, 3050));
      const ctx = await makeEnv();
      const { outcomes } = await runImport(ctx);
      expect(outcomes.at(-1)).toBe("completed");
      expect(count(ctx, "issue_comments")).toBe(3050);
    });

    it("counts labels toward the budget", async () => {
      // Label-heavy issues spend the budget on statements of their own, then a
      // long thread of distinct authors, the costliest comments, runs past it.
      const labels = Array.from({ length: 20 }, (_, i) => ({ name: `label-${i}` }));
      gh.issues = [
        ...Array.from({ length: 18 }, (_, i) => ghIssue(i + 1, { labels })),
        ghIssue(19, { comments: 300 }),
      ];
      gh.comments.set(
        19,
        commentsFor(19, 300).map((comment, i) => ({
          ...comment,
          user: { login: `author-${i}`, id: 1000 + i },
        })),
      );
      const ctx = await makeEnv();
      const most = await mostQueriesInOneMessage(ctx);
      expect(count(ctx, "issue_comments")).toBe(300);
      expect(most).toBeLessThan(1000);
    });

    it("resumes by identity when issue numbers are not in listing order", async () => {
      // Transferred issues keep their creation date but take a new number.
      gh.issues = [ghIssue(9, { comments: 500 }), ghIssue(2, { comments: 1 }), ghIssue(5)];
      gh.comments.set(9, commentsFor(9, 500));
      gh.comments.set(2, commentsFor(2, 1));
      const ctx = await makeEnv();
      const { runId } = await runImport(ctx);
      expect(count(ctx, "issue_comments")).toBe(501);
      const run = await getIssueImportRun(ctx.db, logger, runId);
      expect(run.success && run.data).toMatchObject({ issuesCreated: 3, status: "completed" });
    });

    it("carries on from the resume point when a message is redelivered", async () => {
      gh.issues = [ghIssue(1, { comments: 650 })];
      gh.comments.set(1, commentsFor(1, 650));
      const ctx = await makeEnv();
      const run = await createIssueImportRun(ctx.db, logger, {
        projectId: PROJECT_ID,
        githubRepo: REPO,
        initiatedBy: "user_owner",
      });
      if (!run.success) throw run.error;
      const body: IssueImportJobMessage = {
        type: "github.issues.import",
        runId: run.data.id,
        projectId: PROJECT_ID,
        namespace: "testns",
        slug: "widgets",
        page: 1,
        timestamp: new Date().toISOString(),
      };
      await processIssueImportMessage(ctx.env, body, logger);
      const paused = await getIssueImportRun(ctx.db, logger, run.data.id);
      if (!paused.success || !paused.data?.resume) throw new Error("expected a resume point");
      gh.requests.length = 0;
      await processIssueImportMessage(ctx.env, body, logger);
      const firstPage = `/repos/${REPO}/issues/1/comments?per_page=100&page=1`;
      expect(gh.requests).not.toContain(firstPage);
    });
  });

  it("erases the initiator of a run when their account is erased", async () => {
    const ctx = await makeEnv();
    const run = await createIssueImportRun(ctx.db, logger, {
      projectId: PROJECT_ID,
      githubRepo: REPO,
      initiatedBy: "user_writer",
    });
    if (!run.success) throw run.error;
    expect((await anonymizeUserContributions(ctx.db, "user_writer", logger)).success).toBe(true);
    const after = await getIssueImportRun(ctx.db, logger, run.data.id);
    expect(after.success && after.data?.initiatedBy).toBe(DELETED_USER_SENTINEL);
  });

  it("waits out a rate limit by re-enqueueing the same page with a delay", async () => {
    seedRepo();
    gh.rateLimitListings = 1;
    const ctx = await makeEnv();
    const { runId, outcomes } = await runImport(ctx);
    expect(outcomes).toEqual(["waiting", "completed(delayed)"]);
    const run = await getIssueImportRun(ctx.db, logger, runId);
    expect(run.success && run.data?.status).toBe("completed");
    const issues = await listIssues(ctx.db, logger, "widgets", undefined, {
      projectId: PROJECT_ID,
    });
    expect(issues.success && issues.data).toHaveLength(2);
  });

  it("ignores a redelivered page the run has already moved past", async () => {
    gh.issues = Array.from({ length: ISSUES_PER_PAGE + 1 }, (_, i) => ghIssue(i + 1));
    const ctx = await makeEnv();
    const { runId } = await runImport(ctx);
    const stale = await processIssueImportMessage(
      ctx.env,
      {
        type: "github.issues.import",
        runId,
        projectId: PROJECT_ID,
        namespace: "testns",
        slug: "widgets",
        page: 1,
        timestamp: new Date().toISOString(),
      },
      logger,
    );
    expect(stale.success && stale.data).toBe("skipped");
    expect(ctx.sent).toHaveLength(0);
  });

  it("fails the run, without retrying, when the project's source changed", async () => {
    seedRepo();
    const ctx = await makeEnv({ sourceUrl: "https://github.com/someone/else" } as ProjectEntry);
    const { runId, outcomes } = await runImport(ctx);
    expect(outcomes).toEqual(["failed"]);
    const run = await getIssueImportRun(ctx.db, logger, runId);
    expect(run.success && run.data?.message).toMatch(/source changed/);
  });

  it("stops when the repository is made private between pages", async () => {
    gh.issues = Array.from({ length: ISSUES_PER_PAGE + 3 }, (_, i) => ghIssue(i + 1));
    const ctx = await makeEnv();
    const run = await createIssueImportRun(ctx.db, logger, {
      projectId: PROJECT_ID,
      githubRepo: REPO,
      initiatedBy: "user_owner",
    });
    if (!run.success) throw new Error(run.error.message);
    const message = (page: number): IssueImportJobMessage => ({
      type: "github.issues.import",
      runId: run.data.id,
      projectId: PROJECT_ID,
      namespace: "testns",
      slug: "widgets",
      page,
      timestamp: new Date().toISOString(),
    });
    const first = await processIssueImportMessage(ctx.env, message(1), logger);
    expect(first.success && first.data).toBe("continued");

    gh.isPrivate = true;
    const second = await processIssueImportMessage(ctx.env, message(2), logger);
    expect(second.success && second.data).toBe("failed");
    const after = await getIssueImportRun(ctx.db, logger, run.data.id);
    expect(after.success && after.data?.message).toMatch(/no longer public/);
    const issues = await listIssues(ctx.db, logger, "widgets", undefined, {
      projectId: PROJECT_ID,
    });
    expect(issues.success && issues.data).toHaveLength(ISSUES_PER_PAGE);
  });

  it("fails the run when GitHub is not configured", async () => {
    seedRepo();
    const ctx = await makeEnv();
    (ctx.env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = undefined;
    const { runId } = await runImport(ctx);
    const run = await getIssueImportRun(ctx.db, logger, runId);
    expect(run.success && run.data?.status).toBe("failed");
  });

  it("fails the run when no credential may act for the project's owner", async () => {
    seedRepo();
    const ctx = await makeEnv();
    (ctx.env as { GITHUB_ALLOWED_OWNERS?: string }).GITHUB_ALLOWED_OWNERS = undefined;
    const { runId } = await runImport(ctx);
    const run = await getIssueImportRun(ctx.db, logger, runId);
    expect(run.success && run.data?.status).toBe("failed");
    expect(gh.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Queue dispatch
// ---------------------------------------------------------------------------

describe("import queue dispatch", () => {
  it("routes issue-import messages to the importer and acks them", async () => {
    gh.issues = [ghIssue(1)];
    const ctx = await makeEnv();
    const run = await createIssueImportRun(ctx.db, logger, {
      projectId: PROJECT_ID,
      githubRepo: REPO,
      initiatedBy: "user_owner",
    });
    if (!run.success) throw new Error("run");
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      body: {
        type: "github.issues.import",
        runId: run.data.id,
        projectId: PROJECT_ID,
        namespace: "testns",
        slug: "widgets",
        page: 1,
        timestamp: new Date().toISOString(),
      },
      attempts: 1,
      ack,
      retry,
    } as unknown as Message<IssueImportJobMessage>;
    await handleImportQueue(
      {
        queue: "stratum-imports",
        messages: [message],
      } as unknown as MessageBatch<IssueImportJobMessage>,
      ctx.env,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect((await issueByNumber(ctx.db, 1)).title).toBe("Issue 1");
  });

  it("rejects malformed issue-import messages", () => {
    expect(parseIssueImportMessage({ type: "github.issues.import", runId: "r" })).toBeNull();
    expect(
      parseIssueImportMessage({
        type: "github.issues.import",
        runId: "r",
        projectId: "p",
        namespace: "n",
        slug: "s",
        page: 0,
        timestamp: "t",
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The API route
// ---------------------------------------------------------------------------

describe("POST /api/projects/:ns/:slug/issues/import/github", () => {
  async function makeApp(projectOverrides: Partial<ProjectEntry> = {}) {
    const ctx = await makeEnv(projectOverrides);
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware);
    app.route("/api/projects", issueImportRouter);
    const call = (method: string, headers: Record<string, string>, form = false) =>
      app.fetch(
        new Request(`http://localhost${API}`, {
          method,
          headers: {
            ...headers,
            ...(method === "POST"
              ? {
                  "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
                }
              : {}),
          },
          ...(method === "POST" ? { body: form ? "" : "{}" } : {}),
        }),
        ctx.env,
      );
    return { ...ctx, call };
  }

  it("queues the first page for a project admin and reports the run", async () => {
    const { call, sent } = await makeApp();
    const res = await call("POST", OWNER_AUTH);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run: { id: string; status: string; githubRepo: string } };
    expect(body.run).toMatchObject({ status: "queued", githubRepo: REPO });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      type: "github.issues.import",
      page: 1,
      runId: body.run.id,
    });

    const status = await call("GET", OWNER_AUTH);
    expect(status.status).toBe(200);
    expect(((await status.json()) as { run: { id: string } }).run.id).toBe(body.run.id);
  });

  it("refuses a second import while one is active", async () => {
    const { call } = await makeApp();
    expect((await call("POST", OWNER_AUTH)).status).toBe(202);
    const again = await call("POST", OWNER_AUTH);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("active");
  });

  it("refuses private GitHub repositories", async () => {
    gh.isPrivate = true;
    const { call, sent } = await makeApp();
    const res = await call("POST", OWNER_AUTH);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("private");
    expect(sent).toHaveLength(0);
  });

  it("refuses when no GitHub credential may act for the project's owner", async () => {
    const { call, sent, env } = await makeApp();
    (env as { GITHUB_ALLOWED_OWNERS?: string }).GITHUB_ALLOWED_OWNERS = undefined;
    const res = await call("POST", OWNER_AUTH);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("not-authorized");
    expect(sent).toHaveLength(0);
  });

  it("refuses a project with no GitHub source", async () => {
    const { call } = await makeApp({ sourceUrl: undefined, sourceProvider: undefined });
    expect((await call("POST", OWNER_AUTH)).status).toBe(400);
  });

  it("refuses a project whose code import has not completed", async () => {
    const { call } = await makeApp({ importCompleted: false });
    expect((await call("POST", OWNER_AUTH)).status).toBe(409);
  });

  it("hides the route from callers who cannot administer the project", async () => {
    const { call } = await makeApp();
    expect((await call("POST", WRITER_AUTH)).status).toBe(404);
    expect((await call("POST", {})).status).toBe(401);
  });

  it("answers a form post with a redirect back to the settings page", async () => {
    const { call } = await makeApp();
    const res = await call("POST", OWNER_AUTH, true);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/testns/widgets/settings?issueImport=queued#issue-import",
    );
    expect(issueImportNotice("queued")).toMatch(/queued/);
    expect(issueImportNotice("<script>")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

describe("rewriteIssueReferences", () => {
  const map = new Map([
    [1, 10],
    [2, 11],
  ]);

  it("maps imported numbers and qualifies the rest", () => {
    expect(rewriteIssueReferences("see #1, #2 and #9", map, REPO)).toBe(
      `see #10, #11 and ${REPO}#9`,
    );
  });

  it("leaves code, cross-repo references, URL fragments and entities alone", () => {
    const text = "`#1` and\n```\n#2\n```\nother/repo#1 https://x.test/page#1 &#123; (#1)";
    expect(rewriteIssueReferences(text, map, REPO)).toBe(
      "`#1` and\n```\n#2\n```\nother/repo#1 https://x.test/page#1 &#123; (#10)",
    );
  });
});

describe("parsing GitHub responses", () => {
  it("drops back-links that are not https github.com URLs", () => {
    expect(parseGitHubIssue(ghIssue(1, { html_url: "javascript:alert(1)" }))).toBeNull();
    expect(
      parseGitHubComment({ ...ghComment(1, 1, "x"), html_url: "https://evil.example/x" }),
    ).toBeNull();
  });

  it("treats a deleted GitHub account as ghost and flags pull requests", () => {
    const parsed = parseGitHubIssue(ghIssue(5, { user: null, pull_request: { url: "u" } }));
    expect(parsed?.author).toEqual({ login: "ghost", id: null });
    expect(parsed?.isPullRequest).toBe(true);
  });

  it("caps labels and rejects malformed items", () => {
    const labels = Array.from({ length: 30 }, (_, i) => ({ name: `l${i}` }));
    expect(parseGitHubIssue(ghIssue(1, { labels }))?.labels).toHaveLength(20);
    expect(parseGitHubIssue({ number: "1" })).toBeNull();
    expect(parseGitHubIssue(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rendering imported text
// ---------------------------------------------------------------------------

describe("rendering imported issues", () => {
  it("escapes imported text and shows the GitHub author and back-link", () => {
    const html = renderToString(
      <IssueDetailPage
        project={{ name: "widgets", namespace: "testns", slug: "widgets" }}
        issue={{
          id: "iss_1",
          project: "widgets",
          number: 1,
          title: "<img src=x onerror=alert(1)>",
          body: "<script>alert('body')</script>",
          status: "open",
          authorType: "user",
          authorId: "user_owner",
          externalAuthor: "octocat",
          externalUrl: `https://github.com/${REPO}/issues/1`,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
        }}
        labels={[]}
        comments={[
          {
            id: "icm_1",
            issueId: "iss_1",
            authorType: "user",
            authorId: "user_owner",
            body: "<iframe src=//evil></iframe>",
            externalAuthor: "hubot",
            externalUrl: `https://github.com/${REPO}/issues/1#issuecomment-1`,
            createdAt: "2020-01-02T00:00:00.000Z",
          },
        ]}
        commentPage={0}
        commentsHasNext={false}
        authors={{ user_owner: "@owner" }}
        canWrite={false}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("octocat (GitHub)");
    expect(html).toContain("hubot (GitHub)");
    expect(html).toContain(`href="https://github.com/${REPO}/issues/1"`);
    // The importer is not presented as the author of someone else's issue.
    expect(html).not.toContain("by @owner");
  });

  it("renders the settings card with the last run and a no-JS form", () => {
    const html = renderToString(
      <ProjectSettingsPage
        project={{
          name: "widgets",
          namespace: "testns",
          slug: "widgets",
          createdAt: "2026-01-01T00:00:00.000Z",
        }}
        isOwner={true}
        issueImport={{
          githubRepo: REPO,
          latestRun: {
            id: "ghi_1",
            projectId: PROJECT_ID,
            githubRepo: REPO,
            status: "running",
            initiatedBy: "user_owner",
            nextPage: 2,
            issuesCreated: 25,
            issuesUpdated: 0,
            commentsImported: 40,
            pullsSkipped: 3,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          notice: "Issue import queued.",
        }}
      />,
    );
    expect(html).toContain('id="issue-import"');
    expect(html).toContain(`action="${API}"`);
    expect(html).toContain("25 created");
    expect(html).toContain("Import issues again");
    expect(html).toContain("Issue import queued.");
  });
});
