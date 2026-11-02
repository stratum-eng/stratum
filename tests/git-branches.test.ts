/**
 * Issue #181: branch listing and branch CRUD on a project remote.
 *
 * The network legs (getRemoteInfo, clone, push) are simulated against a
 * fixture; everything that decides behaviour — name validation, the existence
 * pre-check, start-point resolution through a real `readObject`, the local
 * `writeRef` a delete-push requires — runs for real against in-memory repos.
 *
 * That split is deliberate. The design's three sharpest edges are all in real
 * isomorphic-git behaviour rather than in Stratum's own logic: a fetched head
 * ref lands in `refs/remotes/origin/*` (which is why listing reads the
 * advertisement instead of a clone), `push` resolves the LOCAL ref before it
 * honours `delete`, and a non-forced push fast-forwards an existing branch
 * rather than rejecting it. A suite that mocked isomorphic-git wholesale would
 * go green against a design that does none of this correctly.
 */
import git, { type PromiseFsClient } from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Shapes of the isomorphic-git calls this suite intercepts, and of what the
 * harness records for each. Declared narrowly rather than as `any` so a
 * signature change in the real library surfaces here as a type error instead of
 * a silently mistyped assertion.
 */
interface RemoteInfoArgs {
  url: string;
}

interface CloneArgs {
  url: string;
  ref: string;
  depth?: number;
  fs: PromiseFsClient;
  dir: string;
}

interface PushArgs {
  url: string;
  ref: string;
  remoteRef?: string;
  delete?: boolean;
  force?: boolean;
  fs: PromiseFsClient;
  dir: string;
}

interface CloneCapture {
  url: string;
  ref: string;
  depth?: number;
}

interface PushCapture {
  url: string;
  ref: string;
  remoteRef?: string;
  delete: boolean;
  force: boolean;
  localOid: string;
}

interface RemoteFixture {
  branch: string;
  commits: Record<string, string>[];
  /** Extra advertised refs beyond the default branch. */
  heads?: Record<string, string>;
  tags?: Record<string, string>;
}

const h = vi.hoisted(() => ({
  servers: new Map<
    string,
    {
      branch: string;
      commits: Record<string, string>[];
      heads?: Record<string, string>;
      tags?: Record<string, string>;
    }
  >(),
  pushes: [] as PushCapture[],
  clones: [] as CloneCapture[],
  /** How the next push fails, if at all: a remote rejection or a transport
   * error. The two must not be reported the same way. */
  pushFails: null as null | "rejected" | "network",
}));

vi.mock("isomorphic-git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("isomorphic-git")>();
  const real = actual.default;

  async function seed(
    fs: PromiseFsClient,
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

  /** Nest a flat `name -> oid` map the way getRemoteInfo nests advertised refs. */
  function nest(flat: Record<string, string>): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    for (const [name, oid] of Object.entries(flat)) {
      const parts = name.split("/");
      const last = parts.pop() as string;
      let node = root;
      for (const part of parts) {
        node[part] = (node[part] as Record<string, unknown>) ?? {};
        node = node[part] as Record<string, unknown>;
      }
      node[last] = oid;
    }
    return root;
  }

  const mocked = {
    ...real,
    __seed: seed,
    getRemoteInfo: async (args: RemoteInfoArgs) => {
      const server = h.servers.get(args.url);
      if (!server) throw new Error(`NotFoundError: unknown remote ${args.url}`);
      const fs = new (await import("../src/storage/memory-fs")).MemoryFS().toNodeFS();
      const shas = await seed(fs, "/", server);
      const tip = shas[shas.length - 1] as string;
      return {
        capabilities: [],
        refs: {
          heads: nest({ [server.branch]: tip, ...(server.heads ?? {}) }),
          tags: nest(server.tags ?? {}),
        },
      };
    },
    clone: async (args: CloneArgs) => {
      h.clones.push({ url: args.url, ref: args.ref, depth: args.depth });
      const server = h.servers.get(args.url);
      if (!server) throw new Error(`NotFoundError: unknown remote ${args.url}`);
      // A real remote serves any ref it advertises, not just its default —
      // which is what lets a delete clone the branch it is removing.
      const advertisedHead = server.heads?.[args.ref];
      if (args.ref !== server.branch && advertisedHead === undefined) {
        throw new Error(`NotFoundError: Could not find ${args.ref}.`);
      }
      await seed(args.fs, args.dir, server);
      if (advertisedHead !== undefined) {
        await real.writeRef({
          fs: args.fs,
          dir: args.dir,
          ref: `refs/heads/${args.ref}`,
          value: advertisedHead,
          force: true,
        });
      }
    },
    push: async (args: PushArgs) => {
      h.pushes.push({
        url: args.url,
        ref: args.ref,
        remoteRef: args.remoteRef,
        delete: args.delete ?? false,
        force: args.force ?? false,
        // Resolve through the REAL ref store so a missing local ref fails the
        // way `_push`'s `expand` would.
        localOid: await real.resolveRef({ fs: args.fs, dir: args.dir, ref: args.ref }),
      });
      if (h.pushFails === "rejected") {
        throw new actual.Errors.PushRejectedError("not-fast-forward");
      }
      if (h.pushFails === "network") throw new Error("fetch failed");
      return { ok: true, error: null, refs: {} };
    },
  };
  return { ...actual, default: mocked };
});

