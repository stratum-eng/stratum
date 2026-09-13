/**
 * #337: a manual conflict resolution is evaluated against one clone of the
 * project and committed by `resolveConflict` from a second, later clone. Without
 * a pin those can be different revisions, so the resolution lands on top of a
 * push no evaluator saw — cleanly, because the second clone's HEAD *is* the new
 * tip — and the audit record names a parent the commit does not have.
 *
 * Exercises the real git logic (isomorphic-git over MemoryFS); only the network
 * legs are stubbed — `git.clone` builds a scripted project history with
 * deterministic oids, `git.push` records what would have been pushed. Same
 * harness shape as tests/fastpath-sha-pinning.test.ts, which covers the
 * equivalent pin on the merge path (#124).
 */
import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFS } from "../src/storage/memory-fs";
import { createLogger } from "../src/utils/logger";

const state = vi.hoisted(() => ({
  build: undefined as undefined | ((fs: unknown, dir: string) => Promise<unknown>),
  pushes: [] as { url?: string; ref?: string; oid?: string }[],
  /** Reject the push the way a remote whose ref moved on does. */
  rejectPush: undefined as undefined | "not-fast-forward" | "tag-exists" | "other",
}));

vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  const real = actual.default;
  return {
    ...actual,
    default: {
      ...real,
      clone: vi.fn(async (args: { fs: unknown; dir: string }) => {
        if (!state.build) throw new Error("no repo builder configured for git.clone");
        await state.build(args.fs, args.dir);
      }),
      push: vi.fn(async (args: { fs: never; dir: string; url?: string; ref?: string }) => {
        if (state.rejectPush === "other") throw new Error("remote hung up unexpectedly");
        if (state.rejectPush !== undefined) {
          // The library's own error, so the mapping is exercised on the real
          // shape (code + data.reason) rather than on a hand-rolled lookalike.
          throw new actual.Errors.PushRejectedError(state.rejectPush);
        }
        const oid = await real.resolveRef({
          fs: args.fs,
          dir: args.dir,
          ref: args.ref ?? "HEAD",
        });
        state.pushes.push({ url: args.url, ref: args.ref, oid });
        return { ok: true, error: null, refs: {} };
      }),
    },
  };
});

import { resolveConflict } from "../src/storage/git-ops";

const logger = createLogger({ component: "test" });
const AUTHOR = { name: "Stratum", email: "system@usestratum.dev" };

type AnyFS = never;

/**
 * Deterministic project history: commit 0 is the base a resolution would be
 * evaluated against, commit 1 is a push that landed afterwards and moved the
 * tip. Fixed author timestamps -> identical oids on every build, so a test can
 * precompute the shas the mocked `git.clone` will produce.
 */
async function buildHistory(fsAny: unknown, dir: string, commits: number): Promise<string[]> {
  const fs = fsAny as AnyFS;
  const oids: string[] = [];
  await git.init({ fs, dir, defaultBranch: "main" });
  const prefix = dir === "/" ? "" : dir;
  for (let i = 0; i < commits; i++) {
    const path = i === 0 ? "README.md" : `later-${i}.txt`;
    await (
      fsAny as { promises: { writeFile(p: string, d: string): Promise<void> } }
    ).promises.writeFile(`${prefix}/${path}`, `content ${i}\n`);
    await git.add({ fs, dir, filepath: path });
    oids.push(
      await git.commit({
        fs,
        dir,
        message: `c${i}`,
        author: { ...AUTHOR, timestamp: 1700000000 + i, timezoneOffset: 0 },
      }),
    );
  }
  return oids;
}

async function precomputeOids(commits: number): Promise<string[]> {
  return buildHistory(new MemoryFS().toNodeFS(), "/pre", commits);
}

