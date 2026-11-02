import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconstructRepo, restoreProjectRepo } from "../src/backup/repo-restore";
import { type RepoManifest, buildSnapshot, walkRepoObjects } from "../src/backup/repo-snapshot";
import type { NodeFS } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { placeLooseObject } from "../src/storage/object-loader";
import type { Env, ProjectEntry } from "../src/types";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { err } from "../src/utils/result";

// Only `push` (the sole Artifacts-coupled git call in the restore path) is
// mocked; every other git function runs for real against MemoryFS so the
// round-trip below proves genuine object stores, not stubs.
const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  return {
    ...actual,
    default: { ...actual.default, push: (args: unknown) => mockPush(args) },
  };
});

// pushMain/pushTags themselves are mocked ONLY for the ambiguous-timeout
// tests below (via mockImplementationOnce, restored to the real
// implementation after each) — driving a genuine withTimeout timeout would
// need either real wall-clock minutes or fake timers, and the latter hangs
// here because restoreProjectRepo's own object reconstruction runs real
// CompressionStream-based work first. pushMain/pushTags's own PUSH_TIMEOUT
// behavior is covered directly, with fake timers, in tests/git-ops.test.ts.
const { mockPushMain, mockPushTags } = vi.hoisted(() => ({
  mockPushMain: vi.fn(),
  mockPushTags: vi.fn(),
}));

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    pushMain: (...args: Parameters<typeof actual.pushMain>) =>
      mockPushMain.getMockImplementation() ? mockPushMain(...args) : actual.pushMain(...args),
    pushTags: (...args: Parameters<typeof actual.pushTags>) =>
      mockPushTags.getMockImplementation() ? mockPushTags(...args) : actual.pushTags(...args),
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
const tagger = { name: "tagger", email: "tag@x.com", timestamp: 1_700_000_100, timezoneOffset: 0 };
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