import {
  MAX_BRANCHES,
  createBranchRef,
  deleteBranchRef,
  isValidBranchName,
  listRepoBranches,
  resolveBranchRef,
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
  fs: PromiseFsClient,
  dir: string,
  server: { branch: string; commits: Record<string, string>[] },
) => Promise<string[]>;
// The mock module augments isomorphic-git with a seeding helper. Naming that
// shape keeps the reach type-checked instead of casting through `any`.
type SeededGit = typeof git & { __seed: SeedFn };
const seed: SeedFn = (git as unknown as SeededGit).__seed;

/**
 * Reads one recorded call, failing with a clear message when the harness never
 * captured it — a non-null assertion would instead report a confusing
 * property-of-undefined error several lines later.
 */
function capture<T>(calls: T[], index: number): T {
  const entry = calls[index];
  if (entry === undefined) {
    throw new Error(`expected a recorded call at index ${index}, saw ${calls.length}`);
  }
  return entry;
}

const REMOTE = "https://r/p.git";

async function tipOf(server: RemoteFixture): Promise<string> {
  const fs = new MemoryFS().toNodeFS();
  const shas = await seed(fs, "/", server);
  return shas[shas.length - 1] as string;
}

beforeEach(() => {
  h.servers.clear();
  h.pushes.length = 0;
  h.clones.length = 0;
  h.pushFails = null;
});

describe("isValidBranchName", () => {
  it("accepts what git accepts, including names an allowlist would refuse", () => {
    for (const name of ["main", "release/2.x", "feature(x)", "release@prod", "版本1"]) {
      expect(isValidBranchName(name)).toBe(true);
    }
  });

  it("rejects traversal, git's reserved syntax, and HEAD", () => {
    for (const name of ["../heads/main", "a..b", "a~1", "a^1", "a:b", "a?b", "", "HEAD", "a b"]) {
      expect(isValidBranchName(name)).toBe(false);
    }
  });
});

describe("listRepoBranches", () => {
  it("lists every advertised head, including hierarchical names, sorted", async () => {
    h.servers.set(REMOTE, {
      branch: "main",
      commits: [{ "a.txt": "1\n" }],
      heads: { "release/2.x": "b".repeat(40), "zz-old": "c".repeat(40) },
    });

    const result = await listRepoBranches(REMOTE, "tok", logger, "main");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.branches.map((b) => b.name)).toEqual(["main", "release/2.x", "zz-old"]);
    expect(result.data.truncated).toBe(false);
    expect(result.data.totalBranchCount).toBe(3);
  });

  it("reports the default branch's real tip", async () => {
    const server: RemoteFixture = { branch: "trunk", commits: [{ "a.txt": "1\n" }] };
    h.servers.set(REMOTE, server);

    const result = await listRepoBranches(REMOTE, "tok", logger, "trunk");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.branches[0]).toEqual({ name: "trunk", oid: await tipOf(server) });
  });

  it("truncates without ever dropping the default branch", async () => {
    // A default branch that sorts last, so a naive head-of-list cap loses it.
    const heads: Record<string, string> = {};
    for (let i = 0; i < MAX_BRANCHES + 10; i++) {
      heads[`aa-${String(i).padStart(4, "0")}`] = "d".repeat(40);
    }
    h.servers.set(REMOTE, { branch: "zzz-default", commits: [{ "a.txt": "1\n" }], heads });

    const result = await listRepoBranches(REMOTE, "tok", logger, "zzz-default");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.totalBranchCount).toBe(MAX_BRANCHES + 11);
    expect(result.data.branches).toHaveLength(MAX_BRANCHES);
    expect(result.data.branches.map((b) => b.name)).toContain("zzz-default");
  });

  it("surfaces an advertisement failure as a typed error rather than throwing", async () => {
    const result = await listRepoBranches("https://r/missing.git", "tok", logger, "main");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatchObject({ code: "EXTERNAL_SERVICE_ERROR" });
  });
});

