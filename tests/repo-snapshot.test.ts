import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSnapshot, walkRepoObjects } from "../src/backup/repo-snapshot";
import type { NodeFS } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import type { ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const DIR = "/repo";
const author = { name: "t", email: "t@x.com", timestamp: 1_700_000_000, timezoneOffset: 0 };

async function buildRepo(
  commits: Record<string, string>[],
): Promise<{ fs: NodeFS; tipSha: string }> {
  const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
  // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
  const gfs = fs as any;
  await git.init({ fs: gfs, dir: DIR, defaultBranch: "main" });
  let tipSha = "";
  for (const files of commits) {
    for (const [path, content] of Object.entries(files)) {
      await gfs.promises.writeFile(`${DIR}/${path}`, content);
      await git.add({ fs: gfs, dir: DIR, filepath: path });
    }
    tipSha = await git.commit({ fs: gfs, dir: DIR, message: "c", author });
  }
  return { fs, tipSha };
}

const project: ProjectEntry = {
  id: "p1",
  name: "repo",
  slug: "repo",
  namespace: "@owner",
  ownerId: "u1",
  ownerType: "user",
  remote: "https://artifacts.example.com/repos/repo",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("repo snapshot capture", () => {
  // The logger mock is module-scoped, so without this each test would see the
  // previous test's calls and the call-count assertions below would pass or
  // fail on declaration order rather than on behaviour.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("walks the full reachable object set and preserves the tip sha", async () => {
    const { fs, tipSha } = await buildRepo([{ "a.txt": "one" }, { "b.txt": "two" }]);
    const walk = await walkRepoObjects(fs, DIR, 1_000_000, logger);
    expect(walk.success).toBe(true);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    expect(walk.data.tipSha).toBe(tipSha);
    // Two commits → 2 commit objects + trees + blobs, all deduped.
    expect(walk.data.objects.length).toBeGreaterThanOrEqual(4);
    const oids = walk.data.objects.map((o) => o.oid);
    expect(new Set(oids).size).toBe(oids.length); // deduped
    expect(oids).toContain(tipSha); // tip commit is captured (with its parent, for a faithful restore)

    const snap = buildSnapshot(project, walk.data, "2026-07-19T00:00:00Z");
    expect(snap.manifest.tipSha).toBe(tipSha);
    expect(snap.manifest.project.id).toBe("p1");
    expect(snap.manifest.objectCount).toBe(walk.data.objects.length);
    expect(snap.pack.byteLength).toBeGreaterThan(0);
  });

  it("skips a repo over the byte cap", async () => {
    const { fs } = await buildRepo([{ "big.txt": "x".repeat(5000) }]);
    const walk = await walkRepoObjects(fs, DIR, 100, logger); // cap far below the blob
    expect(walk.success).toBe(true);
    if (!walk.success) return;
    expect("tooLarge" in walk.data).toBe(true);
  });

  it("reports an empty repo (no commits)", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await git.init({ fs: fs as any, dir: DIR, defaultBranch: "main" });
    const walk = await walkRepoObjects(fs, DIR, 1_000_000, logger);
    expect(walk.success).toBe(true);
    if (!walk.success) return;
    expect("empty" in walk.data).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // #251: a repo with no branch ref (unborn HEAD) but a tag pointing at a
  // commit used to be reported empty, dropping the tag and everything only it
  // reached. It now snapshots its tags alone, with no tip.
  it("snapshots a tag-only repo (unborn HEAD) with its tag objects and no tip", async () => {
    const { fs, tipSha } = await buildRepo([{ "a.txt": "one" }, { "b.txt": "two" }]);
    await git.tag({ fs, dir: DIR, ref: "v1", object: tipSha });
    // Remove the only branch ref directly (not via git.deleteBranch, which
    // detaches HEAD onto the sha instead of leaving it unborn) so HEAD stays
    // an unresolvable symref, mirroring a remote whose sole ref is a tag: the
    // tagged commit stays reachable only via refs/tags/v1.
    await fs.promises.unlink(`${DIR}/.git/refs/heads/main`);

    const walk = await walkRepoObjects(fs, DIR, 1_000_000, logger);
    expect(walk.success).toBe(true);
    if (!walk.success || !("objects" in walk.data)) throw new Error("expected a tag-only walk");
    expect(walk.data.tipSha).toBeUndefined();
    expect(walk.data.tags).toEqual([{ name: "v1", oid: tipSha }]);
    const oids = walk.data.objects.map((o) => o.oid);
    expect(oids).toContain(tipSha);
    // Both commits (the tag's ancestry), with their trees and blobs.
    expect(oids.length).toBeGreaterThanOrEqual(4);
    expect(logger.warn).not.toHaveBeenCalled();

    const snap = buildSnapshot(project, walk.data, "2026-07-19T00:00:00Z");
    // Absent, not `undefined`-valued: the stored JSON carries no tipSha key.
    expect("tipSha" in snap.manifest).toBe(false);
    expect(JSON.parse(JSON.stringify(snap.manifest))).not.toHaveProperty("tipSha");
    expect(snap.manifest.tags).toEqual([{ name: "v1", oid: tipSha }]);
    expect(snap.manifest.objectCount).toBe(walk.data.objects.length);
  });

  it("still reports empty when HEAD is unborn and no tag resolves", async () => {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await git.init({ fs: fs as any, dir: DIR, defaultBranch: "main" });
    // A tag ref whose object is absent: there is nothing to back up.
    await git.writeRef({ fs, dir: DIR, ref: "refs/tags/ghost", value: "f".repeat(40) });

    const walk = await walkRepoObjects(fs, DIR, 1_000_000, logger);
    expect(walk.success).toBe(true);
    if (!walk.success) return;
    expect("empty" in walk.data).toBe(true);
    // The dropped tag is named in a warning rather than lost silently.
    expect(logger.warn).toHaveBeenCalledWith(
      "Backup: skipping unresolvable tag",
      expect.objectContaining({ name: "ghost" }),
    );
  });
});
