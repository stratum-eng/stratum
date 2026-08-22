/**
 * Issue #181: server-side git ops must honor a non-"main" default branch.
 *
 * Imported Artifacts repos keep the SOURCE repo's default branch name (the
 * import does not rename it to `main`), so every internal git op takes an
 * optional trailing branch/ref parameter. These tests drive the real
 * isomorphic-git machinery against in-memory repos whose default branch is
 * master/trunk/develop, mocking only the network legs (clone/fetch/push):
 * the "server" fixture refuses to serve a ref it does not have, exactly like
 * a real remote whose default is not `main`.
 */
import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Fake remotes keyed by URL: default branch name + one file-map per commit. */
  servers: new Map<string, { branch: string; commits: Record<string, string>[] }>(),
  calls: {
    // biome-ignore lint/suspicious/noExplicitAny: raw call capture
    clone: [] as any[],
    // biome-ignore lint/suspicious/noExplicitAny: raw call capture
    fetch: [] as any[],
    // biome-ignore lint/suspicious/noExplicitAny: raw call capture
    push: [] as any[],
  },
}));

vi.mock("isomorphic-git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("isomorphic-git")>();
  const real = actual.default;

  /** Deterministic seeding (fixed timestamps) so tests can precompute shas. */
  async function seed(
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    fs: any,
    dir: string,
    server: { branch: string; commits: Record<string, string>[] },
  ) {
    await real.init({ fs, dir, defaultBranch: server.branch });
    const shas: string[] = [];
    let t = 1700000000;
    for (const files of server.commits) {
      for (const [p, content] of Object.entries(files)) {
        await fs.promises.writeFile(dir === "/" ? `/${p}` : `${dir}/${p}`, content);
        await real.add({ fs, dir, filepath: p });
      }
      const author = { name: "Seed", email: "seed@test", timestamp: t++, timezoneOffset: 0 };
      shas.push(
        await real.commit({ fs, dir, message: `seed ${shas.length}`, author, committer: author }),
      );
    }
    return shas;
  }

  const mocked = {
    ...real,
    __seed: seed,
    // biome-ignore lint/suspicious/noExplicitAny: mock of isomorphic-git clone
    clone: async (args: any) => {
      h.calls.clone.push({
        url: args.url,
        ref: args.ref,
        depth: args.depth,
        singleBranch: args.singleBranch,
      });
      const server = h.servers.get(args.url);
      if (!server) throw new Error(`NotFoundError: unknown remote ${args.url}`);
      if (args.ref !== server.branch) {
        // Real smart-HTTP behavior: the remote has no such ref.
        throw new Error(`NotFoundError: Could not find ${args.ref}.`);
      }
      await seed(args.fs, args.dir, server);
    },
    // Simulates fetching the workspace fork: same history plus one extra commit,
    // exposed ONLY via the remote-tracking ref (no FETCH_HEAD is written, so the
    // caller must fall back to refs/remotes/<remote>/<branch> — the exact ref the
    // branch parameter controls).
    // biome-ignore lint/suspicious/noExplicitAny: mock of isomorphic-git fetch
    fetch: async (args: any) => {
      h.calls.fetch.push({ remote: args.remote, ref: args.ref });
      const { fs, dir, ref } = args;
      const tip = await real.resolveRef({ fs, dir, ref });
      await fs.promises.writeFile(
        dir === "/" ? "/ws-extra.txt" : `${dir}/ws-extra.txt`,
        "workspace change\n",
      );
      await real.add({ fs, dir, filepath: "ws-extra.txt" });
      const author = { name: "WS", email: "ws@test", timestamp: 1700000100, timezoneOffset: 0 };
      const wsSha = await real.commit({ fs, dir, message: "ws commit", author, committer: author });
      await real.writeRef({ fs, dir, ref: `refs/heads/${ref}`, value: tip, force: true });
      await real.checkout({ fs, dir, ref, force: true });
      await real.writeRef({
        fs,
        dir,
        ref: `refs/remotes/${args.remote}/${ref}`,
        value: wsSha,
        force: true,
      });
      return { defaultBranch: `refs/heads/${ref}`, fetchHead: null, fetchHeadDescription: null };
    },
    // biome-ignore lint/suspicious/noExplicitAny: mock of isomorphic-git push
    push: async (args: any) => {
      h.calls.push.push(args);
      return { ok: true, error: null, refs: {} };
    },
  };
  return { ...actual, default: mocked };
});

