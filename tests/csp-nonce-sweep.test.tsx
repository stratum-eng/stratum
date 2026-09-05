/**
 * Issue #161 sweep: with `script-src 'nonce-…'` in the CSP, every `<script>`
 * the UI renders MUST carry the per-request nonce, and no inline event-handler
 * attributes (onclick=, onsubmit=, onchange=, …) may remain anywhere — a
 * nonce'd policy blocks both un-nonced scripts and all inline handlers.
 *
 * Renders every page/component that historically shipped scripts or handlers
 * and greps the emitted HTML.
 */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";
import { ConflictResolution, type SyncConflict } from "../src/ui/components/conflict-resolution";
import { FileTree } from "../src/ui/components/file-tree";
import { ImportProgressCard } from "../src/ui/components/import-progress";
import { buildFileTree } from "../src/ui/file-tree";
import { NewProjectPage } from "../src/ui/pages/new-project";
import { RepoPage } from "../src/ui/pages/repo";
import { SyncPage } from "../src/ui/pages/sync";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));
vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

const NONCE = "sweep-test-nonce";

function scriptTags(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
}

function scriptTagsWithoutNonce(html: string, nonce: string): string[] {
  return scriptTags(html).filter((tag) => !tag.includes(`nonce="${nonce}"`));
}

