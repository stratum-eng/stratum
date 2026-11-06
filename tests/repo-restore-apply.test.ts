import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyRepoRestore } from "../src/backup/apply-repo-restore";
import { type BranchRefRecord, buildSnapshot, walkRepoObjects } from "../src/backup/repo-snapshot";
import { RUN_MANIFEST_KEY, putBlob } from "../src/storage/backup-store";
import type { NodeFS } from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeR2 } from "./helpers/fake-r2";

/**
 * Applying a backed-up repo, end to end. Only what touches Artifacts is faked
 * (the push, the ref advertisement, the repo API): reconstruction runs for real
 * from a real pack, so these prove everything but the live push, which only
 * the staging drill can.
 */
const { mockPush, mockGetRemoteInfo } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockGetRemoteInfo: vi.fn(),
}));

vi.mock("isomorphic-git", async (importActual) => {
  const actual = await importActual<typeof import("isomorphic-git")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      push: (args: unknown) => mockPush(args),
      getRemoteInfo: (args: unknown) => mockGetRemoteInfo(args),
    },
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

const RUN = "2026-11-01T04:00:00.000Z";
const PROJECT_ID = "proj_1";
const LIVE_REPO = "owner__repo";
const SRC = "/src";
const author = { name: "t", email: "t@x.com", timestamp: 1_700_000_000, timezoneOffset: 0 };

const project: ProjectEntry = {
  id: PROJECT_ID,
  name: "repo",
  slug: "repo",
  namespace: "@owner",
  ownerId: "u1",
  ownerType: "user",
  remote: `https://acct.artifacts.cloudflare.net/git/ns/${LIVE_REPO}.git`,
  createdAt: "2026-01-01T00:00:00.000Z",
};

async function makeSnapshot() {
  const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
  await git.init({ fs, dir: SRC, defaultBranch: "main" });
  const shas: string[] = [];
  for (const [path, content] of [
    ["a.txt", "one"],
    ["b.txt", "two"],
  ] as const) {
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await (fs as any).promises.writeFile(`${SRC}/${path}`, content);
    await git.add({ fs, dir: SRC, filepath: path });
    shas.push(await git.commit({ fs, dir: SRC, message: "c", author }));
  }
  const [c1, c2] = shas as [string, string];
  const walk = await walkRepoObjects(fs, SRC, 10_000_000, logger);
  if (!walk.success || !("objects" in walk.data)) throw new Error("walk failed");
  const branches: BranchRefRecord[] = [
    { name: "feature/x", oid: c1 },
    { name: "main", oid: c2 },
  ];
  return { snap: buildSnapshot(project, walk.data, RUN, branches), c1, c2 };
}

/** The refs a faithful restore leaves on the remote, in getRemoteInfo's nested shape. */
function advertise(c1: string, c2: string) {
  mockGetRemoteInfo.mockResolvedValue({ refs: { heads: { main: c2, feature: { x: c1 } } } });
}

async function makeEnv(opts: { existing?: boolean; complete?: boolean; withPack?: boolean } = {}) {
  const bucket = makeFakeR2();
  const { snap, c1, c2 } = await makeSnapshot();
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  if (opts.complete !== false) {
    await putBlob(bucket, `${RUN}/${RUN_MANIFEST_KEY}`, encode({ healthy: false }), {}, logger);
  }
  if (opts.withPack !== false) {
    await putBlob(
      bucket,
      `${RUN}/repos/${PROJECT_ID}.manifest.json`,
      encode(snap.manifest),
      {},
      logger,
    );
    await putBlob(bucket, `${RUN}/repos/${PROJECT_ID}.pack`, snap.pack, {}, logger);
  }
  const artifacts = {
    // Only the project's own repo exists: a scratch name must never collide.
    get: vi.fn(async (name: string) =>
      opts.existing && name === LIVE_REPO
        ? {
            name: LIVE_REPO,
            remote: project.remote,
            createToken: vi.fn(async () => ({ plaintext: "tok" })),
          }
        : null,
    ),
    create: vi.fn(async (name: string) => ({
      name,
      remote: `https://acct.artifacts.cloudflare.net/git/ns/${name}.git`,
      token: "tok",
    })),
    delete: vi.fn(async () => true),
  };
  const env = { BACKUPS: bucket, ARTIFACTS: artifacts } as unknown as Env;
  return { env, artifacts, bucket, c1, c2 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPush.mockResolvedValue({ ok: true });
});

describe("a restore drill", () => {
  it("restores to a scratch repo, verifies every ref, and deletes it", async () => {
    const { env, artifacts, c1, c2 } = await makeEnv({ existing: true });
    advertise(c1, c2);

    const result = await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);

    if (!result.success) throw result.error;
    expect(result.data.mode).toBe("drill");
    expect(result.data.tipSha).toBe(c2);
    expect(result.data.verification).toEqual({ ok: true, checked: 2, mismatches: [] });
    expect(result.data.scratchDeleted).toBe(true);
    const scratch = result.data.repoName as string;
    expect(scratch).toMatch(/^restore-drill-/);
    expect(artifacts.create).toHaveBeenCalledWith(scratch);
    expect(artifacts.delete).toHaveBeenCalledWith(scratch);
  });

  it("never reads, writes or deletes the project's own repo", async () => {
    const { env, artifacts, c1, c2 } = await makeEnv({ existing: true });
    advertise(c1, c2);

    await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);

    for (const fn of [artifacts.get, artifacts.create, artifacts.delete]) {
      expect(fn).not.toHaveBeenCalledWith(LIVE_REPO);
    }
    for (const [args] of mockPush.mock.calls) {
      expect((args as { url: string }).url).not.toContain(LIVE_REPO);
    }
  });

  it("reports a ref that came back wrong or missing", async () => {
    const { env, c1, c2 } = await makeEnv();
    mockGetRemoteInfo.mockResolvedValue({ refs: { heads: { main: c1 } } });

    const result = await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);

    if (!result.success) throw result.error;
    expect(result.data.verification.ok).toBe(false);
    expect(result.data.verification.mismatches).toEqual([
      `refs/heads/main: expected ${c2}, found ${c1}`,
      `refs/heads/feature/x: expected ${c1}, found nothing`,
    ]);
  });

  it("says so when the refs can't be read, rather than passing", async () => {
    const { env } = await makeEnv();
    mockGetRemoteInfo.mockRejectedValue(new Error("network"));

    const result = await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);

    if (!result.success) throw result.error;
    expect(result.data.verification.ok).toBe(false);
    expect(result.data.verification.error).toBeDefined();
  });

  it("reports a stalled ref read as unverified, and still cleans up", async () => {
    const { env, artifacts } = await makeEnv();
    mockGetRemoteInfo.mockReturnValue(new Promise(() => {}));
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);
      let result: Awaited<typeof pending> | undefined;
      void pending.then((value) => {
        result = value;
      });
      for (let i = 0; i < 100 && result === undefined; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
      if (!result?.success) throw new Error("expected the drill to finish");
      expect(result.data.verification.ok).toBe(false);
      expect(result.data.verification.error).toBeDefined();
      expect(result.data.scratchDeleted).toBe(true);
      expect(artifacts.delete).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still cleans up when the push fails", async () => {
    const { env, artifacts } = await makeEnv();
    mockPush.mockRejectedValue(new Error("push refused"));

    const result = await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);

    expect(result.success).toBe(false);
    const created = artifacts.create.mock.calls[0]?.[0];
    expect(artifacts.delete).toHaveBeenCalledWith(created);
  });

  it("reports a scratch repo it could not delete", async () => {
    const { env, artifacts, c1, c2 } = await makeEnv();
    artifacts.delete.mockRejectedValue(new Error("artifacts down"));
    advertise(c1, c2);

    const result = await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);

    if (!result.success) throw result.error;
    expect(result.data.scratchDeleted).toBe(false);
    expect(result.data.repoName).toMatch(/^restore-drill-/);
  });
});