import {
  batchMergeStagedTrees,
  cloneRepo,
  commitAndPush,
  extractTreeObjects,
  fastForwardMerge,
  getCommitLog,
  getCommitParent,
  getDiffBetweenRepos,
  listFilesInRepo,
  mergeWorkspaceIntoProject,
  pushMain,
  readFileFromRepo,
  readRepoFiles,
  resolveConflict,
  revertToCommit,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
} as unknown as Logger;

type SeedFn = (
  // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
  fs: any,
  dir: string,
  server: { branch: string; commits: Record<string, string>[] },
) => Promise<string[]>;
// biome-ignore lint/suspicious/noExplicitAny: reach into the test mock
const seed: SeedFn = (git as any).__seed;

/** Replay the server seeding on a scratch FS to precompute deterministic shas. */
async function precomputeShas(server: { branch: string; commits: Record<string, string>[] }) {
  const fs = new MemoryFS().toNodeFS();
  return seed(fs, "/", server);
}

beforeEach(() => {
  h.servers.clear();
  h.calls.clone.length = 0;
  h.calls.fetch.length = 0;
  h.calls.push.length = 0;
});

describe("cloneRepo ref threading", () => {
  it("defaults to ref main with a shallow depth (regression)", async () => {
    h.servers.set("https://r/main.git", { branch: "main", commits: [{ "a.txt": "1\n" }] });
    const result = await cloneRepo("https://r/main.git", "tok", logger);
    expect(result.success).toBe(true);
    expect(h.calls.clone[0]).toMatchObject({ ref: "main", depth: 50, singleBranch: true });
  });

  it("passes opts.ref through (and drops depth for fullHistory)", async () => {
    h.servers.set("https://r/master.git", { branch: "master", commits: [{ "a.txt": "1\n" }] });
    const result = await cloneRepo("https://r/master.git", "tok", logger, {
      ref: "master",
      fullHistory: true,
    });
    expect(result.success).toBe(true);
    expect(h.calls.clone[0]).toMatchObject({ ref: "master", singleBranch: true });
    expect(h.calls.clone[0].depth).toBeUndefined();
  });

  it("fails against a master-default remote when the ref is left at main (the #181 hazard)", async () => {
    h.servers.set("https://r/master.git", { branch: "master", commits: [{ "a.txt": "1\n" }] });
    const result = await cloneRepo("https://r/master.git", "tok", logger);
    expect(result.success).toBe(false);
  });
});

describe("pushMain branch option", () => {
  it("defaults to pushing main", async () => {
    const fs = new MemoryFS().toNodeFS();
    const res = await pushMain("https://r/p.git", "tok", fs, "/", logger);
    expect(res.success).toBe(true);
    expect(h.calls.push[0]).toMatchObject({ ref: "main", remoteRef: "main", force: false });
  });

  it("pushes the given branch (with force)", async () => {
    const fs = new MemoryFS().toNodeFS();
    const res = await pushMain("https://r/p.git", "tok", fs, "/", logger, {
      branch: "develop",
      force: true,
    });
    expect(res.success).toBe(true);
    expect(h.calls.push[0]).toMatchObject({ ref: "develop", remoteRef: "develop", force: true });
  });
});