async function buildRepo(
  commits: Record<string, string>[],
): Promise<{ fs: NodeFS; shas: string[] }> {
  const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
  await git.init({ fs, dir: SRC, defaultBranch: "main" });
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

/** A repo whose second commit is reachable ONLY via refs/tags/keep (an
 * annotated tag): main is reset back to the first commit. */
async function buildTaggedRepo(): Promise<{
  fs: NodeFS;
  c1: string;
  c2: string;
  keepOid: string;
}> {
  const { fs, shas } = await buildRepo([{ "a.txt": "one" }, { "side.txt": "tag-only" }]);
  const [c1, c2] = shas as [string, string];
  await git.annotatedTag({
    fs,
    dir: SRC,
    ref: "keep",
    object: c2,
    message: "kept release\n",
    tagger,
  });
  await git.tag({ fs, dir: SRC, ref: "lw", object: c1 });
  // Rewind main so c2 is only reachable through the tag.
  await git.writeRef({ fs, dir: SRC, ref: "refs/heads/main", value: c1, force: true });
  const keepOid = await git.resolveRef({ fs, dir: SRC, ref: "refs/tags/keep" });
  return { fs, c1, c2, keepOid };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("backup walk with tags", () => {
  it("captures tag refs, annotated tag objects, and commits reachable only from tags", async () => {
    const { fs, c1, c2, keepOid } = await buildTaggedRepo();

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    expect(walk.success).toBe(true);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");

    // HEAD tip is still main's tip.
    expect(walk.data.tipSha).toBe(c1);
    // Both refs recorded (sorted), pointing at the tag object / target.
    expect(walk.data.tags).toEqual([
      { name: "keep", oid: keepOid },
      { name: "lw", oid: c1 },
    ]);
    // The pack closes over the tag: the annotated tag object AND the tag-only
    // commit (plus its tree/blob) are included.
    const oids = walk.data.objects.map((o) => o.oid);
    expect(oids).toContain(keepOid);
    expect(oids).toContain(c2);
    expect(oids).toContain(c1);
    expect(new Set(oids).size).toBe(oids.length); // still deduped

    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    expect(snap.manifest.tags).toEqual(walk.data.tags);
  });

  it("captures tags pointing at trees and blobs, not just commits", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const c1 = shas[0] as string;
    const commit = await git.readCommit({ fs, dir: SRC, oid: c1 });
    const treeOid = commit.commit.tree;
    const tree = await git.readTree({ fs, dir: SRC, oid: treeOid });
    const blobOid = tree.tree[0]?.oid as string;
    await git.tag({ fs, dir: SRC, ref: "tree-tag", object: treeOid });
    await git.tag({ fs, dir: SRC, ref: "blob-tag", object: blobOid });

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    expect(walk.data.tags.map((t) => t.name)).toEqual(["blob-tag", "tree-tag"]);
  });

  it("skips (with a warning) a tag whose object is missing, keeping the pack closed", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    await git.writeRef({ fs, dir: SRC, ref: "refs/tags/ghost", value: MISSING_OID, force: true });
    await git.tag({ fs, dir: SRC, ref: "good", object: shas[0] });

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    // The dangling ref is NOT recorded — restoring it would fail the readObject
    // guard — but the healthy tag still is.
    expect(walk.data.tags.map((t) => t.name)).toEqual(["good"]);
    expect(walk.data.objects.map((o) => o.oid)).not.toContain(MISSING_OID);
    expect(logger.warn).toHaveBeenCalledWith(
      "Backup: skipping unresolvable tag",
      expect.objectContaining({ name: "ghost" }),
    );
  });

  it("snapshots a tag-of-tag chain longer than the old fixed hop cap", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const c1 = shas[0] as string;
    let current = c1;
    let currentType: "commit" | "tag" = "commit";
    // 11 tag objects deep — one more than the old fixed 10-hop limit.
    for (let i = 0; i < 11; i++) {
      current = await git.writeTag({
        fs,
        dir: SRC,
        tag: { object: current, type: currentType, tag: `t${i}`, tagger, message: `t${i}\n` },
      });
      currentType = "tag";
    }
    await git.writeRef({ fs, dir: SRC, ref: "refs/tags/deep", value: current, force: true });

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    expect(walk.data.tags).toEqual([{ name: "deep", oid: current }]);
    const oids = walk.data.objects.map((o) => o.oid);
    expect(oids).toContain(c1); // the chain's target commit made it into the pack
    expect(logger.warn).not.toHaveBeenCalledWith(
      "Backup: skipping unresolvable tag",
      expect.anything(),
    );
  });

  it("skips (with a warning) a tag whose oid forms a cycle instead of looping forever", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    await git.tag({ fs, dir: SRC, ref: "good", object: shas[0] });
    // A real tag-of-tag cycle can't exist through normal writes (an oid is a
    // hash of content that would have to embed that same oid). Simulate the
    // on-disk corruption the visited-oid guard defends against: place a loose
    // tag object, at an oid we choose, whose own `object` field is that same
    // oid — placeLooseObject bypasses hash verification, so this is a genuine
    // self-reference once read back.
    const selfOid = "c".repeat(40);
    const content = new TextEncoder().encode(
      `object ${selfOid}\ntype commit\ntag cycle\ntagger Test <test@x.com> 1700000000 +0000\n\nself-referential (corrupted fixture)\n`,
    );
    const header = new TextEncoder().encode(`tag ${content.length}\0`);
    const bytes = new Uint8Array(header.length + content.length);
    bytes.set(header, 0);
    bytes.set(content, header.length);
    await placeLooseObject(
      fs as unknown as Parameters<typeof placeLooseObject>[0],
      `${SRC}/.git`,
      selfOid,
      bytes,
    );
    await git.writeRef({ fs, dir: SRC, ref: "refs/tags/cycle", value: selfOid, force: true });

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    expect(walk.data.tags.map((t) => t.name)).toEqual(["good"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Backup: skipping unresolvable tag",
      expect.objectContaining({ name: "cycle" }),
    );
  });

  it("aborts with tooLarge when the tag walk pushes the byte total over the cap", async () => {
    // Measure the HEAD-only byte count first…
    const headOnly = await buildRepo([{ "a.txt": "one" }]);
    const headWalk = await walkRepoObjects(headOnly.fs, SRC, 10_000_000, logger);
    if (!headWalk.success || !("objects" in headWalk.data)) throw new Error("walk failed");
    const headBytes = headWalk.data.objects.reduce((n, o) => n + o.bytes.byteLength, 0);

    // …then add a big tag-only commit and cap just above the HEAD walk.
    const { fs } = await buildTaggedRepoWithBigTag();
    const walk = await walkRepoObjects(fs, SRC, headBytes + 32, logger);
    expect(walk.success).toBe(true);
    if (!walk.success) return;
    expect("tooLarge" in walk.data).toBe(true);
  });

  async function buildTaggedRepoWithBigTag(): Promise<{ fs: NodeFS }> {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }, { "big.txt": "x".repeat(5000) }]);
    const [c1, c2] = shas as [string, string];
    await git.tag({ fs, dir: SRC, ref: "big", object: c2 });
    await git.writeRef({ fs, dir: SRC, ref: "refs/heads/main", value: c1, force: true });
    return { fs };
  }

  it("captures both sides of a merge when a tag's ancestry is walked", async () => {
    // The tag walk stops at commits already collected. That stop has to be a
    // frontier: a merge can have one parent already in and the other not, and
    // halting at the first collected commit would drop the unseen side.
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const base = shas[0] as string;

    // Two independent children of `base`, then a merge commit joining them.
    // Parents are overridden explicitly; the tree comes from the index.
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await (fs as any).promises.writeFile(`${SRC}/left.txt`, "left");
    await git.add({ fs, dir: SRC, filepath: "left.txt" });
    const left = await git.commit({ fs, dir: SRC, message: "left", author, parent: [base] });

    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await (fs as any).promises.writeFile(`${SRC}/right.txt`, "right");
    await git.add({ fs, dir: SRC, filepath: "right.txt" });
    const right = await git.commit({ fs, dir: SRC, message: "right", author, parent: [base] });

    // `base` first, deliberately: it is already collected via HEAD, so a walk
    // that stops the whole queue at the first collected commit — rather than
    // stopping that path only — would drop `left` and `right` behind it.
    const merge = await git.commit({
      fs,
      dir: SRC,
      message: "merge",
      author,
      parent: [base, left, right],
    });

    // HEAD stays on `base`, so only the tag reaches the merge and its parents.
    await git.writeRef({ fs, dir: SRC, ref: "refs/heads/main", value: base, force: true });
    await git.tag({ fs, dir: SRC, ref: "merged", object: merge });

    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");

    const oids = walk.data.objects.map((o) => o.oid);
    expect(oids).toContain(merge);
    expect(oids).toContain(left);
    expect(oids).toContain(right);
    expect(oids).toContain(base);
    expect(walk.data.tags.map((t) => t.name)).toEqual(["merged"]);
  });

  it("skips an unresolvable tag without spending its bytes against the cap", async () => {
    // The tag's own object is large and reads fine; the target it points at is
    // missing, so the tag is skipped. Those provisional bytes used to stay in
    // the running total, and if they crossed maxBytes the whole backup came
    // back tooLarge instead of just dropping the tag.
    const headOnly = await buildRepo([{ "a.txt": "one" }]);
    const headWalk = await walkRepoObjects(headOnly.fs, SRC, 10_000_000, logger);
    if (!headWalk.success || !("objects" in headWalk.data)) throw new Error("walk failed");
    const headBytes = headWalk.data.objects.reduce((n, o) => n + o.bytes.byteLength, 0);

    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    const bloatedTagOid = await git.writeTag({
      fs,
      dir: SRC,
      tag: {
        object: MISSING_OID,
        type: "commit",
        tag: "bloat",
        tagger: { name: "t", email: "t@x.io", timestamp: 0, timezoneOffset: 0 },
        message: "z".repeat(5000),
      },
    });
    await git.writeRef({ fs, dir: SRC, ref: "refs/tags/bloat", value: bloatedTagOid, force: true });

    // A cap that HEAD fits inside but the extra tag object would blow past.
    const walk = await walkRepoObjects(fs, SRC, headBytes + 64, logger);

    expect(walk.success).toBe(true);
    if (!walk.success) return;
    // Skipped, not tooLarge.
    expect("objects" in walk.data).toBe(true);
    if (!("objects" in walk.data)) return;
    expect(walk.data.tags).toEqual([]);
    // Rolled back, not merely unrecorded: the tag object itself is gone too.
    expect(walk.data.objects.map((o) => o.oid)).not.toContain(bloatedTagOid);
    expect(logger.warn).toHaveBeenCalledWith(
      "Backup: skipping unresolvable tag",
      expect.objectContaining({ name: "bloat" }),
    );
  });

  it("aborts with tooLarge when a blob-only tag overflows the cap", async () => {
    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    // A big blob referenced by NO commit — only the tag reaches it.
    const blobOid = await git.writeBlob({
      fs,
      dir: SRC,
      blob: new TextEncoder().encode("y".repeat(5000)),
    });
    await git.writeRef({ fs, dir: SRC, ref: "refs/tags/fat-blob", value: blobOid, force: true });

    const headWalk = await walkRepoObjects(
      (await buildRepo([{ "a.txt": "one" }])).fs,
      SRC,
      10_000_000,
      logger,
    );
    if (!headWalk.success || !("objects" in headWalk.data)) throw new Error("walk failed");
    const headBytes = headWalk.data.objects.reduce((n, o) => n + o.bytes.byteLength, 0);

    const walk = await walkRepoObjects(fs, SRC, headBytes + 32, logger);
    expect(walk.success).toBe(true);
    if (!walk.success) return;
    expect("tooLarge" in walk.data).toBe(true);
  });
});

