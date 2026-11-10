/**
 * Finding the commit a workspace forked from, across two shallow clones.
 *
 * Real isomorphic-git objects in real in-memory repositories; only the network
 * is replaced, by `deepen` callbacks that write the next commits a deeper fetch
 * would have brought.
 */
import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { type DeepenFetch, findForkPoint } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import { AppError } from "../src/utils/errors";
import { err, ok } from "../src/utils/result";

type Fs = ReturnType<MemoryFS["toNodeFS"]>;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface Commit {
  oid: string;
  message: string;
  parents: string[];
}

/** Commit objects are content-addressed, so writing the same one into two
 * repositories gives the same oid in both, as a fork and its project have. */
async function write(fs: Fs, commit: Pick<Commit, "message" | "parents">): Promise<string> {
  const who = { name: "T", email: "t@test", timestamp: 1700000000, timezoneOffset: 0 };
  return git.writeCommit({
    fs,
    dir: "/",
    commit: {
      tree: EMPTY_TREE,
      parent: commit.parents,
      author: who,
      committer: who,
      message: commit.message,
    },
  });
}

async function newRepo(): Promise<Fs> {
  const fs = new MemoryFS().toNodeFS();
  await git.init({ fs, dir: "/" });
  return fs;
}

const scratch = await newRepo();

/** A linear run of `count` commits on top of `onto`, oldest first. */
async function line(name: string, count: number, onto: string[] = []): Promise<Commit[]> {
  const commits: Commit[] = [];
  let parents = onto;
  for (let i = 0; i < count; i++) {
    const commit = { message: `${name} ${i}`, parents };
    const oid = await write(scratch, commit);
    commits.push({ ...commit, oid });
    parents = [oid];
  }
  return commits;
}

async function mergeCommit(name: string, parents: string[]): Promise<Commit> {
  const commit = { message: name, parents };
  return { ...commit, oid: await write(scratch, commit) };
}

/**
 * One side of the comparison: a repository holding the newest `depth` commits
 * of `history` (newest last), and a `deepen` that reveals more of them.
 */
async function shallow(history: Commit[], depth: number) {
  const fs = await newRepo();
  let held = 0;
  const reveal = async (count: number) => {
    const from = Math.max(0, history.length - held - count);
    for (const commit of history.slice(from, history.length - held)) await write(fs, commit);
    held = history.length - from;
  };
  await reveal(depth);
  const deepen = vi.fn<DeepenFetch>(async (increment) => {
    await reveal(increment);
    return ok(undefined);
  });
  const tip = history[history.length - 1] as Commit;
  return { fs, deepen, tip: tip.oid };
}

async function search(
  workspace: Awaited<ReturnType<typeof shallow>>,
  base: Awaited<ReturnType<typeof shallow>>,
  depth = { workspace: 16, base: 1 },
) {
  return findForkPoint({
    workspaceFs: workspace.fs,
    baseFs: base.fs,
    workspaceTip: workspace.tip,
    baseTip: base.tip,
    depth,
    maxDepth: 64,
    deepen: { workspace: workspace.deepen, base: base.deepen },
    branch: "main",
  });
}

const tipOf = (commits: Commit[]) => [(commits[commits.length - 1] as Commit).oid];

describe("findForkPoint", () => {
  it("finds the project's tip under an up-to-date workspace without fetching more", async () => {
    const main = await line("main", 30);
    const work = await line("work", 3, tipOf(main));
    const workspace = await shallow([...main, ...work], 16);
    const base = await shallow(main, 1);

    const found = await search(workspace, base);

    expect(found).toEqual(ok({ kind: "found", oid: base.tip }));
    expect(workspace.deepen).not.toHaveBeenCalled();
    expect(base.deepen).not.toHaveBeenCalled();
  });

  it("fetches project history to reach the fork point of a workspace that is behind", async () => {
    const shared = await line("shared", 30);
    const newer = await line("newer", 5, tipOf(shared));
    const work = await line("work", 2, tipOf(shared));
    const workspace = await shallow([...shared, ...work], 16);
    const base = await shallow([...shared, ...newer], 1);

    const found = await search(workspace, base);

    expect(found).toEqual(ok({ kind: "found", oid: tipOf(shared)[0] }));
    // Level with the workspace first: 1 -> 16.
    expect(base.deepen.mock.calls).toEqual([[15]]);
    expect(workspace.deepen).not.toHaveBeenCalled();
  });

  it("grows both sides when the fork point is past the first window", async () => {
    const shared = await line("shared", 80);
    const newer = await line("newer", 20, tipOf(shared));
    const work = await line("work", 20, tipOf(shared));
    const workspace = await shallow([...shared, ...work], 16);
    const base = await shallow([...shared, ...newer], 1);

    const found = await search(workspace, base);

    expect(found).toEqual(ok({ kind: "found", oid: tipOf(shared)[0] }));
    expect(base.deepen.mock.calls).toEqual([[15], [48]]);
    expect(workspace.deepen.mock.calls).toEqual([[48]]);
  });

  it("gives up at the cap with an error that says what to do", async () => {
    const shared = await line("shared", 10);
    const newer = await line("newer", 100, tipOf(shared));
    const work = await line("work", 2, tipOf(shared));
    const workspace = await shallow([...shared, ...work], 16);
    const base = await shallow([...shared, ...newer], 1);

    const found = await search(workspace, base);

    expect(found.success).toBe(false);
    if (found.success) return;
    expect(found.error.code).toBe("FORK_POINT_NOT_FOUND");
    expect(found.error.message).toContain("within the last 64 commits");
    expect(found.error.message).toContain("Bring the workspace up to date with main");
    // The workspace's whole history was already held, so only the project grew.
    expect(base.deepen.mock.calls).toEqual([[15], [48]]);
    expect(workspace.deepen).not.toHaveBeenCalled();
  });

  it("reports histories read to their roots with nothing in common as unrelated", async () => {
    const workspace = await shallow(await line("one", 3), 16);
    const base = await shallow(await line("other", 4), 16);

    expect(await search(workspace, base, { workspace: 16, base: 16 })).toEqual(
      ok({ kind: "unrelated" }),
    );
  });

  it("uses the merged-in project commit once the project has been merged into the workspace", async () => {
    const shared = await line("shared", 3);
    const newer = await line("newer", 4, tipOf(shared));
    const work = await line("work", 2, tipOf(shared));
    // The workspace pulled the project's tip in, then the project moved once more.
    const merged = await mergeCommit("merge main", [...tipOf(work), ...tipOf(newer)]);
    const after = await line("after", 1, tipOf(newer));
    const workspace = await shallow([...shared, ...newer, ...work, merged], 16);
    const base = await shallow([...shared, ...newer, ...after], 16);

    // Not `shared`'s tip, where the workspace first forked: everything up to
    // `newer`'s tip is already in the workspace.
    expect(await search(workspace, base, { workspace: 16, base: 16 })).toEqual(
      ok({ kind: "found", oid: tipOf(newer)[0] }),
    );
  });

  it("passes on a failed fetch instead of reporting no fork point", async () => {
    const shared = await line("shared", 30);
    const workspace = await shallow([...shared, ...(await line("work", 2, tipOf(shared)))], 16);
    const base = await shallow([...shared, ...(await line("newer", 5, tipOf(shared)))], 1);
    base.deepen.mockResolvedValueOnce(err(new AppError("network down", "EXTERNAL", 502)));

    const found = await search(workspace, base);

    expect(found.success).toBe(false);
    if (!found.success) expect(found.error.message).toBe("network down");
  });
});