describe("read helpers honor the branch parameter", () => {
  const remote = "https://r/imported.git";
  beforeEach(() => {
    h.servers.set(remote, {
      branch: "master",
      commits: [{ "a.txt": "v1\n" }, { "a.txt": "v2\n", "b.txt": "b\n" }],
    });
  });

  it("readFileFromRepo reads from a master-default repo", async () => {
    const result = await readFileFromRepo(remote, "tok", "a.txt", logger, "master");
    expect(result.success && result.data).toBe("v2\n");
  });

  it("readFileFromRepo still defaults to main (and fails against master-only remotes)", async () => {
    const result = await readFileFromRepo(remote, "tok", "a.txt", logger);
    expect(result.success).toBe(false);
  });

  it("listFilesInRepo lists a master-default repo", async () => {
    const result = await listFilesInRepo(remote, "tok", logger, "master");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("readRepoFiles reads the whole tree of a master-default repo", async () => {
    const result = await readRepoFiles(remote, "tok", logger, "master");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.get("a.txt")).toBe("v2\n");
      expect(result.data.get("b.txt")).toBe("b\n");
    }
  });

  it("getCommitLog returns the log of a master-default repo", async () => {
    const result = await getCommitLog(remote, "tok", logger, 20, "master");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0]?.message).toBe("seed 1");
    }
  });

  it("getCommitParent resolves the parent commit in a master-default repo", async () => {
    const [c1, c2] = await precomputeShas(h.servers.get(remote) as never);
    const result = await getCommitParent(remote, "tok", c2 as string, logger, "master");
    expect(result.success && result.data).toBe(c1);
  });
});

describe("revertToCommit", () => {
  it("writes the revert commit onto the given branch and pushes it", async () => {
    const remote = "https://r/trunk.git";
    const server = {
      branch: "trunk",
      commits: [{ "a.txt": "v1\n" }, { "a.txt": "v2\n" }],
    };
    h.servers.set(remote, server);
    const [c1, c2] = await precomputeShas(server);

    const result = await revertToCommit(remote, "tok", c1 as string, "revert it", logger, "trunk");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pushed = h.calls.push[0];
    expect(pushed.ref).toBe("trunk");

    // Inspect the pushed repo state: refs/heads/trunk is the revert commit,
    // whose parent is the old head and whose tree is the target's tree.
    const { fs, dir } = pushed;
    const tip = await git.resolveRef({ fs, dir, ref: "refs/heads/trunk" });
    expect(tip).toBe(result.data);
    const revert = await git.readCommit({ fs, dir, oid: tip });
    expect(revert.commit.parent).toEqual([c2]);
    const target = await git.readCommit({ fs, dir, oid: c1 as string });
    expect(revert.commit.tree).toBe(target.commit.tree);
  });

  it("fails against a non-main repo when the branch is left at the default (regression of the hazard)", async () => {
    h.servers.set("https://r/trunk.git", { branch: "trunk", commits: [{ "a.txt": "v1\n" }] });
    const result = await revertToCommit(
      "https://r/trunk.git",
      "tok",
      "0".repeat(40),
      "revert",
      logger,
    );
    expect(result.success).toBe(false);
  });
});

describe("commitAndPush", () => {
  it("pushes the given branch", async () => {
    const fs = new MemoryFS().toNodeFS();
    await seed(fs, "/", { branch: "master", commits: [{ "a.txt": "v1\n" }] });
    const result = await commitAndPush(
      fs,
      "/",
      "https://r/p.git",
      "tok",
      { "b.txt": "new\n" },
      "add b",
      logger,
      undefined,
      "master",
    );
    expect(result.success).toBe(true);
    expect(h.calls.push[0].ref).toBe("master");
    if (!result.success) return;
    const tip = await git.resolveRef({ fs, dir: "/", ref: "master" });
    expect(tip).toBe(result.data);
  });
});

