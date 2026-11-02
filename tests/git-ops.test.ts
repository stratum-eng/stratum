import git, { Errors as GitErrors } from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObject, commitObject, treeObject } from "../src/storage/git-objects";
import {
  type DeepenFetch,
  MergeConflictError,
  type NodeFS,
  artifactsRepoNameFromRemote,
  buildUnifiedDiff,
  cloneRepo,
  extractTokenSecret,
  freshRepoToken,
  getDiffBetweenRepos,
  mergeWorkspaceIntoProject,
  pushBranchToRemote,
  pushMain,
  pushTags,
  readRepoFiles,
  readTreeAtCommit,
  readTreeAtCommitWithDeepening,
  scanForSubmoduleContent,
  submoduleUnsupportedError,
  walkDir,
  withTimeout,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { type FsLike, placeLooseObject } from "../src/storage/object-loader";
import type { ArtifactsNamespace } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { ok } from "../src/utils/result";

// Mock only the git functions the merge path drives over the network; keep the
// real Errors classes so classification is exercised against the genuine shapes.
vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      clone: vi.fn(),
      addRemote: vi.fn(),
      fetch: vi.fn(),
      getRemoteInfo: vi.fn(),
      resolveRef: vi.fn(),
      merge: vi.fn(),
      push: vi.fn(),
    },
  };
});

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as unknown as Logger;

describe("extractTokenSecret", () => {
  it("returns full token when no expiry suffix", () => {
    expect(extractTokenSecret("art_v1_abc123")).toBe("art_v1_abc123");
  });

  it("strips ?expires= suffix", () => {
    expect(extractTokenSecret("art_v1_abc123?expires=1234567890")).toBe("art_v1_abc123");
  });

  it("handles empty string", () => {
    expect(extractTokenSecret("")).toBe("");
  });

  it("returns base when multiple ?expires= present (only first split)", () => {
    expect(extractTokenSecret("base?expires=111?expires=222")).toBe("base");
  });
});

describe("artifactsRepoNameFromRemote", () => {
  it("extracts the repo name from a standard Artifacts remote", () => {
    expect(
      artifactsRepoNameFromRemote(
        "https://acct.artifacts.cloudflare.net/git/stratum-prod/octocat__hello-world.git",
      ),
    ).toBe("octocat__hello-world");
  });

  it("handles a remote without the .git suffix", () => {
    expect(
      artifactsRepoNameFromRemote(
        "https://acct.artifacts.cloudflare.net/git/stratum-prod/octocat__hello-world",
      ),
    ).toBe("octocat__hello-world");
  });

  it("returns null for a non-Artifacts remote", () => {
    expect(artifactsRepoNameFromRemote("https://github.com/owner/repo.git")).toBeNull();
  });

  it("returns null for a non-Artifacts host even with an Artifacts-shaped path", () => {
    // Guards against minting a real Artifacts token for a remote we don't control.
    expect(
      artifactsRepoNameFromRemote("https://evil.example.com/git/stratum-prod/owner__repo.git"),
    ).toBeNull();
  });

  it("returns null for a non-HTTPS Artifacts remote", () => {
    expect(
      artifactsRepoNameFromRemote("http://acct.artifacts.cloudflare.net/git/ns/owner__repo.git"),
    ).toBeNull();
  });

  it("rejects a host that merely contains the Artifacts domain as a prefix", () => {
    expect(
      artifactsRepoNameFromRemote(
        "https://acct.artifacts.cloudflare.net.evil.com/git/ns/owner__repo.git",
      ),
    ).toBeNull();
  });
});

