import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconstructRepo, restoreProjectRepo } from "../src/backup/repo-restore";
import {
  type BranchRefRecord,
  type RepoManifest,
  buildSnapshot,
  snapshotRepo,
  walkRepoObjects,
} from "../src/backup/repo-snapshot";
import type { NodeFS } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import type { Env, ProjectEntry } from "../src/types";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";

// Only the calls that touch Artifacts are mocked -- `push`, the clone, and the
// ref advertisement. Every other git call runs for real against MemoryFS, so
// the round trips below prove genuine ref stores rather than stubs.
const { mockPush, mockCloneRepo, mockListRepoBranches } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockCloneRepo: vi.fn(),
  mockListRepoBranches: vi.fn(),
}));

vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  return {
    ...actual,
    default: { ...actual.default, push: (args: unknown) => mockPush(args) },
  };
});

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "tok" })),
    cloneRepo: (...args: unknown[]) => mockCloneRepo(...args),
    listRepoBranches: (...args: unknown[]) => mockListRepoBranches(...args),
  };
});

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const SRC = "/src";
const author = { name: "t", email: "t@x.com", timestamp: 1_700_000_000, timezoneOffset: 0 };
const MISSING_OID = "f".repeat(40);

const project: ProjectEntry = {
  id: "p1",
  name: "repo",
  slug: "repo",
  namespace: "@owner",
  ownerId: "u1",
  ownerType: "user",
  remote: "https://acct.artifacts.cloudflare.net/git/@owner/repo.git",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** The same project, imported from a repo whose default branch is not `main`. */
const trunkProject: ProjectEntry = { ...project, sourceDefaultBranch: "trunk" };

async function buildRepo(
  commits: Record<string, string>[],
  defaultBranch = "main",
): Promise<{ fs: NodeFS; shas: string[] }> {
  const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
  await git.init({ fs, dir: SRC, defaultBranch });
  const shas: string[] = [];
  for (const files of commits) {
    for (const [path, content] of Object.entries(files)) {
      // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
      await (fs as any).promises.writeFile(`${SRC}/${path}`, content);
      await git.add({ fs, dir: SRC, filepath: path });
    }
    shas.push(await git.commit({ fs, dir: SRC, message: "c", author }));
  }
  return { fs, shas };
}

/**
 * A two-commit repo plus the snapshot a backup of it would produce, with
 * `branches` filled the way the ref advertisement fills it: the default branch
 * at the tip, and `feature/x` at the first commit — an object the HEAD walk has
 * already packed, which is the only case branch creation can produce.
 */
async function snapshotWithFeatureBranch(entry: ProjectEntry = project) {
  const branch = entry.sourceDefaultBranch ?? "main";
  const { fs, shas } = await buildRepo([{ "a.txt": "one" }, { "b.txt": "two" }], branch);
  const [c1, c2] = shas as [string, string];
  const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
  if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
  const branches: BranchRefRecord[] = [
    { name: "feature/x", oid: c1 },
    { name: branch, oid: c2 },
  ];
  return { snap: buildSnapshot(entry, walk.data, "2026-08-28T00:00:00Z", branches), c1, c2 };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("snapshotRepo branch refs", () => {
  async function clonedRepo() {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    mockCloneRepo.mockResolvedValue({ success: true, data: { fs, dir: SRC } });
    return { tipSha: shas[0] as string };
  }

  it("records the advertised branch refs in the manifest without a second clone", async () => {
    const { tipSha } = await clonedRepo();
    mockListRepoBranches.mockResolvedValue({
      success: true,
      data: {
        branches: [
          { name: "feature/x", oid: tipSha },
          { name: "main", oid: tipSha },
        ],
        truncated: false,
        totalBranchCount: 2,
      },
    });

    const result = await snapshotRepo({ ARTIFACTS: {} } as unknown as Env, project, "t0", logger);

    expect(result.success).toBe(true);
    if (!result.success || result.data.status !== "ok") throw new Error("snapshot failed");
    expect(result.data.snapshot.manifest.branches).toEqual([
      { name: "feature/x", oid: tipSha },
      { name: "main", oid: tipSha },
    ]);
    // One advertisement, told which branch must survive truncation…
    expect(mockListRepoBranches).toHaveBeenCalledTimes(1);
    expect(mockListRepoBranches.mock.calls[0]?.slice(0, 4)).toEqual([
      project.remote,
      "tok",
      logger,
      "main",
    ]);
    // …and exactly one clone, with its option set unchanged: capturing branches
    // must not have grown a fetch of its own.
    expect(mockCloneRepo).toHaveBeenCalledTimes(1);
    expect(mockCloneRepo.mock.calls[0]?.[3]).toEqual({
      fullHistory: true,
      ref: "main",
      includeTags: true,
      timeoutMs: 300_000,
    });
  });

  it("still produces a snapshot when the ref advertisement fails", async () => {
    const { tipSha } = await clonedRepo();
    mockListRepoBranches.mockResolvedValue({
      success: false,
      error: new AppError("Failed to read remote refs", "GIT_ERROR", 502),
    });

    const result = await snapshotRepo({ ARTIFACTS: {} } as unknown as Env, project, "t0", logger);

    expect(result.success).toBe(true);
    if (!result.success || result.data.status !== "ok") throw new Error("snapshot failed");
    // The pack is the valuable part and is intact. The manifest carries NO
    // `branches` key: an empty array would positively assert "this repository
    // has no branches", which a failed advertisement cannot support and which a
    // reader could not tell apart from a genuine zero-branch repo.
    expect(result.data.snapshot.manifest.tipSha).toBe(tipSha);
    expect(result.data.snapshot.manifest).not.toHaveProperty("branches");
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to list branches for snapshot; backing up without branch refs",
      expect.objectContaining({ projectId: project.id }),
    );
  });

  it("records an empty branches list when the remote genuinely advertises none", async () => {
    await clonedRepo();
    mockListRepoBranches.mockResolvedValue({
      success: true,
      data: { branches: [], truncated: false, totalBranchCount: 0 },
    });

    const result = await snapshotRepo({ ARTIFACTS: {} } as unknown as Env, project, "t0", logger);
    expect(result.success).toBe(true);
    if (!result.success || result.data.status !== "ok") throw new Error("snapshot failed");
    // Present and empty — distinguishable from the failure case above.
    expect(result.data.snapshot.manifest.branches).toEqual([]);
  });

  it("records the true branch total when the listing was capped", async () => {
    await clonedRepo();
    mockListRepoBranches.mockResolvedValue({
      success: true,
      data: {
        branches: [{ name: "feature/x", oid: "a".repeat(40) }],
        truncated: true,
        totalBranchCount: 250,
      },
    });

    const result = await snapshotRepo({ ARTIFACTS: {} } as unknown as Env, project, "t0", logger);
    expect(result.success).toBe(true);
    if (!result.success || result.data.status !== "ok") throw new Error("snapshot failed");
    // Without this an operator cannot tell a restore recreated 200 of 250
    // branches — the quiet lossiness the field exists to prevent.
    expect(result.data.snapshot.manifest.branchesTruncatedTotal).toBe(250);
    expect(logger.warn).toHaveBeenCalledWith(
      "Snapshot records only part of this repo's branches (listing cap reached)",
      expect.objectContaining({ projectId: project.id, totalBranchCount: 250 }),
    );
  });
});

describe("reconstructRepo branch refs", () => {
  it("reproduces a non-default branch on the round trip", async () => {
    const { snap, c1, c2 } = await snapshotWithFeatureBranch();

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);

    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) throw new Error(rebuilt.error.message);
    const { fs: rfs, dir } = rebuilt.data;
    expect(await git.resolveRef({ fs: rfs, dir, ref: "refs/heads/feature/x" })).toBe(c1);
    expect(await git.resolveRef({ fs: rfs, dir, ref: "refs/heads/main" })).toBe(c2);
    // The default branch is not reported as a written branch ref: the verified
    // tip write owns it.
    expect(rebuilt.data.branches).toEqual(["feature/x"]);
  });

  it("restores a pre-change manifest with no branches key exactly as before", async () => {
    const { snap, c2 } = await snapshotWithFeatureBranch();
    // A JSON round trip is how a stored manifest comes back; deleting the key
    // reproduces one written before branch support existed.
    const legacy = JSON.parse(JSON.stringify(snap.manifest)) as RepoManifest;
    // biome-ignore lint/performance/noDelete: constructing the legacy shape exactly
    delete legacy.branches;

    const rebuilt = await reconstructRepo(snap.pack, legacy, logger);

    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) throw new Error(rebuilt.error.message);
    expect(rebuilt.data.branches).toEqual([]);
    expect(await git.resolveRef({ fs: rebuilt.data.fs, dir: rebuilt.data.dir, ref: "main" })).toBe(
      c2,
    );
    expect(await git.listBranches({ fs: rebuilt.data.fs, dir: rebuilt.data.dir })).toEqual([
      "main",
    ]);
  });

  // The manifest is untrusted input: its names are interpolated into
  // `refs/heads/<name>` and written with force:true — the very namespace a
  // traversing name is aiming at.
  it.each([
    ["path traversal into refs/heads", "../heads/main"],
    ["parent-dir segment", "feature/../../heads/main"],
    ["empty name", ""],
    ["a space", "feature x"],
    ["a control character", "feature\u0000evil"],
    ["reflog syntax", "feature@{0}"],
    ["lock suffix", "feature.lock"],
  ])("skips a manifest branch name with %s", async (_label, branchName) => {
    const { snap, c1, c2 } = await snapshotWithFeatureBranch();
    // A real, present object id: only the NAME is hostile here.
    snap.manifest.branches = [{ name: branchName, oid: c1 }];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);

    // Skipped, not fatal: the tip still restores.
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) throw new Error(rebuilt.error.message);
    expect(rebuilt.data.branches).toEqual([]);
    expect(
      await git.resolveRef({ fs: rebuilt.data.fs, dir: rebuilt.data.dir, ref: "refs/heads/main" }),
    ).toBe(c2);
    expect(await git.listBranches({ fs: rebuilt.data.fs, dir: rebuilt.data.dir })).toEqual([
      "main",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Restore: skipping branch with an invalid name in manifest",
      { name: branchName },
    );
  });

  it("does not let a stale manifest entry for the default branch overwrite the verified tip", async () => {
    const { snap, c1, c2 } = await snapshotWithFeatureBranch();
    // A manifest whose `main` entry is one commit behind the verified tip —
    // what a branch that moved between the advertisement and the pack walk
    // would leave behind.
    snap.manifest.branches = [{ name: "main", oid: c1 }];
    expect(snap.manifest.tipSha).toBe(c2);

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);

    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) throw new Error(rebuilt.error.message);
    expect(
      await git.resolveRef({ fs: rebuilt.data.fs, dir: rebuilt.data.dir, ref: "refs/heads/main" }),
    ).toBe(snap.manifest.tipSha);
    expect(rebuilt.data.branches).toEqual([]);
  });

  it("holds back the project's default branch even when the tip is restored under another name", async () => {
    // `reconstructRepo`'s `branch` argument and the project's default branch
    // are separate inputs; a manifest entry naming either must not be written.
    const { snap, c1, c2 } = await snapshotWithFeatureBranch(trunkProject);
    snap.manifest.branches = [
      { name: "trunk", oid: c1 },
      { name: "feature/x", oid: c1 },
    ];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger, "trunk");

    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) throw new Error(rebuilt.error.message);
    expect(rebuilt.data.branches).toEqual(["feature/x"]);
    expect(
      await git.resolveRef({ fs: rebuilt.data.fs, dir: rebuilt.data.dir, ref: "refs/heads/trunk" }),
    ).toBe(c2);
  });

  it("skips (with a warning) a branch whose tip is absent from the restored objects", async () => {
    const { snap } = await snapshotWithFeatureBranch();
    snap.manifest.branches = [{ name: "ghost", oid: MISSING_OID }];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);

    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) throw new Error(rebuilt.error.message);
    expect(rebuilt.data.branches).toEqual([]);
    // Not written dangling: the ref is absent, not present-and-unresolvable.
    expect(await git.listBranches({ fs: rebuilt.data.fs, dir: rebuilt.data.dir })).toEqual([
      "main",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Restore: skipping branch whose tip is absent from the restored objects",
      { name: "ghost", oid: MISSING_OID },
    );
  });

  it("skips a branch whose tip is present but is not a commit", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    const commit = await git.readCommit({ fs, dir: SRC, oid: shas[0] as string });
    // A tree oid: present in the pack, but a branch pointing at it is a branch
    // no client can check out, and the push would fail with ObjectTypeError
    // after main and every tag had already landed.
    snap.manifest.branches = [{ name: "bad", oid: commit.commit.tree }];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;
    expect(rebuilt.data.branches).not.toContain("bad");
  });

  it("skips a branch whose ref path collides with one already written, keeping the rest", async () => {
    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    // `refs/heads/main` is already a file, so `refs/heads/main/x` cannot also be
    // a directory. An unguarded writeRef throws ENOTDIR and the outer catch
    // withholds the tip and every tag over one unusable ref.
    snap.manifest.branches = [
      { name: "main/x", oid: snap.manifest.tipSha },
      { name: "fine", oid: snap.manifest.tipSha },
    ];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;
    expect(rebuilt.data.branches).toEqual(["fine"]);
    expect(await git.resolveRef({ fs: rebuilt.data.fs, dir: rebuilt.data.dir, ref: "main" })).toBe(
      snap.manifest.tipSha,
    );
  });

  it("refuses a manifest branch named HEAD, which the tag guard alone allows", async () => {
    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    snap.manifest.branches = [{ name: "HEAD", oid: snap.manifest.tipSha }];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;
    // The untrusted-input path must not be one guard weaker than the request
    // path, which refuses HEAD as a branch name.
    expect(rebuilt.data.branches).toEqual([]);
  });
});