describe("restore round-trip with tags", () => {
  it("reconstructs tag refs alongside main and preserves annotated metadata", async () => {
    const { fs, c1, c2, keepOid } = await buildTaggedRepo();
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;
    const { fs: rfs, dir } = rebuilt.data;

    expect(await git.resolveRef({ fs: rfs, dir, ref: "main" })).toBe(c1);
    expect(await git.resolveRef({ fs: rfs, dir, ref: "refs/tags/keep" })).toBe(keepOid);
    expect(await git.resolveRef({ fs: rfs, dir, ref: "refs/tags/lw" })).toBe(c1);

    // The annotated tag object survived with its message and still peels to the
    // tag-only commit, whose content is intact.
    const tag = await git.readTag({ fs: rfs, dir, oid: keepOid });
    expect(tag.tag.message.trim()).toBe("kept release");
    expect(tag.tag.object).toBe(c2);
    const files = await git.listFiles({ fs: rfs, dir, ref: c2 });
    expect(files.sort()).toEqual(["a.txt", "side.txt"]);
  });

  it("still restores an OLD-format manifest without a tags field", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    // Simulate a manifest written before tag support (JSON round-trip drops the key).
    const legacy = JSON.parse(JSON.stringify(snap.manifest)) as RepoManifest;
    // biome-ignore lint/performance/noDelete: constructing the legacy shape exactly
    delete legacy.tags;

    const rebuilt = await reconstructRepo(snap.pack, legacy, logger);
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;
    expect(await git.resolveRef({ fs: rebuilt.data.fs, dir: rebuilt.data.dir, ref: "main" })).toBe(
      shas[0],
    );
  });

  it("fails reconstruction when a manifest tag's object is missing from the pack", async () => {
    const { fs, shas } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    snap.manifest.tags = [...(snap.manifest.tags ?? []), { name: "bogus", oid: MISSING_OID }];
    void shas;

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);
    expect(rebuilt.success).toBe(false);
  });

  // The manifest is read back from storage and its tag names are interpolated
  // into `refs/tags/<name>` and written with force:true — a traversing name would
  // resolve outside refs/tags/ and could overwrite refs/heads/main.
  it.each([
    ["path traversal into refs/heads", "../heads/main"],
    ["absolute ref path", "/refs/heads/main"],
    ["parent-dir segment", "v1/../../heads/main"],
    ["leading dot", ".hidden"],
    ["lock suffix", "v1.0.0.lock"],
    ["empty name", ""],
    ["control characters", "v1\u0000evil"],
    ["repeated slash (empty component)", "release//v1"],
    ["dot-prefixed inner component", "release/.hidden"],
    ["trailing-dot inner component", "release/v1."],
    ["lock-suffixed inner component", "release/v1.0.lock/next"],
    ["tilde", "v1~1"],
    ["caret", "v1^1"],
    ["colon", "a:b"],
    ["question mark", "a?b"],
    ["asterisk", "a*b"],
    ["open bracket", "a[b"],
    ["backslash", "a\\b"],
    ["reflog syntax", "v1@{0}"],
    ["space", "release v1"],
    ["DEL character", "v1\u007fevil"],
    // Accepted by `git check-ref-format`, refused by isomorphic-git's writeRef:
    // clean-git-ref collapses `./` to `/`. Rejecting it here keeps the failure
    // in the guard instead of half-way through the tag-write loop.
    ["a ./ sequence writeRef refuses", "v1./next"],
  ])("rejects a manifest tag name with %s", async (_label, tagName) => {
    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    const tipSha = snap.manifest.tipSha;
    // A real, present object id: only the NAME is hostile here.
    snap.manifest.tags = [{ name: tagName, oid: tipSha }];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);

    expect(rebuilt.success).toBe(false);
    if (rebuilt.success) throw new Error("expected rejection");
    expect(rebuilt.error.message).toContain("Invalid tag name in manifest");
  });

  // Every name here is accepted by `git check-ref-format refs/tags/<name>` and
  // was rejected by the previous allowlist. A backup holding one of these could
  // be written but never restored.
  it.each([
    ["an @ sign", "release@prod"],
    ["a comma", "v1,2"],
    ["a percent sign", "a%b"],
    ["an exclamation mark", "v1.0.0!"],
    ["parentheses", "feature(x)"],
    ["an equals sign", "v1=2"],
    ["an ampersand", "a&b"],
    ["an apostrophe", "tag'name"],
    ["a brace that is not @{", "a{b"],
    ["non-ASCII (CJK)", "\u7248\u672c1"],
    ["non-ASCII (diacritics)", "\u00fcn\u00efcode"],
  ])("reconstructs a tag name with %s", async (_label, tagName) => {
    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    snap.manifest.tags = [{ name: tagName, oid: snap.manifest.tipSha }];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);

    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) throw new Error(rebuilt.error.message);
    expect(
      await git.resolveRef({
        fs: rebuilt.data.fs,
        dir: rebuilt.data.dir,
        ref: `refs/tags/${tagName}`,
      }),
    ).toBe(snap.manifest.tipSha);
  });

  it("still reconstructs ordinary tag names containing dots and slashes", async () => {
    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z");
    snap.manifest.tags = [{ name: "release/v1.0.0", oid: snap.manifest.tipSha }];

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);

    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;
    expect(
      await git.resolveRef({
        fs: rebuilt.data.fs,
        dir: rebuilt.data.dir,
        ref: "refs/tags/release/v1.0.0",
      }),
    ).toBe(snap.manifest.tipSha);
  });
});