describe("resolveBranchRef", () => {
  beforeEach(() => {
    h.servers.set(REMOTE, {
      branch: "main",
      commits: [{ "a.txt": "1\n" }],
      heads: { "release/2.x": "b".repeat(40), v1: "e".repeat(40) },
      tags: { v1: "f".repeat(40) },
    });
  });

  it("resolves a branch that exists", async () => {
    const result = await resolveBranchRef(REMOTE, "tok", logger, "release/2.x");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ name: "release/2.x", oid: "b".repeat(40) });
  });

  it("reports an unknown ref rather than falling back to the default branch", async () => {
    const result = await resolveBranchRef(REMOTE, "tok", logger, "nope");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "not-found", name: "nope" });
  });

  it("refuses a name that is both a branch and a tag instead of silently cloning the tag", async () => {
    // isomorphic-git's refpaths checks refs/tags/<ref> BEFORE refs/heads/<ref>,
    // so resolving this would serve the tag's tree under a branch URL.
    const result = await resolveBranchRef(REMOTE, "tok", logger, "v1");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "ambiguous", name: "v1" });
  });

  it("rejects an invalid name before any network call", async () => {
    const result = await resolveBranchRef("https://r/missing.git", "tok", logger, "../heads/main");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "invalid", name: "../heads/main" });
  });
});

describe("createBranchRef", () => {
  const server: RemoteFixture = {
    branch: "main",
    commits: [{ "a.txt": "1\n" }, { "b.txt": "2\n" }],
  };

  beforeEach(() => {
    h.servers.set(REMOTE, { ...server });
  });

  it("creates a branch at the default branch tip and pushes it non-forced", async () => {
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "feature/x",
      defaultBranch: "main",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const tip = await tipOf(server);
    expect(result.data).toEqual({ name: "feature/x", oid: tip });
    expect(h.pushes).toHaveLength(1);
    expect(capture(h.pushes, 0)).toMatchObject({
      ref: "refs/heads/feature/x",
      remoteRef: "refs/heads/feature/x",
      force: false,
      delete: false,
      // The ref really exists in the local store the push was handed.
      localOid: tip,
    });
  });

  it("refuses an existing branch on the pre-check, without pushing", async () => {
    h.servers.set(REMOTE, { ...server, heads: { "feature/x": "a".repeat(40) } });

    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "feature/x",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "exists", name: "feature/x" });
    // The check is load-bearing: a non-forced push would have FAST-FORWARDED
    // this branch and reported success, silently moving someone else's ref.
    expect(h.pushes).toHaveLength(0);
  });

  it("reports a branch created between the pre-check and the push as a conflict", async () => {
    h.pushFails = "rejected";
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "feature/x",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "exists", name: "feature/x" });
  });

  it("does not report a transport failure as a name conflict", async () => {
    h.pushFails = "network";
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "feature/x",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // Telling a caller the name is taken would send them renaming a branch to
    // fix a network problem.
    expect(result.error).not.toMatchObject({ kind: "exists" });
    expect(result.error).toMatchObject({ code: "EXTERNAL_SERVICE_ERROR" });
  });

  it("creates at a full sha that is a commit in the repository", async () => {
    const fs = new MemoryFS().toNodeFS();
    const shas = await seed(fs, "/", server);
    const firstCommit = shas[0] as string;

    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "v1-maintenance",
      startPoint: firstCommit,
      defaultBranch: "main",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.oid).toBe(firstCommit);
  });

  it("pushes a sha start point from the SAME full-history clone it verified it in", async () => {
    const fs = new MemoryFS().toNodeFS();
    const shas = await seed(fs, "/", server);
    const firstCommit = shas[0] as string;

    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "v1-maintenance",
      startPoint: firstCommit,
      defaultBranch: "main",
    });
    expect(result.success).toBe(true);

    // Exactly one clone, and it carries full history. `git.push` walks the
    // local object graph from an oid the remote does not already advertise, so
    // verifying the sha against full history and then pushing from a separate
    // SHALLOW clone would pass every check here and fail at the push — on
    // precisely the old commits this option exists to branch from.
    expect(h.clones).toHaveLength(1);
    expect(capture(h.clones, 0).depth).toBeUndefined();
    expect(capture(h.pushes, 0).localOid).toBe(firstCommit);
  });

  it("uses a cheap shallow clone when the start point is an advertised tip", async () => {
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "feature/y",
      defaultBranch: "main",
    });
    expect(result.success).toBe(true);
    // The oid is already a ref tip on the remote, so the push sends a ref
    // update and no objects — full history would be paid for nothing.
    expect(h.clones).toHaveLength(1);
    expect(capture(h.clones, 0).depth).toBe(50);
  });

  it("creates at another BRANCH's name without cloning to resolve it", async () => {
    h.servers.set(REMOTE, { ...server, heads: { "release/2.x": "a".repeat(40) } });
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "from-branch",
      startPoint: "release/2.x",
      defaultBranch: "main",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.oid).toBe("a".repeat(40));
    // A branch tip is advertised by receive-pack, so the push needs no objects
    // and a shallow clone is enough.
    expect(capture(h.clones, 0).depth).toBe(50);
  });

  it("refuses a tag as a start point", async () => {
    h.servers.set(REMOTE, { ...server, tags: { "v1.0": "a".repeat(40) } });
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "from-tag",
      startPoint: "v1.0",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // A tag can point at a blob, its peeled commit is not advertised by
    // receive-pack, and it may sit outside both the default branch's history
    // and the capped tag fetch a backup makes. Branch from the sha instead.
    expect(result.error).toEqual({ kind: "bad-start-point", startPoint: "v1.0" });
  });

  it("refuses to create when the remote does not advertise the default branch", async () => {
    h.servers.set(REMOTE, { branch: "main", commits: [{ "a.txt": "1\n" }] });
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "x",
      defaultBranch: "trunk",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // A named refusal, not the 502 a clone of a ref that is not there produces.
    expect(result.error).toEqual({ kind: "no-default-branch", name: "trunk" });
    expect(h.clones).toHaveLength(0);
  });

  it("refuses a name that collides with an existing branch's ref path", async () => {
    h.servers.set(REMOTE, { ...server, heads: { "release/2.x": "a".repeat(40) } });
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "release",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // Refs are files in a directory tree: `release` cannot be both a file and
    // the directory holding `release/2.x`. Answered from the advertisement, so
    // the caller gets the colliding name instead of an opaque 502 from the push.
    expect(result.error).toEqual({
      kind: "conflicts-with",
      name: "release",
      existing: "release/2.x",
    });
    expect(h.pushes).toHaveLength(0);
  });

  it("refuses an annotated tag as a start point even though its peel is advertised", async () => {
    h.servers.set(REMOTE, {
      ...server,
      tags: { "v2.0": "1".repeat(40), "v2.0^{}": "2".repeat(40) },
    });

    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "from-annotated",
      startPoint: "v2.0",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // upload-pack advertises the peel; receive-pack does not. `git.push` would
    // therefore fail to see that the remote already holds the commit and walk
    // the local graph for it — which fails whenever it is outside the shallow
    // window. Refused rather than half-supported.
    expect(result.error).toEqual({ kind: "bad-start-point", startPoint: "v2.0" });
  });

  it("rejects a start point that is not in the repository", async () => {
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "ghost",
      startPoint: "0".repeat(40),
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "bad-start-point", startPoint: "0".repeat(40) });
    expect(h.pushes).toHaveLength(0);
  });

  it("rejects a short sha rather than guessing at history it has not fetched", async () => {
    const result = await createBranchRef(REMOTE, "tok", logger, {
      name: "short",
      startPoint: "abc1234",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "bad-start-point", startPoint: "abc1234" });
  });

  it("rejects an invalid branch name before any network call", async () => {
    const result = await createBranchRef("https://r/missing.git", "tok", logger, {
      name: "../heads/main",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "invalid-name", name: "../heads/main" });
  });
});