describe("a real restore", () => {
  it("recreates a missing repo under the project's own name", async () => {
    const { env, artifacts, c1, c2 } = await makeEnv();
    advertise(c1, c2);

    const result = await applyRepoRestore(env, RUN, PROJECT_ID, {}, logger);

    if (!result.success) throw result.error;
    expect(artifacts.create).toHaveBeenCalledWith(LIVE_REPO);
    expect(artifacts.delete).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ mode: "restore", verification: { ok: true } });
  });

  it("refuses to overwrite an existing repo without force", async () => {
    const { env } = await makeEnv({ existing: true });

    const result = await applyRepoRestore(env, RUN, PROJECT_ID, {}, logger);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.statusCode).toBe(409);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("overwrites with force, and never deletes the repo", async () => {
    const { env, artifacts, c1, c2 } = await makeEnv({ existing: true });
    advertise(c1, c2);

    const result = await applyRepoRestore(env, RUN, PROJECT_ID, { force: true }, logger);

    expect(result.success).toBe(true);
    expect(mockPush).toHaveBeenCalled();
    expect(artifacts.delete).not.toHaveBeenCalled();
  });
});

describe("which backups it will use", () => {
  it("accepts a good repo in a run marked unhealthy", async () => {
    // makeEnv's run manifest says healthy: false, as one failed repo would make it.
    const { env, c1, c2 } = await makeEnv();
    advertise(c1, c2);
    expect((await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger)).success).toBe(
      true,
    );
  });

  it("answers 404 for a run that never completed", async () => {
    const { env } = await makeEnv({ complete: false });
    const result = await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.statusCode).toBe(404);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("answers 404 for a project this run holds no pack for", async () => {
    const { env, artifacts } = await makeEnv({ withPack: false });
    const result = await applyRepoRestore(env, RUN, PROJECT_ID, { drill: true }, logger);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.statusCode).toBe(404);
    expect(artifacts.create).not.toHaveBeenCalled();
  });

  it("refuses a manifest that names another project", async () => {
    const { env, bucket } = await makeEnv();
    for (const suffix of ["manifest.json", "pack"]) {
      const source = await bucket.get(`${RUN}/repos/${PROJECT_ID}.${suffix}`);
      await bucket.put(
        `${RUN}/repos/other.${suffix}`,
        await (source as R2ObjectBody).arrayBuffer(),
      );
    }
    const result = await applyRepoRestore(env, RUN, "other", { drill: true }, logger);
    expect(result.success).toBe(false);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