describe("mergeWorkspaceIntoProject", () => {
  const projectRemote = "https://r/project.git";
  const workspaceRemote = "https://r/workspace.git";

  it("merges and pushes on the shared non-main default branch", async () => {
    h.servers.set(projectRemote, { branch: "master", commits: [{ "a.txt": "v1\n" }] });

    const result = await mergeWorkspaceIntoProject(
      projectRemote,
      "ptok",
      workspaceRemote,
      "wtok",
      logger,
      { branch: "master" },
    );
    expect(result.success).toBe(true);

    // Project cloned at master, workspace fetched at master, merge pushed to master.
    expect(h.calls.clone[0].ref).toBe("master");
    expect(h.calls.fetch[0]).toMatchObject({ remote: "workspace", ref: "master" });
    expect(h.calls.push[0].ref).toBe("master");
  });

  it("squash strategy also lands on the given branch", async () => {
    h.servers.set(projectRemote, { branch: "master", commits: [{ "a.txt": "v1\n" }] });

    const result = await mergeWorkspaceIntoProject(
      projectRemote,
      "ptok",
      workspaceRemote,
      "wtok",
      logger,
      { branch: "master", strategy: "squash" },
    );
    expect(result.success).toBe(true);
    expect(h.calls.push[0].ref).toBe("master");
    if (!result.success) return;
    // The squash commit (not the workspace commit) is the new tip on master.
    const { fs, dir } = h.calls.push[0];
    const tip = await git.resolveRef({ fs, dir, ref: "master" });
    expect(tip).toBe(result.data);
    const squash = await git.readCommit({ fs, dir, oid: tip });
    expect(squash.commit.message).toContain("Squash merge workspace");
  });

  it("still defaults to main for main-default repos (regression)", async () => {
    h.servers.set(projectRemote, { branch: "main", commits: [{ "a.txt": "v1\n" }] });
    const result = await mergeWorkspaceIntoProject(
      projectRemote,
      "ptok",
      workspaceRemote,
      "wtok",
      logger,
    );
    expect(result.success).toBe(true);
    expect(h.calls.clone[0].ref).toBe("main");
    expect(h.calls.fetch[0].ref).toBe("main");
    expect(h.calls.push[0].ref).toBe("main");
  });

  it("errs against a master-default project when branch is omitted (the #181 hazard)", async () => {
    h.servers.set(projectRemote, { branch: "master", commits: [{ "a.txt": "v1\n" }] });
    const result = await mergeWorkspaceIntoProject(
      projectRemote,
      "ptok",
      workspaceRemote,
      "wtok",
      logger,
    );
    expect(result.success).toBe(false);
  });
});

describe("fastForwardMerge", () => {
  it("fast-forwards along the given branch", async () => {
    const server = {
      branch: "master",
      commits: [{ "a.txt": "v1\n" }, { "a.txt": "v2\n" }],
    };
    h.servers.set("https://r/ws.git", server);
    const [c1, c2] = await precomputeShas(server);

    const result = await fastForwardMerge(
      "https://r/project.git",
      "ptok",
      "https://r/ws.git",
      "wtok",
      c1 as string,
      logger,
      undefined,
      undefined,
      "master",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ fastForwarded: true, commit: c2 });
    expect(h.calls.clone[0].ref).toBe("master");
    expect(h.calls.push[0]).toMatchObject({ ref: "master", remoteRef: "master" });
  });
});