describe("freshRepoToken", () => {
  const remote = "https://acct.artifacts.cloudflare.net/git/stratum-prod/owner__repo.git";

  it("mints a fresh token scoped to the operation", async () => {
    const createToken = vi.fn().mockResolvedValue({ plaintext: "fresh_token", expiresAt: 999 });
    const get = vi.fn().mockResolvedValue({ createToken });
    const artifacts = { get } as unknown as ArtifactsNamespace;

    const result = await freshRepoToken(artifacts, remote, "read", noopLogger);

    expect(result.success && result.data).toBe("fresh_token");
    expect(get).toHaveBeenCalledWith("owner__repo");
    expect(createToken).toHaveBeenCalledWith("read", 3600);
  });

  it("requests a write-scoped token when asked", async () => {
    const createToken = vi.fn().mockResolvedValue({ plaintext: "w", expiresAt: 1 });
    const artifacts = {
      get: vi.fn().mockResolvedValue({ createToken }),
    } as unknown as ArtifactsNamespace;

    await freshRepoToken(artifacts, remote, "write", noopLogger);

    expect(createToken).toHaveBeenCalledWith("write", 3600);
  });

  it("returns an error when minting fails", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    const artifacts = { get } as unknown as ArtifactsNamespace;

    const result = await freshRepoToken(artifacts, remote, "read", noopLogger);

    expect(result.success).toBe(false);
  });

  it("returns an error when the remote is unrecognised", async () => {
    const get = vi.fn();
    const artifacts = { get } as unknown as ArtifactsNamespace;

    const result = await freshRepoToken(
      artifacts,
      "https://github.com/owner/repo.git",
      "read",
      noopLogger,
    );

    expect(result.success).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("MemoryFS walkDir (via manual test)", () => {
  it("lists files recursively excluding .git", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/.git/HEAD", "ref: refs/heads/main");
    await fs.promises.writeFile("/src/index.ts", "export {}");
    await fs.promises.writeFile("/src/utils/helpers.ts", "export {}");
    await fs.promises.writeFile("/README.md", "# Hello");

    const result = await walkDir(fs.toNodeFS(), "/", "", noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toContain("src/index.ts");
    expect(result.data).toContain("src/utils/helpers.ts");
    expect(result.data).toContain("README.md");
    expect(result.data.some((f) => f.startsWith(".git"))).toBe(false);
  });

  it("lists symlinks as leaf entries without recursing or failing on dangling links", async () => {
    const fs = new MemoryFS();
    await fs.promises.writeFile("/src/index.ts", "export {}");
    await fs.promises.symlink("index.ts", "/src/alias.ts");
    await fs.promises.symlink("missing.ts", "/src/dangling.ts");
    await fs.promises.symlink("/src", "/srclink");

    const result = await walkDir(fs.toNodeFS(), "/", "", noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toContain("src/index.ts");
    expect(result.data).toContain("src/alias.ts");
    expect(result.data).toContain("src/dangling.ts");
    // A symlink to a directory is a leaf, never recursed into.
    expect(result.data).toContain("srclink");
    expect(result.data.some((f) => f.startsWith("srclink/"))).toBe(false);
  });
});

describe("commitAndPush path construction", () => {
  it("writeFile path is correct when dir has trailing slash", async () => {
    const fs = new MemoryFS();
    const base = "/";
    const path = "src/index.ts";
    const fullPath = `${base.endsWith("/") ? base : `${base}/`}${path}`;
    const writeResult = await fs.writeFile(fullPath, "content");
    expect(writeResult.success).toBe(true);
    const result = await fs.readFile("/src/index.ts", { encoding: "utf8" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("content");
    }
  });

  it("writeFile path is correct when dir has no trailing slash", async () => {
    const fs = new MemoryFS();
    const base = "/repo";
    const path = "src/index.ts";
    const fullPath = `${base.endsWith("/") ? base : `${base}/`}${path}`;
    const writeResult = await fs.writeFile(fullPath, "content");
    expect(writeResult.success).toBe(true);
    const result = await fs.readFile("/repo/src/index.ts", { encoding: "utf8" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("content");
    }
  });
});

describe("buildUnifiedDiff", () => {
  it("emits a real hunk for a one-line edit in a large file", () => {
    const base = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
    const changed = [...base];
    changed[59] = "line 60 changed";

    const diff = buildUnifiedDiff(
      new Map([["src/large.ts", `${base.join("\n")}\n`]]),
      new Map([["src/large.ts", `${changed.join("\n")}\n`]]),
    );

    expect(diff).toContain("diff --git a/src/large.ts b/src/large.ts");
    expect(diff).toContain("@@");
    expect(diff).toContain("-line 60");
    expect(diff).toContain("+line 60 changed");
    expect(diff).not.toContain("-line 1\n-line 2\n-line 3");
  });

  it("preserves new-file and deleted-file diffs", () => {
    const diff = buildUnifiedDiff(
      new Map([["src/old.ts", "export const old = true;\n"]]),
      new Map([["src/new.ts", "export const fresh = true;\n"]]),
    );

    expect(diff).toContain("diff --git a/src/new.ts b/src/new.ts");
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("+export const fresh = true;");
    expect(diff).toContain("diff --git a/src/old.ts b/src/old.ts");
    expect(diff).toContain("deleted file mode 100644");
    expect(diff).toContain("-export const old = true;");
  });

  it("does not rewrite a deleted `-- ` comment line into a file header", () => {
    // The header fix-up used to run over the whole patch body by prefix. A
    // deleted "-- note" line reaches it as "--- note" and came back out as
    // "--- a/<path>", so the reviewer saw the path where the SQL comment was.
    const base = "CREATE TABLE t (id TEXT);\n-- legacy note\nSELECT 1;\n";
    const changed = "CREATE TABLE t (id TEXT);\nSELECT 1;\n";

    const diff = buildUnifiedDiff(
      new Map([["migrations/001.sql", base]]),
      new Map([["migrations/001.sql", changed]]),
    );

    expect(diff).toContain("--- legacy note");
    // Exactly one header pair survives: the one the fix-up writes by position.
    expect(diff.split("\n").filter((line) => line.startsWith("--- "))).toEqual([
      "--- a/migrations/001.sql",
      "--- legacy note",
    ]);
  });

  it("does not rewrite an added `++ ` line into a file header", () => {
    const diff = buildUnifiedDiff(
      new Map([["notes.md", "intro\noutro\n"]]),
      new Map([["notes.md", "intro\n++ bonus point\noutro\n"]]),
    );

    expect(diff).toContain("+++ bonus point");
    expect(diff.split("\n").filter((line) => line.startsWith("+++ "))).toEqual([
      "+++ b/notes.md",
      "+++ bonus point",
    ]);
  });
});

describe("readTreeAtCommit", () => {
  async function makeRepo() {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const dir = "/";
    await git.init({ fs, dir, defaultBranch: "main" });

    const author = { name: "Test", email: "test@example.com" };
    await fs.promises.writeFile("/package.json", '{"name":"app"}');
    await fs.promises.mkdir("/src");
    await fs.promises.writeFile("/src/math.ts", "export const add = 1;");
    await git.add({ fs, dir, filepath: ["package.json", "src/math.ts"] });
    const first = await git.commit({ fs, dir, message: "first", author });

    await fs.promises.writeFile("/src/math.ts", "export const add = 2;");
    await fs.promises.writeFile("/src/new.ts", "export const fresh = true;");
    await git.add({ fs, dir, filepath: ["src/math.ts", "src/new.ts"] });
    const second = await git.commit({ fs, dir, message: "second", author });

    return { fs, first, second };
  }

  it("reads the full file set of the pinned commit, not the current HEAD", async () => {
    const { fs, first } = await makeRepo();
    const result = await readTreeAtCommit(fs, "/", first, noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect([...result.data.keys()].sort()).toEqual(["package.json", "src/math.ts"]);
    expect(new TextDecoder().decode(result.data.get("src/math.ts"))).toBe("export const add = 1;");
  });

  it("reads the later commit's tree including files it added", async () => {
    const { fs, second } = await makeRepo();
    const result = await readTreeAtCommit(fs, "/", second, noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect([...result.data.keys()].sort()).toEqual(["package.json", "src/math.ts", "src/new.ts"]);
    expect(new TextDecoder().decode(result.data.get("src/math.ts"))).toBe("export const add = 2;");
  });

  it("carries a binary blob's bytes through byte-for-byte, not UTF-8 decoded", async () => {
    // 00 80 C0 AF FF is not valid UTF-8 (0x80 is a stray continuation byte,
    // 0xC0 0xAF is an overlong encoding, 0xFF is never valid) — a TextDecoder
    // would replace it with U+FFFD and the original bytes would be lost.
    const { fs } = await makeRepo();
    const dir = "/";
    const binaryBytes = new Uint8Array([0x00, 0x80, 0xc0, 0xaf, 0xff]);
    const blobOid = await git.writeBlob({ fs, dir, blob: binaryBytes });
    const treeOid = await git.writeTree({
      fs,
      dir,
      tree: [{ mode: "100644", path: "binary.dat", oid: blobOid, type: "blob" }],
    });
    const author = { name: "Test", email: "test@example.com", timestamp: 0, timezoneOffset: 0 };
    const commit = await git.writeCommit({
      fs,
      dir,
      commit: { tree: treeOid, parent: [], author, committer: author, message: "binary file" },
    });

    const result = await readTreeAtCommit(fs, dir, commit, noopLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.get("binary.dat")).toEqual(binaryBytes);
  });

  it("fails closed when a blob in the pinned tree cannot be read", async () => {
    const { fs } = await makeRepo();
    const dir = "/";
    const goodBlob = await git.writeBlob({
      fs,
      dir,
      blob: new TextEncoder().encode("still readable"),
    });
    const treeOid = await git.writeTree({
      fs,
      dir,
      tree: [
        { mode: "100644", path: "good.txt", oid: goodBlob, type: "blob" },
        // A dangling oid: listed in the tree but the object does not exist.
        {
          mode: "100644",
          path: "missing.txt",
          oid: "0123456789abcdef0123456789abcdef01234567",
          type: "blob",
        },
      ],
    });
    const author = { name: "Test", email: "test@example.com", timestamp: 0, timezoneOffset: 0 };
    const commit = await git.writeCommit({
      fs,
      dir,
      commit: { tree: treeOid, parent: [], author, committer: author, message: "broken tree" },
    });

    const result = await readTreeAtCommit(fs, dir, commit, noopLogger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(`Failed to read tree at commit ${commit}`);
    expect(result.error.message).toContain("missing.txt");
  });

  it("errors when the pinned commit is not present in the clone", async () => {
    const { fs } = await makeRepo();
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const result = await readTreeAtCommit(fs, "/", missing, noopLogger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(`Failed to read tree at commit ${missing}`);
  });

  it("fails closed once the running total exceeds the byte cap, without reading the rest of the tree (#333)", async () => {
    const { fs, first } = await makeRepo();
    const dir = "/";
    // package.json (14 bytes) + src/math.ts (22 bytes) already exist on
    // `first`; a cap smaller than their combined size trips on the second
    // file without needing a large fixture.
    const result = await readTreeAtCommit(fs, dir, first, noopLogger, 20);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(`Commit ${first}'s tree exceeds the 20-byte`);
  });

  it("succeeds when the tree fits within the byte cap", async () => {
    const { fs, first } = await makeRepo();
    const dir = "/";
    const result = await readTreeAtCommit(fs, dir, first, noopLogger, 1_000_000);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect([...result.data.keys()].sort()).toEqual(["package.json", "src/math.ts"]);
  });
});

// Shared fixture helpers for #246's deepening tests below (both the pure
// `readTreeAtCommitWithDeepening` algorithm and the `readRepoFiles` wiring
// that drives it in production).
const DEEPEN_TEST_DIR = "/";
const DEEPEN_TEST_GITDIR = "/.git";

/** One commit in a simple linear chain: a single `<label>.txt` file, real
 * blob/tree/commit objects (same encoding isomorphic-git itself produces —
 * see git-objects.ts), not yet placed on any filesystem. */
async function makeDeepeningTestCommit(
  label: string,
  parentOid: string | undefined,
  timestamp: number,
) {
  const blob = await blobObject(new TextEncoder().encode(`${label}\n`));
  const tree = await treeObject([{ mode: "100644", name: `${label}.txt`, oid: blob.oid }]);
  const commit = await commitObject({
    tree: tree.oid,
    parents: parentOid ? [parentOid] : [],
    message: label,
    timestamp,
  });
  return { blob, tree, commit };
}

async function placeDeepeningTestObjects(fs: NodeFS, objs: { oid: string; bytes: Uint8Array }[]) {
  for (const o of objs) {
    await placeLooseObject(fs as unknown as FsLike, DEEPEN_TEST_GITDIR, o.oid, o.bytes);
  }
}

async function setDeepeningTestMainTip(fs: NodeFS, tipOid: string) {
  await git.writeRef({
    fs,
    dir: DEEPEN_TEST_DIR,
    ref: "refs/heads/main",
    value: tipOid,
    force: true,
  });
}

/** Marks `oids` as the local repo's shallow boundary — what a real shallow
 * clone/fetch leaves in `.git/shallow`: those commits are present, but their
 * parents are not. Mirrors `writeShallowFile` in git-sync.test.ts. */
async function writeDeepeningTestShallowFile(fs: NodeFS, oids: string[]) {
  await fs.promises.writeFile(`${DEEPEN_TEST_GITDIR}/shallow`, `${oids.join("\n")}\n`);
}

describe("readTreeAtCommitWithDeepening (real git, in-memory) (#246)", () => {
  const dir = DEEPEN_TEST_DIR;
  const makeCommit = makeDeepeningTestCommit;
  const placeAll = placeDeepeningTestObjects;
  const setMainTip = setDeepeningTestMainTip;
  const writeShallowFile = writeDeepeningTestShallowFile;

  it("resolves without any deepening when the pinned commit is already local (the common case)", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    await git.init({ fs, dir, defaultBranch: "main" });
    const c1 = await makeCommit("c1", undefined, 1_700_000_000);
    await placeAll(fs, [c1.blob, c1.tree, c1.commit]);
    await setMainTip(fs, c1.commit.oid);

    const deepen: DeepenFetch = async () => {
      throw new Error("deepen must not be called when the commit is already local");
    };

    const result = await readTreeAtCommitWithDeepening(
      fs,
      dir,
      c1.commit.oid,
      "main",
      2,
      8,
      deepen,
      noopLogger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(new TextDecoder().decode(result.data.get("c1.txt"))).toBe("c1\n");
  });

  it("deepens once and succeeds when the pinned commit sits just beyond the initial shallow window", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    await git.init({ fs, dir, defaultBranch: "main" });

    // root <- pinned <- mid <- tip. Initially only mid/tip are local, with
    // `mid` marked as the shallow boundary (its parent, `pinned`, absent) —
    // exactly what a real depth-limited clone/fetch leaves behind.
    const root = await makeCommit("root", undefined, 1_700_000_000);
    const pinned = await makeCommit("pinned", root.commit.oid, 1_700_000_010);
    const mid = await makeCommit("mid", pinned.commit.oid, 1_700_000_020);
    const tip = await makeCommit("tip", mid.commit.oid, 1_700_000_030);

    await placeAll(fs, [mid.blob, mid.tree, mid.commit, tip.blob, tip.tree, tip.commit]);
    await setMainTip(fs, tip.commit.oid);
    await writeShallowFile(fs, [mid.commit.oid]);

    let deepenCalls = 0;
    const deepen: DeepenFetch = async () => {
      deepenCalls++;
      // A real relative-deepen fetch would reveal `pinned` next.
      await placeAll(fs, [pinned.blob, pinned.tree, pinned.commit]);
      await writeShallowFile(fs, [pinned.commit.oid]);
      return ok(undefined);
    };

    const result = await readTreeAtCommitWithDeepening(
      fs,
      dir,
      pinned.commit.oid,
      "main",
      1,
      8,
      deepen,
      noopLogger,
    );

    expect(deepenCalls).toBe(1);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(new TextDecoder().decode(result.data.get("pinned.txt"))).toBe("pinned\n");
  });

  it("gives up at the depth cap — without ever needing the pinned commit's objects — when deepening never reveals it", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    await git.init({ fs, dir, defaultBranch: "main" });

    const root = await makeCommit("root", undefined, 1_700_000_000);
    const neverReached = await makeCommit("never-reached", root.commit.oid, 1_700_000_010);
    const c3 = await makeCommit("c3", neverReached.commit.oid, 1_700_000_020);
    const c4 = await makeCommit("c4", c3.commit.oid, 1_700_000_030);
    const tip = await makeCommit("tip", c4.commit.oid, 1_700_000_040);

    await placeAll(fs, [c4.blob, c4.tree, c4.commit, tip.blob, tip.tree, tip.commit]);
    await setMainTip(fs, tip.commit.oid);
    await writeShallowFile(fs, [c4.commit.oid]);

    let deepenCalls = 0;
    const deepen: DeepenFetch = async () => {
      deepenCalls++;
      // Reveals c3 — legitimate progress — but never the target commit, the
      // same shape a real deepening fetch takes when it simply hasn't reached
      // the target yet.
      await placeAll(fs, [c3.blob, c3.tree, c3.commit]);
      await writeShallowFile(fs, [c3.commit.oid]);
      return ok(undefined);
    };

    const result = await readTreeAtCommitWithDeepening(
      fs,
      dir,
      neverReached.commit.oid,
      "main",
      1,
      2,
      deepen,
      noopLogger,
    );

    // Proves the loop terminates at the cap rather than growing without
    // bound: exactly one round fits between startDepth=1 and maxDepth=2.
    expect(deepenCalls).toBe(1);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(neverReached.commit.oid);
    expect(result.error.message).toContain("2-commit history bound");
  });

  it("fails immediately on a corrupted blob without deepening — resolving the commit is a different question than reading its tree", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    await git.init({ fs, dir, defaultBranch: "main" });

    const goodBlob = await blobObject(new TextEncoder().encode("still readable"));
    const tree = await treeObject([
      { mode: "100644", name: "good.txt", oid: goodBlob.oid },
      // A dangling oid: listed in the tree but the object does not exist —
      // `git.listFiles` resolves fine off tree structure alone, so this
      // commit is NOT "shallow-missing"; only the per-blob read fails.
      { mode: "100644", name: "missing.txt", oid: "0123456789abcdef0123456789abcdef01234567" },
    ]);
    const commit = await commitObject({
      tree: tree.oid,
      parents: [],
      message: "broken tree",
      timestamp: 1_700_000_000,
    });
    await placeAll(fs, [goodBlob, tree, commit]);
    await setMainTip(fs, commit.oid);

    const deepen: DeepenFetch = async () => {
      throw new Error("deepen must not be called for a corrupted blob — the commit resolves fine");
    };

    const result = await readTreeAtCommitWithDeepening(
      fs,
      dir,
      commit.oid,
      "main",
      1,
      8,
      deepen,
      noopLogger,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(`Failed to read tree at commit ${commit.oid}`);
    expect(result.error.message).toContain("missing.txt");
  });

  it("gives up immediately, without deepening, when the branch already has its full local history", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    await git.init({ fs, dir, defaultBranch: "main" });

    // A young repo — e.g. under DEFAULT_SHALLOW_DEPTH commits — never gets a
    // `.git/shallow` file at all: the initial clone already has everything
    // main can reach. An unresolvable sha here (wrong branch, force-pushed
    // away, or simply bogus) can never be found by fetching more, since
    // there IS no more to fetch.
    const tip = await makeCommit("tip", undefined, 1_700_000_000);
    await placeAll(fs, [tip.blob, tip.tree, tip.commit]);
    await setMainTip(fs, tip.commit.oid);
    const unrelated = "0123456789abcdef0123456789abcdef01234567";

    let deepenCalls = 0;
    const deepen: DeepenFetch = async () => {
      deepenCalls++;
      return ok(undefined);
    };

    const result = await readTreeAtCommitWithDeepening(
      fs,
      dir,
      unrelated,
      "main",
      1,
      8,
      deepen,
      noopLogger,
    );

    // Distinct from the capped-out case: this fails on the FIRST attempt,
    // via readTreeAtCommit's own "not present" error, not the
    // maxDepth-bound message — and never calls deepen at all.
    expect(deepenCalls).toBe(0);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(`Failed to read tree at commit ${unrelated}`);
    expect(result.error.message).not.toContain("history bound");
  });
});

describe("readRepoFiles clone depth", () => {
  beforeEach(() => {
    vi.mocked(git.clone).mockReset().mockResolvedValue(undefined);
  });

  it("clones shallow (depth 50), never full history, when pinning a commit sha (#246)", async () => {
    await readRepoFiles("https://example.com/repo.git", "token", noopLogger, "some-sha");

    const cloneOpts = vi.mocked(git.clone).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(cloneOpts.depth).toBe(50);
  });

  it("clones shallow (depth 50) when reading the live HEAD", async () => {
    await readRepoFiles("https://example.com/repo.git", "token", noopLogger);

    const cloneOpts = vi.mocked(git.clone).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(cloneOpts.depth).toBe(50);
  });
});

describe("readRepoFiles pinned-commit deepening — production wiring (#246)", () => {
  const dir = DEEPEN_TEST_DIR;

  beforeEach(() => {
    vi.mocked(git.clone).mockReset();
    vi.mocked(git.fetch).mockReset();
  });

  it("deepens via a real git.fetch call, with the expected shape, when the pinned commit sits beyond the initial shallow window", async () => {
    // root <- pinned <- mid <- tip, with only mid/tip locally present after
    // the initial (mocked) clone — exactly what a real depth-limited clone
    // would leave behind.
    const root = await makeDeepeningTestCommit("root", undefined, 1_700_000_000);
    const pinned = await makeDeepeningTestCommit("pinned", root.commit.oid, 1_700_000_010);
    const mid = await makeDeepeningTestCommit("mid", pinned.commit.oid, 1_700_000_020);
    const tip = await makeDeepeningTestCommit("tip", mid.commit.oid, 1_700_000_030);

    vi.mocked(git.clone).mockImplementation(async (opts) => {
      const { fs } = opts as unknown as { fs: NodeFS };
      await git.init({ fs, dir, defaultBranch: "main" });
      await placeDeepeningTestObjects(fs, [
        mid.blob,
        mid.tree,
        mid.commit,
        tip.blob,
        tip.tree,
        tip.commit,
      ]);
      await setDeepeningTestMainTip(fs, tip.commit.oid);
      await writeDeepeningTestShallowFile(fs, [mid.commit.oid]);
      return undefined;
    });
    vi.mocked(git.fetch).mockImplementation(async (opts) => {
      const { fs } = opts as unknown as { fs: NodeFS };
      // A real relative-deepen fetch would reveal `pinned` next.
      await placeDeepeningTestObjects(fs, [pinned.blob, pinned.tree, pinned.commit]);
      await writeDeepeningTestShallowFile(fs, [pinned.commit.oid]);
      return {} as never;
    });

    const result = await readRepoFiles(
      "https://acct.artifacts.cloudflare.net/git/ns/owner__ws.git",
      "token",
      noopLogger,
      pinned.commit.oid,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(new TextDecoder().decode(result.data.get("pinned.txt"))).toBe("pinned\n");

    expect(git.fetch).toHaveBeenCalledTimes(1);
    expect(git.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: "origin",
        ref: "main",
        singleBranch: true,
        // readRepoFiles's real constants: window starts at DEFAULT_SHALLOW_DEPTH
        // (50) and doubles toward PINNED_COMMIT_MAX_FETCH_DEPTH (500), so the
        // first deepen round's increment is 100 - 50 = 50.
        depth: 50,
        relative: true,
      }),
    );
  });

  it("wraps a git.fetch failure during deepening as an ExternalServiceError instead of throwing", async () => {
    const root = await makeDeepeningTestCommit("root", undefined, 1_700_000_000);
    const pinned = await makeDeepeningTestCommit("pinned", root.commit.oid, 1_700_000_010);
    const mid = await makeDeepeningTestCommit("mid", pinned.commit.oid, 1_700_000_020);
    const tip = await makeDeepeningTestCommit("tip", mid.commit.oid, 1_700_000_030);

    vi.mocked(git.clone).mockImplementation(async (opts) => {
      const { fs } = opts as unknown as { fs: NodeFS };
      await git.init({ fs, dir, defaultBranch: "main" });
      await placeDeepeningTestObjects(fs, [
        mid.blob,
        mid.tree,
        mid.commit,
        tip.blob,
        tip.tree,
        tip.commit,
      ]);
      await setDeepeningTestMainTip(fs, tip.commit.oid);
      await writeDeepeningTestShallowFile(fs, [mid.commit.oid]);
      return undefined;
    });
    vi.mocked(git.fetch).mockRejectedValue(new Error("HTTP Error: 401 Unauthorized"));

    const result = await readRepoFiles(
      "https://acct.artifacts.cloudflare.net/git/ns/owner__ws.git",
      "token",
      noopLogger,
      pinned.commit.oid,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("Failed to deepen repository history");
  });
});

describe("withTimeout (#332)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the underlying value when it settles before the timeout", async () => {
    const resultPromise = withTimeout(Promise.resolve("done"), 1000, "test op");
    await vi.advanceTimersByTimeAsync(0);
    await expect(resultPromise).resolves.toBe("done");
  });

  it("propagates the underlying rejection unchanged when it fails before the timeout", async () => {
    // No intervening await before this: Promise.race (inside withTimeout)
    // subscribes to both promises synchronously, so asserting immediately
    // — rather than yielding via advanceTimersByTimeAsync first — attaches
    // a handler before Node's unhandled-rejection check ever runs.
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "test op")).rejects.toThrow(
      "boom",
    );
  });

  it("rejects with a timeout error naming the operation and budget when the promise never settles", async () => {
    const neverSettles = new Promise<string>(() => {});
    const resultPromise = withTimeout(neverSettles, 1000, "test op");
    const assertion = expect(resultPromise).rejects.toThrow("test op timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("clears its timer once the promise settles, leaving nothing pending", async () => {
    await withTimeout(Promise.resolve("done"), 1000, "test op");
    // If the timer weren't cleared, this would still have one pending timer
    // (the timeout callback) even though the operation already finished.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cloneRepo timeout (#332)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(git.clone).mockReset();
    vi.mocked(git.fetch).mockReset();
    vi.mocked(git.getRemoteInfo).mockReset();
    vi.mocked(git.push).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a stalling git.clone at the default 30s budget instead of hanging indefinitely", async () => {
    vi.mocked(git.clone).mockImplementation(() => new Promise(() => {}));

    const resultPromise = cloneRepo("https://example.com/repo.git", "token", noopLogger);
    const assertion = resultPromise.then((result) => {
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.message).toContain("Failed to clone repository");
      expect(String(result.error.context?.cause)).toContain(
        "cloneRepo: git.clone timed out after 30000ms",
      );
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("honors a custom timeoutMs override instead of the default", async () => {
    vi.mocked(git.clone).mockImplementation(() => new Promise(() => {}));

    const resultPromise = cloneRepo("https://example.com/repo.git", "token", noopLogger, {
      timeoutMs: 5_000,
    });
    const assertion = resultPromise.then((result) => {
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(String(result.error.context?.cause)).toContain(
        "cloneRepo: git.clone timed out after 5000ms",
      );
    });
    // Well short of the 30s default: proves the override actually took effect
    // rather than the default silently still applying.
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("also applies a custom timeoutMs to each per-tag fetch, not just the main clone", async () => {
    // A bare no-op clone (like the "readRepoFiles clone depth" tests use):
    // git.getRemoteInfo and git.fetch are mocked below and never actually
    // read the local fs, so nothing here needs a real, browsable repo — only
    // that the clone step itself resolves so the includeTags branch runs.
    vi.mocked(git.clone).mockResolvedValue(undefined);
    vi.mocked(git.getRemoteInfo).mockResolvedValue({
      capabilities: [],
      refs: { tags: { "v1.0.0": "a".repeat(40) } },
    } as unknown as Awaited<ReturnType<typeof git.getRemoteInfo>>);
    // Never resolves: proves the tag fetch itself is timed out, not the
    // (already-succeeded) clone or getRemoteInfo calls.
    vi.mocked(git.fetch).mockImplementation(() => new Promise(() => {}));

    const resultPromise = cloneRepo("https://example.com/repo.git", "token", noopLogger, {
      includeTags: true,
      timeoutMs: 300_000,
    });
    // Past TAG_FETCH_TIMEOUT_MS's 15s default: if the override weren't
    // reaching the tag loop, this alone would already have failed it.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(vi.mocked(git.fetch)).toHaveBeenCalledTimes(1);

    const assertion = resultPromise.then((result) => {
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.message).toContain("Failed to fetch tag: v1.0.0");
      expect(String(result.error.context?.cause)).toContain(
        "cloneRepo: git.fetch tag v1.0.0 timed out after 300000ms",
      );
    });
    await vi.advanceTimersByTimeAsync(285_000);
    await assertion;
  });

  it("times out a stalling git.getRemoteInfo during tag enumeration, not just the tag fetches after it", async () => {
    vi.mocked(git.clone).mockResolvedValue(undefined);
    vi.mocked(git.getRemoteInfo).mockImplementation(() => new Promise(() => {}));

    const resultPromise = cloneRepo("https://example.com/repo.git", "token", noopLogger, {
      includeTags: true,
    });
    const assertion = resultPromise.then((result) => {
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.message).toContain("Failed to enumerate remote tags");
      expect(String(result.error.context?.cause)).toContain(
        // Default TAG_FETCH_TIMEOUT_MS (15s), same as an unset-override tag
        // fetch — getRemoteInfo is part of the same tag-enumeration step.
        "cloneRepo: git.getRemoteInfo timed out after 15000ms",
      );
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    // git.fetch (the per-tag step) must never be reached: getRemoteInfo
    // never resolved, so there's no tag list to iterate over.
    expect(vi.mocked(git.fetch)).not.toHaveBeenCalled();
  });

  it("times out a stalling git.push instead of hanging indefinitely (representative of every push call site added by #332's follow-up)", async () => {
    vi.mocked(git.push).mockImplementation(() => new Promise(() => {}));
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;

    const resultPromise = pushBranchToRemote(
      fs,
      "/",
      {
        url: "https://github.com/acme/widgets.git",
        remoteRef: "refs/heads/stratum/chg_1",
        token: "gh-token",
      },
      noopLogger,
    );
    const assertion = expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ success: false }),
    );
    // PUSH_TIMEOUT_MS's 30s default.
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("pushMain returns a distinctly-coded PUSH_TIMEOUT error, not a generic ExternalServiceError, when git.push times out", async () => {
    vi.mocked(git.push).mockImplementation(() => new Promise(() => {}));
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;

    const resultPromise = pushMain("https://example.com/repo.git", "token", fs, "/", noopLogger);
    const assertion = resultPromise.then((result) => {
      expect(result.success).toBe(false);
      if (result.success) return;
      // Distinct from a genuine rejection's ExternalServiceError/EXTERNAL_SERVICE_ERROR
      // code — a caller (repo-restore.ts's rollback) needs to tell the two apart.
      expect(result.error.code).toBe("PUSH_TIMEOUT");
      expect(result.error.message).toContain("may still be in progress");
    });
    // RESTORE_TIMEOUT_MS's 300s budget.
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
  });

  it("pushTags returns a distinctly-coded PUSH_TIMEOUT error naming which tag stalled and how many landed first", async () => {
    vi.mocked(git.push)
      .mockResolvedValueOnce({} as never)
      .mockImplementation(() => new Promise(() => {}));
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;

    const resultPromise = pushTags(
      "https://example.com/repo.git",
      "token",
      fs,
      "/",
      ["v1.0.0", "v2.0.0"],
      noopLogger,
    );
    const assertion = resultPromise.then((result) => {
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PUSH_TIMEOUT");
      expect(result.error.message).toContain("v2.0.0");
      expect(result.error.message).toContain("1/2 tags were confirmed pushed");
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await assertion;
  });
});

describe("mergeWorkspaceIntoProject merge-failure classification (#185)", () => {
  const projectRemote = "https://acct.artifacts.cloudflare.net/git/ns/owner__project.git";
  const workspaceRemote = "https://acct.artifacts.cloudflare.net/git/ns/owner__ws.git";

  const doMerge = () =>
    mergeWorkspaceIntoProject(projectRemote, "pt", workspaceRemote, "wt", noopLogger);

  beforeEach(() => {
    vi.mocked(git.clone).mockReset().mockResolvedValue(undefined);
    vi.mocked(git.addRemote).mockReset().mockResolvedValue(undefined);
    vi.mocked(git.fetch)
      .mockReset()
      .mockResolvedValue({} as Awaited<ReturnType<typeof git.fetch>>);
    vi.mocked(git.resolveRef).mockReset().mockResolvedValue("ws-sha");
    vi.mocked(git.merge).mockReset();
    vi.mocked(git.push)
      .mockReset()
      .mockResolvedValue({ ok: true } as unknown as Awaited<ReturnType<typeof git.push>>);
  });

  it("propagates the exact conflicting file list on a real merge conflict", async () => {
    vi.mocked(git.merge).mockRejectedValue(
      new GitErrors.MergeConflictError(
        ["src/a.ts", "docs/readme.md"],
        ["src/a.ts", "docs/readme.md"],
        [],
        [],
      ),
    );

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("MERGE_CONFLICT");
      expect(result.error.statusCode).toBe(409);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual([
        "src/a.ts",
        "docs/readme.md",
      ]);
    }
    expect(git.push).not.toHaveBeenCalled();
  });

  it("merges with abortOnConflict: false so real conflicts carry their file list", async () => {
    vi.mocked(git.merge).mockResolvedValue({
      oid: "merged-sha",
    } as Awaited<ReturnType<typeof git.merge>>);

    await doMerge();

    expect(git.merge).toHaveBeenCalledWith(expect.objectContaining({ abortOnConflict: false }));
  });

  it("classifies a conflict by code when instanceof fails (duplicate module instance)", async () => {
    const foreign = Object.assign(new Error("Automatic merge failed: README.md"), {
      code: "MergeConflictError",
      data: { filepaths: ["README.md"], bothModified: ["README.md"] },
    });
    vi.mocked(git.merge).mockRejectedValue(foreign);

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual(["README.md"]);
    }
  });

  it("falls back to an empty file list when a code-matched conflict carries no data", async () => {
    const foreign = Object.assign(new Error("merge conflict"), { code: "MergeConflictError" });
    vi.mocked(git.merge).mockRejectedValue(foreign);

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual([]);
    }
  });

  it("maps MergeNotSupportedError to a conflict with no file list", async () => {
    vi.mocked(git.merge).mockRejectedValue(new GitErrors.MergeNotSupportedError());

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect(result.error.statusCode).toBe(409);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual([]);
    }
  });

  it("classifies MergeNotSupportedError by code when instanceof fails (duplicate module instance)", async () => {
    const foreign = Object.assign(new Error("merge not supported"), {
      code: "MergeNotSupportedError",
    });
    vi.mocked(git.merge).mockRejectedValue(foreign);

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("MERGE_CONFLICT");
      expect(result.error.statusCode).toBe(409);
      expect((result.error as MergeConflictError).conflictingFiles).toEqual([]);
    }
  });

  it("does NOT report an operational failure (network) as a merge conflict", async () => {
    vi.mocked(git.merge).mockRejectedValue(new Error("connect ETIMEDOUT 203.0.113.9:443"));

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
      expect(result.error.statusCode).toBe(502);
      expect(result.error.message).toContain("ETIMEDOUT");
    }
  });

  it("does NOT report an HTTP-layer git error as a merge conflict", async () => {
    vi.mocked(git.merge).mockRejectedValue(
      new GitErrors.HttpError(502, "Bad Gateway", "upstream unavailable"),
    );

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
      expect(result.error.statusCode).toBe(502);
    }
  });

  it("surfaces a push failure after a clean merge as an external service error", async () => {
    vi.mocked(git.merge).mockResolvedValue({
      oid: "merged-sha",
    } as Awaited<ReturnType<typeof git.merge>>);
    vi.mocked(git.push).mockRejectedValue(new Error("503 Service Unavailable"));

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).not.toBeInstanceOf(MergeConflictError);
      expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
    }
  });

  it("errors when the merge succeeds without producing a commit oid", async () => {
    vi.mocked(git.merge).mockResolvedValue({} as Awaited<ReturnType<typeof git.merge>>);

    const result = await doMerge();

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
  });

  it("returns the merge commit oid and pushes when the merge succeeds", async () => {
    vi.mocked(git.merge).mockResolvedValue({
      oid: "merged-sha",
    } as Awaited<ReturnType<typeof git.merge>>);

    const result = await doMerge();

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("merged-sha");
    expect(git.push).toHaveBeenCalled();
  });
});

/** Builds a one-commit local repo (real git objects, no network) on `main` —
 * or on `opts.branch`, and ONLY on it, so a test can prove a caller reads the
 * branch it was handed rather than a hard-coded `main` — optionally with a
 * nested gitlink entry and/or a root `.gitmodules` file. A
 * gitlink lives inside a real `vendor` subtree because a tree entry name
 * cannot contain a slash — a flat "vendor/lib" entry is a tree git cannot
 * produce, so the walker in `scanForSubmoduleContent` would not be exercised
 * the way it is in practice. */
async function seedSubmoduleRepo(
  fs: NodeFS,
  dir: string,
  opts: { gitlink?: boolean; gitmodules?: boolean; branch?: string } = {},
): Promise<string> {
  const gitfs = fs as unknown as Parameters<typeof git.init>[0]["fs"];
  await git.init({ fs: gitfs, dir, defaultBranch: "main" });

  const rootEntries: {
    mode: string;
    path: string;
    oid: string;
    type: "blob" | "tree" | "commit";
  }[] = [];
  const readmeOid = await git.writeBlob({
    fs: gitfs,
    dir,
    blob: new TextEncoder().encode("hi\n"),
  });
  rootEntries.push({ mode: "100644", path: "README.md", oid: readmeOid, type: "blob" });

  if (opts.gitlink) {
    // The gitlink's oid is the submodule's commit -- never read as a blob, so
    // it doesn't need to exist as an object (mirrors squash-merge-modes.test.ts).
    const vendorTreeOid = await git.writeTree({
      fs: gitfs,
      dir,
      tree: [{ mode: "160000", path: "lib", oid: "a".repeat(40), type: "commit" }],
    });
    rootEntries.push({ mode: "040000", path: "vendor", oid: vendorTreeOid, type: "tree" });
  }
  if (opts.gitmodules) {
    const gitmodulesOid = await git.writeBlob({
      fs: gitfs,
      dir,
      blob: new TextEncoder().encode(
        '[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://example.test/lib.git\n',
      ),
    });
    rootEntries.push({ mode: "100644", path: ".gitmodules", oid: gitmodulesOid, type: "blob" });
  }

  const treeOid = await git.writeTree({ fs: gitfs, dir, tree: rootEntries });
  const author = { name: "Test", email: "test@example.com", timestamp: 0, timezoneOffset: 0 };
  const commit = await git.writeCommit({
    fs: gitfs,
    dir,
    commit: { tree: treeOid, parent: [], author, committer: author, message: "seed" },
  });
  await git.writeRef({
    fs: gitfs,
    dir,
    ref: `refs/heads/${opts.branch ?? "main"}`,
    value: commit,
    force: true,
  });
  return commit;
}

describe("scanForSubmoduleContent (#258)", () => {
  it("reports nothing unsupported for an ordinary tree", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const commit = await seedSubmoduleRepo(fs, "/", {});

    const result = await scanForSubmoduleContent(fs, commit, noopLogger);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ gitlinkPaths: [], hasGitmodules: false });
  });

  it("detects a gitlink entry nested in a subtree", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const commit = await seedSubmoduleRepo(fs, "/", { gitlink: true });

    const result = await scanForSubmoduleContent(fs, commit, noopLogger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gitlinkPaths).toEqual(["vendor/lib"]);
      expect(result.data.hasGitmodules).toBe(false);
    }
  });

  it("detects a root .gitmodules file even without a gitlink entry", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    const commit = await seedSubmoduleRepo(fs, "/", { gitmodules: true });

    const result = await scanForSubmoduleContent(fs, commit, noopLogger);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gitlinkPaths).toEqual([]);
      expect(result.data.hasGitmodules).toBe(true);
    }
  });
});