describe("resolveConflict — evaluated-base pinning (#337)", () => {
  beforeEach(() => {
    state.build = undefined;
    state.pushes = [];
    state.rejectPush = undefined;
  });

  const resolveManual = (expectedBaseSha?: string) =>
    resolveConflict(
      {
        projectRemote: "https://proj.example/repo.git",
        projectToken: "ptok",
        workspaceRemote: "https://ws.example/repo.git",
        workspaceToken: "wtok",
        strategy: "manual",
        branch: "main",
        manualResolutions: [{ file: "conflicted.txt", content: "resolved by hand\n" }],
        ...(expectedBaseSha !== undefined ? { expectedBaseSha } : {}),
      },
      logger,
    );

  it("commits when the project is still at the evaluated base", async () => {
    const [base] = await precomputeOids(1);
    state.build = (fs, dir) => buildHistory(fs, dir, 1);

    const result = await resolveManual(base as string);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0]).toMatchObject({ ref: "main", url: "https://proj.example/repo.git" });
    // The resolution commit, parented on the evaluated base.
    expect(state.pushes[0]?.oid).toBe(result.data.commitSha);
    expect(result.data.commitSha).not.toBe(base);
  });

  it("refuses with 409 STALE_PROJECT when a push moved the base, and pushes nothing", async () => {
    // Evaluated against commit 0; by the time resolveConflict clones, the tip is
    // commit 1. Before the pin this committed onto commit 1 and succeeded.
    const [base, newer] = await precomputeOids(2);
    state.build = (fs, dir) => buildHistory(fs, dir, 2);

    const result = await resolveManual(base as string);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("STALE_PROJECT");
    expect(result.error.statusCode).toBe(409);
    expect(result.error.message).toMatch(/re-resolve/);
    expect(state.pushes).toHaveLength(0);
    // The unevaluated commit is still the tip; nothing was layered on top of it.
    expect(newer).toBeDefined();
  });

  it("an unpinned call keeps its previous behavior (accept-* strategies pass no pin)", async () => {
    state.build = (fs, dir) => buildHistory(fs, dir, 2);

    const result = await resolveManual(undefined);

    expect(result.success).toBe(true);
    expect(state.pushes).toHaveLength(1);
  });

  it("#337: a push rejected as non-fast-forward under a pin reports STALE_PROJECT", async () => {
    // The residual race the pin cannot close by itself: the clone was at the
    // evaluated base, and the project moved between that check and the push. The
    // commit's parent is the evaluated base, so the remote refuses it — nothing
    // lands either way, but the caller's remedy is to re-resolve, not to retry a
    // "the remote is broken" 502.
    const [base] = await precomputeOids(1);
    state.build = (fs, dir) => buildHistory(fs, dir, 1);
    state.rejectPush = "not-fast-forward";

    const result = await resolveManual(base as string);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("STALE_PROJECT");
    expect(result.error.statusCode).toBe(409);
    expect(state.pushes).toHaveLength(0);
  });

  it("#337: an unpinned call still reports a rejected push as an upstream failure", async () => {
    // No pin means no claim about what the base should have been, so there is
    // nothing to tell the caller to re-resolve against.
    state.build = (fs, dir) => buildHistory(fs, dir, 1);
    state.rejectPush = "not-fast-forward";

    const result = await resolveManual(undefined);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
    expect(result.error.statusCode).toBe(502);
  });

  it("#337: a rejection that is not about the base keeps its own status", async () => {
    // `tag-exists` is the PushRejectedError's other reason and says nothing
    // about the project having moved; neither does an unrelated push failure.
    const [base] = await precomputeOids(1);
    state.build = (fs, dir) => buildHistory(fs, dir, 1);

    state.rejectPush = "tag-exists";
    const tagResult = await resolveManual(base as string);
    expect(tagResult.success).toBe(false);
    if (tagResult.success) return;
    expect(tagResult.error.code).toBe("EXTERNAL_SERVICE_ERROR");

    state.rejectPush = "other";
    const otherResult = await resolveManual(base as string);
    expect(otherResult.success).toBe(false);
    if (otherResult.success) return;
    expect(otherResult.error.code).toBe("EXTERNAL_SERVICE_ERROR");
  });

  it("fails closed when the project tip cannot be resolved at all", async () => {
    // An empty repo: initialized, no commits, so `main` resolves to nothing.
    // "We could not tell" must not read as "it matches".
    state.build = async (fsAny, dir) => {
      await git.init({ fs: fsAny as AnyFS, dir, defaultBranch: "main" });
    };

    const result = await resolveManual("0123456789abcdef0123456789abcdef01234567");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.statusCode).toBe(500);
    expect(result.error.message).toMatch(/verify the evaluated base/);
    expect(state.pushes).toHaveLength(0);
  });
});
