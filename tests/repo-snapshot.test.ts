import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
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
  });
});
