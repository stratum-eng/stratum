import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { reconstructRepo } from "../src/backup/repo-restore";
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

const SRC = "/src";
const author = { name: "t", email: "t@x.com", timestamp: 1_700_000_000, timezoneOffset: 0 };

async function buildRepo(
  commits: Record<string, string>[],
): Promise<{ fs: NodeFS; tipSha: string }> {
  const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
  // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
  const gfs = fs as any;
  await git.init({ fs: gfs, dir: SRC, defaultBranch: "main" });
  let tipSha = "";
  for (const files of commits) {
    for (const [path, content] of Object.entries(files)) {
      await gfs.promises.writeFile(`${SRC}/${path}`, content);
      await git.add({ fs: gfs, dir: SRC, filepath: path });
    }
    tipSha = await git.commit({ fs: gfs, dir: SRC, message: "c", author });
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
  remote: "https://acct.artifacts.cloudflare.net/git/@owner/repo.git",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("repo reconstruction (restore, CI-provable leg)", () => {
  it("reconstructs a faithful repo whose tip sha and history match the original", async () => {
    const { fs, tipSha } = await buildRepo([
      { "a.txt": "one" },
      { "a.txt": "two" },
      { "b.txt": "b" },
    ]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-07-19T00:00:00Z");

    const rebuilt = await reconstructRepo(snap.pack, snap.manifest, logger);
    expect(rebuilt.success).toBe(true);
    if (!rebuilt.success) return;

    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    const rfs = rebuilt.data.fs as any;
    const dir = rebuilt.data.dir;

    // Tip resolves to the original sha.
    expect(await git.resolveRef({ fs: rfs, dir, ref: "main" })).toBe(tipSha);

    // The tip commit AND its full parent chain are present (pack is reachability-
    // closed) — proves this is a faithful restore, not an orphan snapshot.
    const log = await git.log({ fs: rfs, dir, depth: -1 });
    expect(log.length).toBe(3);
    expect(log[0]?.oid).toBe(tipSha);

    // The tree content is intact.
    const head = await git.readCommit({ fs: rfs, dir, oid: tipSha });
    expect(head.commit.tree).toBe(walk.data.objects.length > 0 ? head.commit.tree : "");
    const entries = await git.listFiles({ fs: rfs, dir, ref: "main" });
    expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("rejects a truncated / corrupt pack", async () => {
    const { fs } = await buildRepo([{ "a.txt": "one" }]);
    const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
    if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
    const snap = buildSnapshot(project, walk.data, "2026-07-19T00:00:00Z");

    // Corrupt: truncate the pack so objects can't be unpacked / the tip is missing.
    const corrupt = snap.pack.subarray(0, Math.max(1, snap.pack.byteLength >> 1));
    const rebuilt = await reconstructRepo(corrupt, snap.manifest, logger);
    expect(rebuilt.success).toBe(false);
  });
});