describe("deleteBranchRef", () => {
  const server: RemoteFixture = {
    branch: "main",
    commits: [{ "a.txt": "1\n" }],
    heads: { stale: "a".repeat(40) },
  };

  beforeEach(() => {
    h.servers.set(REMOTE, { ...server });
  });

  it("writes the local ref the delete-push requires, then deletes", async () => {
    const result = await deleteBranchRef(REMOTE, "tok", logger, {
      name: "stale",
      defaultBranch: "main",
    });
    expect(result.success).toBe(true);
    expect(h.pushes).toHaveLength(1);
    expect(capture(h.pushes, 0)).toMatchObject({
      ref: "refs/heads/stale",
      remoteRef: "refs/heads/stale",
      delete: true,
      // `_push` expands the LOCAL ref before honouring `delete`; without the
      // writeRef above, this resolution throws NotFoundError.
      localOid: "a".repeat(40),
    });
  });

  it("refuses the default branch without consulting the remote", async () => {
    const result = await deleteBranchRef("https://r/missing.git", "tok", logger, {
      name: "main",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "default-branch", name: "main" });
  });

  it("reports an unknown branch rather than pushing a no-op delete", async () => {
    const result = await deleteBranchRef(REMOTE, "tok", logger, {
      name: "never-existed",
      defaultBranch: "main",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toEqual({ kind: "not-found", name: "never-existed" });
    expect(h.pushes).toHaveLength(0);
  });
});