describe("restoreProjectRepo tag push", () => {
  function makeEnv(deleteFn = vi.fn(async () => true)): { env: Env; deleteFn: typeof deleteFn } {
    const env = {
      ARTIFACTS: {
        get: vi.fn(async () => null),
        create: vi.fn(async () => ({
          name: "repo",
          remote: project.remote,
          token: "tok",
        })),
        delete: deleteFn,
      } as unknown as Env["ARTIFACTS"],
    } as Env;
    return { env, deleteFn };
  }

  async function makeSnapshot() {
    const { fs, keepOid } = await buildTaggedRepo();
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    return { snap: buildSnapshot(project, walk.data, "2026-08-18T00:00:00Z"), keepOid };
  }

  it("pushes main first, then every tag ref", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const { env } = makeEnv();
    const { snap } = await makeSnapshot();

    const result = await restoreProjectRepo(env, snap, {}, logger);
    expect(result.success).toBe(true);
    const refs = mockPush.mock.calls.map((c) => (c[0] as { ref: string }).ref);
    expect(refs).toEqual(["main", "refs/tags/keep", "refs/tags/lw"]);
  });

  it("pushes only main for an old-format manifest without tags", async () => {
    mockPush.mockResolvedValue({ ok: true });
    const { env } = makeEnv();
    const { snap } = await makeSnapshot();
    const legacy = JSON.parse(JSON.stringify(snap.manifest)) as RepoManifest;
    // biome-ignore lint/performance/noDelete: constructing the legacy shape exactly
    delete legacy.tags;

    const result = await restoreProjectRepo(env, { pack: snap.pack, manifest: legacy }, {}, logger);
    expect(result.success).toBe(true);
    expect(mockPush.mock.calls.map((c) => (c[0] as { ref: string }).ref)).toEqual(["main"]);
  });

  it("rolls back a freshly created repo when a tag push fails", async () => {
    // main push succeeds, the first tag push fails.
    mockPush.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("tag rejected"));
    const { env, deleteFn } = makeEnv();
    const { snap } = await makeSnapshot();

    const result = await restoreProjectRepo(env, snap, {}, logger);
    expect(result.success).toBe(false);
    expect(deleteFn).toHaveBeenCalledWith("repo");
  });

  // A rejection and a timeout must NOT be treated the same: withTimeout never
  // actually cancels the underlying push (see its own doc comment in
  // git-ops.ts), so a timed-out push may still land after pushMain/pushTags
  // return. Deleting the repo on that ambiguous a signal risks destroying a
  // restore that actually succeeded. pushMain/pushTags are mocked directly to
  // return the PUSH_TIMEOUT-coded error they'd produce on a real timeout —
  // driving a genuine one here would need real wall-clock minutes or fake
  // timers, and the latter hangs against this file's real
  // CompressionStream-based reconstruction step. The real pushMain/pushTags
  // producing PUSH_TIMEOUT on an actual withTimeout timeout is covered
  // directly, with fake timers, in tests/git-ops.test.ts.
  describe("does not roll back on an ambiguous push timeout (#332 follow-up)", () => {
    afterEach(() => {
      mockPushMain.mockReset();
      mockPushTags.mockReset();
    });

    it("main push times out", async () => {
      mockPushMain.mockResolvedValue(
        err(new AppError("Push during restore timed out", "PUSH_TIMEOUT", 504)),
      );
      const { env, deleteFn } = makeEnv();
      const { snap } = await makeSnapshot();

      const result = await restoreProjectRepo(env, snap, {}, logger);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PUSH_TIMEOUT");
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it("a tag push times out after main already landed", async () => {
      // Explicit, not inherited: main's push goes through the real pushMain
      // (mocked only at the git.push level) and must succeed for this test
      // to prove anything about state landed BEFORE the tag-push timeout.
      mockPush.mockResolvedValue({ ok: true });
      mockPushTags.mockResolvedValue(
        err(new AppError("Push of tag during restore timed out", "PUSH_TIMEOUT", 504)),
      );
      const { env, deleteFn } = makeEnv();
      const { snap } = await makeSnapshot();

      const result = await restoreProjectRepo(env, snap, {}, logger);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.code).toBe("PUSH_TIMEOUT");
      // Not just "no delete call" — main (pushed for real via mockPush
      // before pushTags is reached) is landed state a rollback would
      // otherwise destroy.
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(deleteFn).not.toHaveBeenCalled();
    });
  });

  /** A forced restore over an EXISTING repo is deliberately not rolled back, so a
   * mid-list tag failure leaves main plus some tags on the remote. The failure has
   * to say how far it got — otherwise the partial state is invisible. */
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

  it("reports how many tags landed when a forced restore fails mid-list", async () => {
    // main ok, first tag ok, second tag fails -> 1 of 2 tags pushed.
    mockPush
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("tag rejected"));
    const { env, deleteFn } = makeExistingEnv();
    const { snap } = await makeSnapshot();

    const result = await restoreProjectRepo(env, snap, { force: true }, logger);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    // Names the progress rather than a bare "tag push failed".
    expect(result.error.message).toContain("1/2 tags pushed");
    // The pre-existing repo is never deleted by the rollback path.
    expect(deleteFn).not.toHaveBeenCalled();
    // And the partial state is logged for an operator/retry.
    expect(logger.error).toHaveBeenCalledWith(
      "Forced restore left partial state on an existing repo",
      undefined,
      expect.objectContaining({ mainPushed: true, tagCount: 2 }),
    );
  });
});