describe("getDiffBetweenRepos", () => {
  it("diffs two repos on a non-main shared branch (with real file contents)", async () => {
    h.servers.set("https://r/base.git", {
      branch: "trunk",
      commits: [{ "a.txt": "line1\n" }],
    });
    h.servers.set("https://r/fork.git", {
      branch: "trunk",
      commits: [{ "a.txt": "line1\nline2\n", "new.txt": "hi\n" }],
    });

    const result = await getDiffBetweenRepos(
      "https://r/base.git",
      "btok",
      "https://r/fork.git",
      "wtok",
      logger,
      "trunk",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Non-empty, real content diff — the per-file reads resolve the branch tip
    // (readBlob does not accept ref names as oids).
    expect(result.data.diff).toContain("+line2");
    expect(result.data.diff).toContain("diff --git a/new.txt b/new.txt");
    const [wsTip] = await precomputeShas({
      branch: "trunk",
      commits: [{ "a.txt": "line1\nline2\n", "new.txt": "hi\n" }],
    });
    expect(result.data.workspaceOid).toBe(wsTip);
    expect(result.data.workspaceSha).toBe(wsTip);
  });

  it("errs when either side lacks the requested branch", async () => {
    h.servers.set("https://r/base.git", { branch: "trunk", commits: [{ "a.txt": "x\n" }] });
    h.servers.set("https://r/fork.git", { branch: "trunk", commits: [{ "a.txt": "x\n" }] });
    const result = await getDiffBetweenRepos(
      "https://r/base.git",
      "btok",
      "https://r/fork.git",
      "wtok",
      logger,
    );
    expect(result.success).toBe(false);
  });
});

describe("resolveConflict", () => {
  it("manual strategy commits and pushes on the given branch", async () => {
    h.servers.set("https://r/p.git", { branch: "trunk", commits: [{ "a.txt": "v1\n" }] });
    const result = await resolveConflict(
      {
        projectRemote: "https://r/p.git",
        projectToken: "ptok",
        workspaceRemote: "https://r/w.git",
        workspaceToken: "wtok",
        strategy: "manual",
        manualResolutions: [{ file: "a.txt", content: "resolved\n" }],
        branch: "trunk",
      },
      logger,
    );
    expect(result.success).toBe(true);
    expect(h.calls.clone[0].ref).toBe("trunk");
    expect(h.calls.push[0].ref).toBe("trunk");
  });

  it("accept-project with no conflicting files resolves the branch tip", async () => {
    const server = { branch: "trunk", commits: [{ "a.txt": "v1\n" }] };
    h.servers.set("https://r/p.git", server);
    const [tip] = await precomputeShas(server);
    const result = await resolveConflict(
      {
        projectRemote: "https://r/p.git",
        projectToken: "ptok",
        workspaceRemote: "https://r/w.git",
        workspaceToken: "wtok",
        strategy: "accept-project",
        conflictingFiles: [],
        branch: "trunk",
      },
      logger,
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.commitSha).toBe(tip);
  });
});

describe("batchMergeStagedTrees", () => {
  it("merges staged trees onto the given branch and pushes it", async () => {
    const fs = new MemoryFS().toNodeFS();
    const [base] = await seed(fs, "/", { branch: "develop", commits: [{ "a.txt": "base\n" }] });

    // Build the "staged tree": a second commit's tree, extracted as loose objects.
    await fs.promises.writeFile("/a.txt", "changed\n");
    await git.add({ fs, dir: "/", filepath: "a.txt" });
    const author = { name: "W", email: "w@t", timestamp: 1700000200, timezoneOffset: 0 };
    const wsCommit = await git.commit({ fs, dir: "/", message: "ws", author, committer: author });
    const treeOid = (await git.readCommit({ fs, dir: "/", oid: wsCommit })).commit.tree;
    const objects = await extractTreeObjects(fs, "/", treeOid);

    // Rewind develop to the base so the staged tree is genuinely unmerged.
    await git.writeRef({
      fs,
      dir: "/",
      ref: "refs/heads/develop",
      value: base as string,
      force: true,
    });
    await git.checkout({ fs, dir: "/", ref: "develop", force: true });

    const result = await batchMergeStagedTrees(
      fs,
      "/",
      "https://r/p.git",
      "tok",
      [{ changeId: "chg_1", baseSha: base as string, staged: { treeOid, objects } }],
      logger,
      "develop",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.merged).toBe(true);
    expect(h.calls.push[0].ref).toBe("develop");

    const tip = await git.resolveRef({ fs, dir: "/", ref: "develop" });
    expect(tip).toBe(result.data[0]?.commit);
    expect((await git.readCommit({ fs, dir: "/", oid: tip })).commit.tree).toBe(treeOid);
  });

  it("reports nothing merged when the repo lacks the default branch it was asked for", async () => {
    const fs = new MemoryFS().toNodeFS();
    await seed(fs, "/", { branch: "develop", commits: [{ "a.txt": "base\n" }] });
    const result = await batchMergeStagedTrees(
      fs,
      "/",
      "https://r/p.git",
      "tok",
      [
        {
          changeId: "chg_1",
          baseSha: "0".repeat(40),
          staged: { treeOid: "0".repeat(40), objects: [] },
        },
      ],
      logger,
      // default branch "main" — absent in this repo
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data[0]?.merged).toBe(false);
    expect(h.calls.push).toHaveLength(0);
  });
});