function inlineHandlerAttrs(html: string): string[] {
  return [...html.matchAll(/\son[a-z]+="/g)].map((m) => m[0].trim());
}

function expectCspClean(html: string, opts: { expectScripts?: boolean } = {}): void {
  expect(scriptTagsWithoutNonce(html, NONCE)).toEqual([]);
  expect(inlineHandlerAttrs(html)).toEqual([]);
  if (opts.expectScripts) {
    expect(scriptTags(html).length).toBeGreaterThan(0);
  }
}

const user = { id: "u1", email: "a@example.com", username: "alice" };

const baseRepoProject = {
  name: "my-repo",
  namespace: "@alice",
  slug: "my-repo",
  remote: "git@stratum:alice/my-repo.git",
  createdAt: "2024-01-01T00:00:00Z",
  sourceUrl: "https://github.com/acme/api",
  sourceProvider: "github" as const,
  sourceOwner: "acme",
  sourceRepo: "api",
};

const importProgressBase = {
  namespace: "@alice",
  slug: "my-repo",
  progress: { totalFiles: 10, processedFiles: 4, currentFile: "src/a.ts" },
  logs: [{ message: "cloning", level: "info" as const, timestamp: "2024-01-01T00:00:00Z" }],
  errors: [],
  sourceUrl: "https://github.com/acme/api",
  branch: "main",
};

describe("CSP nonce sweep — pages", () => {
  it("SyncPage: scripts are nonce'd, no inline handlers remain", () => {
    const html = renderToString(
      <SyncPage
        project={{ namespace: "@alice", slug: "my-repo", name: "my-repo" }}
        syncStatus={{
          namespace: "@alice",
          slug: "my-repo",
          sourceUrl: "https://github.com/acme/api",
          sourceBranch: "main",
          lastSyncStatus: "success",
          hasUpdates: true,
          commitsBehind: 3,
          autoSyncEnabled: true,
          syncFrequency: 15,
          lastCheckedAt: "2024-01-01T00:00:00Z",
        }}
        syncHistory={[
          {
            id: "s1",
            startedAt: "2024-01-01T00:00:00Z",
            completedAt: "2024-01-01T00:00:10Z",
            status: "failed",
            commitsSynced: 0,
            error: "boom",
          },
        ]}
        user={user}
        nonce={NONCE}
      />,
    );
    expectCspClean(html, { expectScripts: true });
    // The former onsubmit/onchange targets are now wired by id.
    expect(html).toContain('id="sync-form"');
    expect(html).toContain('id="sync-settings-form"');
    expect(html).toContain('id="autoSyncEnabled"');
  });

  // The page script renders in every state — including while a sync is in
  // flight or after a failure — and must stay CSP-clean in all of them.
  for (const lastSyncStatus of ["in_progress", "failed", "idle"] as const) {
    it(`SyncPage (${lastSyncStatus}): CSP-clean`, () => {
      const html = renderToString(
        <SyncPage
          project={{ namespace: "@alice", slug: "my-repo", name: "my-repo" }}
          syncStatus={{
            namespace: "@alice",
            slug: "my-repo",
            sourceUrl: lastSyncStatus === "idle" ? "" : "https://github.com/acme/api",
            sourceBranch: "main",
            lastSyncStatus,
            lastSyncError: lastSyncStatus === "failed" ? "merge conflict" : undefined,
            hasUpdates: false,
            autoSyncEnabled: false,
            lastCheckedAt: "2024-01-01T00:00:00Z",
          }}
          syncHistory={[]}
          user={null}
          nonce={NONCE}
        />,
      );
      expectCspClean(html, { expectScripts: true });
    });
  }

  it("NewProjectPage: unified form script is nonce'd, no inline handlers remain", () => {
    const html = renderToString(<NewProjectPage user={user} nonce={NONCE} />);
    expectCspClean(html, { expectScripts: true });
    expect(html).toContain('id="new-project-form"');
  });

  it("RepoPage with files and an active import: all scripts nonce'd", () => {
    const html = renderToString(
      <RepoPage
        project={baseRepoProject}
        files={["src/index.ts", "README.md"]}
        log={[]}
        readme={null}
        user={user}
        importProgress={{ ...importProgressBase, status: "cloning" } as never}
        syncStatus={{ hasUpdates: true, commitsBehind: 2 }}
        canSync={true}
        isOwner={true}
        nonce={NONCE}
      />,
    );
    expectCspClean(html, { expectScripts: true });
  });

  it("RepoPage with a failed import (error action button): all scripts nonce'd", () => {
    const html = renderToString(
      <RepoPage
        project={baseRepoProject}
        files={["src/index.ts"]}
        log={[]}
        readme={null}
        user={user}
        importProgress={
          {
            ...importProgressBase,
            status: "failed",
            errors: [
              { file: "repo", error: "authentication failed", timestamp: "2024-01-01T00:00:00Z" },
            ],
          } as never
        }
        syncStatus={null}
        canSync={false}
        isOwner={false}
        nonce={NONCE}
      />,
    );
    expectCspClean(html, { expectScripts: true });
    // The error action opens the source URL via a data attribute, not onclick.
    expect(html).toContain('id="import-error-action"');
    expect(html).toContain('data-url="https://github.com/acme/api"');
  });
});

describe("CSP nonce sweep — components", () => {
  it("FileTree: toggle script is nonce'd, no inline onclick", () => {
    const html = renderToString(
      <FileTree
        nodes={buildFileTree(["src/index.ts", "README.md"])}
        namespace="@alice"
        slug="my-repo"
        nonce={NONCE}
      />,
    );
    expectCspClean(html, { expectScripts: true });
  });

  it("ImportProgressCard (active): SSE + cancel-confirm scripts are nonce'd", () => {
    const html = renderToString(
      <ImportProgressCard {...importProgressBase} status="processing" nonce={NONCE} />,
    );
    expectCspClean(html, { expectScripts: true });
    expect(html).toContain('id="import-cancel-form"');
  });

  it("ImportProgressCard: a namespace/slug containing </script> cannot terminate the nonce'd script", () => {
    const html = renderToString(
      <ImportProgressCard
        {...importProgressBase}
        namespace="@alice</script><script>window.pwned=1</script>"
        slug="my-repo</script><script>window.pwned=1</script>"
        status="processing"
        nonce={NONCE}
      />,
    );
    expectCspClean(html, { expectScripts: true });
    expect(html).not.toContain("</script><script>window.pwned");
    expect(html).toContain("\\u003c/script>");
  });

  // Every error classification (with and without an action button) plus the
  // terminal statuses — none may emit an un-nonced script or inline handler.
  const failureMessages = [
    "authentication failed (403)",
    "network timeout while fetching",
    "repository not found (404)",
    "rate limit exceeded (429)",
    "git clone failed",
    "key already exists",
    "disk quota exceeded",
    "something inscrutable happened",
    "",
  ];
  for (const message of failureMessages) {
    it(`ImportProgressCard (failed: ${JSON.stringify(message).slice(0, 30)}…): CSP-clean`, () => {
      const html = renderToString(
        <ImportProgressCard
          {...importProgressBase}
          status="failed"
          errors={
            message === ""
              ? []
              : [{ file: "repo", error: message, timestamp: "2024-01-01T00:00:00Z" }]
          }
          nonce={NONCE}
        />,
      );
      expectCspClean(html);
    });
  }

  it("ImportProgressCard: the error-action window.open passes noopener", () => {
    const html = renderToString(
      <ImportProgressCard
        {...importProgressBase}
        status="failed"
        // A realistic auth failure rather than the bare word "unauthorized":
        // classifyError deliberately no longer treats that token alone as an
        // auth error (it collided with ref names — see #278), and this case
        // needs a classification that renders the action button it asserts on.
        errors={[
          {
            file: "repo",
            error: "HTTP Error: 401 Unauthorized",
            timestamp: "2024-01-01T00:00:00Z",
          },
        ]}
        nonce={NONCE}
      />,
    );
    // The action button opens a repository-supplied URL. `window.open` — unlike
    // `<a target="_blank">`, which browsers treat as implicitly noopener — hands
    // the opened page a live `window.opener`, letting it navigate this
    // authenticated tab. Assert the guard is actually in the emitted script.
    expect(html).toContain("window.open");
    expect(html).toMatch(/window\.open\([^)]*['"]noopener/);
    expectCspClean(html);
  });

  for (const status of ["completed", "cancelled"] as const) {
    it(`ImportProgressCard (${status}): CSP-clean`, () => {
      const html = renderToString(
        <ImportProgressCard {...importProgressBase} status={status} nonce={NONCE} />,
      );
      expectCspClean(html);
    });
  }

  it("ConflictResolution (unresolved, with manual edit): all scripts nonce'd", () => {
    const conflict: SyncConflict = {
      id: "conf-1",
      namespace: "@alice",
      slug: "my-repo",
      sourceUrl: "https://github.com/acme/api",
      sourceBranch: "main",
      detectedAt: "2024-01-01T00:00:00Z",
      conflicts: [
        {
          path: "src/app.ts",
          ours: { content: "a", branch: "main", commit: "abc1234", timestamp: "2024-01-01" },
          theirs: { content: "b", branch: "up", commit: "def5678", timestamp: "2024-01-02" },
          base: { content: "c", commit: "0000000" },
        },
        {
          path: "src/lib.ts",
          ours: { content: "a2", branch: "main", commit: "abc1234", timestamp: "2024-01-01" },
          theirs: { content: "b2", branch: "up", commit: "def5678", timestamp: "2024-01-02" },
        },
      ],
    };
    const html = renderToString(<ConflictResolution conflict={conflict} nonce={NONCE} />);
    expectCspClean(html, { expectScripts: true });
    // Buttons are wired via data attributes now.
    expect(html).toContain('data-resolve-all="ours"');
    expect(html).toContain('data-resolve-all="theirs"');
    expect(html).toContain('id="manual-save-src_app_ts"');
  });

  it("ConflictResolution: a file path containing </script> cannot terminate the nonce'd script", () => {
    const conflict: SyncConflict = {
      id: "conf-1</script><script>window.pwned=1</script>",
      namespace: "@alice",
      slug: "my-repo",
      sourceUrl: "https://github.com/acme/api",
      sourceBranch: "main",
      detectedAt: "2024-01-01T00:00:00Z",
      conflicts: [
        {
          path: "src/</script><script>window.pwned=1</script>.ts",
          ours: { content: "a", branch: "main", commit: "abc1234", timestamp: "2024-01-01" },
          theirs: { content: "b", branch: "up", commit: "def5678", timestamp: "2024-01-02" },
        },
      ],
    };
    const html = renderToString(<ConflictResolution conflict={conflict} nonce={NONCE} />);
    // expectCspClean is the real guarantee: if the payload broke out of the
    // nonce'd script, it would inject an un-nonced <script> tag and this fails.
    expectCspClean(html, { expectScripts: true });
    expect(html).not.toContain("</script><script>window.pwned");
    // The malicious payload only ever appears escaped inside the JS string.
    expect(html).toContain("\\u003c/script>");
  });
});

describe("CSP nonce sweep — full responses", () => {
  function makeEnv(): Env {
    return {
      ARTIFACTS: { get: vi.fn(), create: vi.fn() } as unknown as Env["ARTIFACTS"],
      STATE: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
      } as unknown as KVNamespace,
      DB: {} as D1Database,
    } as unknown as Env;
  }

  /**
   * With analytics enabled, so the sweep covers the injected tags too.
   *
   * `makeEnv` supplies no `POSTHOG_PUBLIC_KEY`, which means the injector is
   * inert in every other case here — the sweep passed by luck rather than by
   * covering the analytics path.
   */
  function makeEnvWithAnalytics(): Env {
    return { ...makeEnv(), POSTHOG_PUBLIC_KEY: "phc_sweep" } as unknown as Env;
  }

  it("GET /auth/signup with analytics on: every script, injected ones included, is nonce'd", async () => {
    const res = await app.fetch(
      new Request("http://localhost/auth/signup"),
      makeEnvWithAnalytics(),
    );
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    // The injected pair must actually be present, or this asserts nothing.
    expect(html).toContain("posthog.init");
    const tags = scriptTags(html);
    expect(tags.filter((t) => !t.includes(`nonce="${nonce}"`))).toEqual([]);
    expect(inlineHandlerAttrs(html)).toEqual([]);
  });

  it("GET /auth/signup: rendered script nonce matches the CSP header nonce", async () => {
    const res = await app.fetch(new Request("http://localhost/auth/signup"), makeEnv());
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    const tags = scriptTags(html);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.filter((t) => !t.includes(`nonce="${nonce}"`))).toEqual([]);
    expect(inlineHandlerAttrs(html)).toEqual([]);
  });
});