describe("restoreProjectRepo branch push", () => {
  function makeEnv(deleteFn = vi.fn(async () => true)): { env: Env; deleteFn: typeof deleteFn } {
    const env = {
      ARTIFACTS: {
        get: vi.fn(async () => null),
        create: vi.fn(async () => ({ name: "repo", remote: project.remote, token: "tok" })),
        delete: deleteFn,
      } as unknown as Env["ARTIFACTS"],
    } as Env;
    return { env, deleteFn };
  }

  /** A pre-existing repo: a forced restore over it is deliberately not rolled back. */
  function makeExistingEnv(deleteFn = vi.fn(async () => true)) {
    const env = {
      ARTIFACTS: {
        get: vi.fn(async () => ({
          name: "repo",
          remote: project.remote,
          createToken: vi.fn(async () => ({ plaintext: "tok" })),
        })),
        create: vi.fn(),
        delete: deleteFn,
      } as unknown as Env["ARTIFACTS"],
    } as Env;
    return { env, deleteFn };
  }

  const pushedRefs = (): string[] => mockPush.mock.calls.map((c) => (c[0] as { ref: string }).ref);

  it("authenticates the branch push the way Artifacts requires, not the way GitHub does", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const { env } = makeEnv();
    const { snap } = await snapshotWithFeatureBranch();
    // An Artifacts token carries an expiry suffix that must be stripped before
    // it is used as a password.
    const artifactsToken = "secret123?expires=1799999999";
    env.ARTIFACTS.create = vi.fn(async () => ({
      name: "repo",
      remote: project.remote,
      token: artifactsToken,
    })) as unknown as Env["ARTIFACTS"]["create"];

    const result = await restoreProjectRepo(env, snap, {}, logger);
    expect(result.success).toBe(true);

    const branchPush = mockPush.mock.calls
      .map(
        (call) => call[0] as { ref: string; onAuth: () => { username: string; password: string } },
      )
      .find((args) => args.ref === "refs/heads/feature/x");
    expect(branchPush).toBeDefined();
    // The GitHub helper would send the whole string as the password and the
    // remote would refuse it — failing every restore that carries a branch,
    // after main and the tags had already landed.
    expect(branchPush?.onAuth()).toEqual({ username: "x", password: "secret123" });
  });

  it("pushes main first, then each branch ref", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const { env } = makeEnv();
    const { snap } = await snapshotWithFeatureBranch();

    const result = await restoreProjectRepo(env, snap, {}, logger);

    expect(result.success).toBe(true);
    expect(pushedRefs()).toEqual(["main", "refs/heads/feature/x"]);
    // Pushed to the same ref it holds locally, and not forced onto a repo this
    // restore just created.
    const branchPush = mockPush.mock.calls[1]?.[0] as { remoteRef: string; force: boolean };
    expect(branchPush.remoteRef).toBe("refs/heads/feature/x");
    expect(branchPush.force).toBe(false);
  });

  it("pushes only main for a pre-change manifest without branches", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const { env } = makeEnv();
    const { snap } = await snapshotWithFeatureBranch();
    const legacy = JSON.parse(JSON.stringify(snap.manifest)) as RepoManifest;
    // biome-ignore lint/performance/noDelete: constructing the legacy shape exactly
    delete legacy.branches;

    const result = await restoreProjectRepo(env, { pack: snap.pack, manifest: legacy }, {}, logger);

    expect(result.success).toBe(true);
    expect(pushedRefs()).toEqual(["main"]);
  });

  it("never pushes a branch that reconstruction skipped", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const { env } = makeEnv();
    const { snap, c1 } = await snapshotWithFeatureBranch();
    snap.manifest.branches = [
      { name: "ghost", oid: MISSING_OID },
      { name: "feature/x", oid: c1 },
    ];

    const result = await restoreProjectRepo(env, snap, {}, logger);

    expect(result.success).toBe(true);
    expect(pushedRefs()).toEqual(["main", "refs/heads/feature/x"]);
  });

  it("reports how many branches landed when a forced restore fails mid-list", async () => {
    // main ok, first branch ok, second branch fails -> 1 of 2 branches pushed.
    mockPush
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("branch rejected"));
    const { env, deleteFn } = makeExistingEnv();
    const { snap, c1 } = await snapshotWithFeatureBranch();
    snap.manifest.branches = [
      { name: "feature/x", oid: c1 },
      { name: "feature/y", oid: c1 },
    ];

    const result = await restoreProjectRepo(env, snap, { force: true }, logger);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.message).toContain("1/2 branches pushed");
    // A pre-existing repo is never deleted by the rollback path.
    expect(deleteFn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Forced restore left partial state on an existing repo",
      undefined,
      expect.objectContaining({ mainPushed: true, branchCount: 2 }),
    );
  });

  it("rolls back a freshly created repo when a branch push fails", async () => {
    mockPush.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("nope"));
    const { env, deleteFn } = makeEnv();
    const { snap } = await snapshotWithFeatureBranch();

    const result = await restoreProjectRepo(env, snap, {}, logger);

    expect(result.success).toBe(false);
    expect(deleteFn).toHaveBeenCalledWith("repo");
  });
});