describe("submoduleUnsupportedError (#258)", () => {
  it("names the gitlink path(s) with a 422 SUBMODULES_UNSUPPORTED error", () => {
    const error = submoduleUnsupportedError({ gitlinkPaths: ["vendor/lib"], hasGitmodules: false });

    expect(error.code).toBe("SUBMODULES_UNSUPPORTED");
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain("vendor/lib");
  });

  it("names .gitmodules when only the config file is present", () => {
    const error = submoduleUnsupportedError({ gitlinkPaths: [], hasGitmodules: true });

    expect(error.code).toBe("SUBMODULES_UNSUPPORTED");
    expect(error.message).toContain(".gitmodules");
  });
});

describe("getDiffBetweenRepos rejects submodule content (#258)", () => {
  const workspaceUrl = "https://artifacts.example.test/git/ns/ws.git";
  const baseUrl = "https://artifacts.example.test/git/ns/project.git";

  beforeEach(() => {
    vi.mocked(git.clone).mockReset();
    vi.mocked(git.resolveRef).mockReset();
  });

  /** Wires `git.clone` (mocked at the module level) to build a tiny local
   * repo directly into the fs/dir it's handed, keyed by which url is being
   * "cloned" -- exactly what a real clone of that remote would leave behind,
   * without any network layer. */
  function stubClones(build: (url: string, fs: NodeFS, dir: string) => Promise<void> | void): void {
    vi.mocked(git.clone).mockImplementation(async (opts: unknown) => {
      const { fs, dir, url } = opts as { fs: NodeFS; dir: string; url: string };
      await build(url, fs, dir);
    });
  }

  it("rejects when the workspace tree contains a gitlink entry", async () => {
    stubClones(async (url, fs, dir) => {
      await seedSubmoduleRepo(fs, dir, url === workspaceUrl ? { gitlink: true } : {});
    });

    const result = await getDiffBetweenRepos(
      baseUrl,
      "base-token",
      workspaceUrl,
      "ws-token",
      noopLogger,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("SUBMODULES_UNSUPPORTED");
      expect(result.error.message).toContain("vendor/lib");
    }
    // Rejected before ever resolving the workspace tip -- no partial change
    // record's worth of extra work happens past the scan.
    expect(git.resolveRef).not.toHaveBeenCalled();
  });

  it("rejects when the workspace tree contains only .gitmodules", async () => {
    stubClones(async (url, fs, dir) => {
      await seedSubmoduleRepo(fs, dir, url === workspaceUrl ? { gitmodules: true } : {});
    });

    const result = await getDiffBetweenRepos(
      baseUrl,
      "base-token",
      workspaceUrl,
      "ws-token",
      noopLogger,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("SUBMODULES_UNSUPPORTED");
      expect(result.error.message).toContain(".gitmodules");
    }
  });

  it("scans the branch it was asked for, not a hard-coded main (#258)", async () => {
    // A project imported from a repo whose default branch is `trunk` has no
    // `main` anywhere: base repo, workspace fork and both clones are on
    // `trunk`. Scanning `main` regardless would fail to resolve the ref and
    // surface an opaque git error, so a submodule push would get past the
    // guard on exactly the projects it was not hard-coded for.
    stubClones(async (url, fs, dir) => {
      await seedSubmoduleRepo(fs, dir, {
        branch: "trunk",
        ...(url === workspaceUrl ? { gitlink: true } : {}),
      });
    });

    const result = await getDiffBetweenRepos(
      baseUrl,
      "base-token",
      workspaceUrl,
      "ws-token",
      noopLogger,
      "trunk",
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      // The structured rejection specifically — not a generic git failure
      // from scanning a ref this project does not have.
      expect(result.error.code).toBe("SUBMODULES_UNSUPPORTED");
      expect(result.error.message).toContain("vendor/lib");
    }
  });

  it("does not reject an ordinary workspace diff", async () => {
    let workspaceCommit = "";
    stubClones(async (url, fs, dir) => {
      const commit = await seedSubmoduleRepo(fs, dir, {});
      if (url === workspaceUrl) workspaceCommit = commit;
    });
    vi.mocked(git.resolveRef).mockImplementation(async () => workspaceCommit);

    const result = await getDiffBetweenRepos(
      baseUrl,
      "base-token",
      workspaceUrl,
      "ws-token",
      noopLogger,
    );

    expect(result.success).toBe(true);
  });
});
