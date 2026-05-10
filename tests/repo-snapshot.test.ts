import { describe, expect, it, vi } from "vitest";
import {
  type RepoSnapshot,
  SNAPSHOT_COMMIT_LIMIT,
  readRepoSnapshot,
  writeRepoSnapshot,
  writeSnapshotFromRepo,
} from "../src/storage/repo-snapshot";
import { defaultLogger } from "../src/utils/logger";

function makeKV(stored: Record<string, string> = {}): {
  put: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  const data = { ...stored };
  return {
    put: vi.fn(async (_key: string, value: string) => {
      data[_key] = value;
    }),
    get: vi.fn(async (key: string) => data[key] ?? null),
    delete: vi.fn(async (key: string) => {
      delete data[key];
    }),
  };
}

const project = { namespace: "@jlmx", slug: "myrepo" };

const validData: Omit<RepoSnapshot, "snapshotAt" | "v"> = {
  files: ["README.md", "src/index.ts"],
  commits: [{ sha: "abc1234", message: "init", author: "Dev <dev@example.com>", timestamp: 1000 }],
  readme: "# Hello",
  readmeTruncated: false,
};

function assertSuccess<T>(result: {
  success: boolean;
  data?: T;
  error?: unknown;
}): asserts result is { success: true; data: T } {
  if (!result.success) throw new Error(`Expected success but got error: ${String(result.error)}`);
}

describe("SNAPSHOT_COMMIT_LIMIT", () => {
  it("is 20", () => {
    expect(SNAPSHOT_COMMIT_LIMIT).toBe(20);
  });
});

describe("snapshotKey encoding (via writeRepoSnapshot)", () => {
  it("encodes colons in namespace", async () => {
    const kv = makeKV();
    await writeRepoSnapshot(
      kv as never,
      { namespace: "a:b", slug: "c:d" },
      validData,
      defaultLogger,
    );
    const key = kv.put.mock.calls[0]?.[0] as string;
    expect(key).toBe("repo_snapshot:a%3Ab:c%3Ad");
  });

  it("encodes slashes in slug", async () => {
    const kv = makeKV();
    await writeRepoSnapshot(
      kv as never,
      { namespace: "@ns", slug: "foo/bar" },
      validData,
      defaultLogger,
    );
    const key = kv.put.mock.calls[0]?.[0] as string;
    expect(key).toContain("foo%2Fbar");
  });
});

describe("writeRepoSnapshot", () => {
  it("calls kv.put with correct key, value and expirationTtl", async () => {
    const kv = makeKV();
    const result = await writeRepoSnapshot(kv as never, project, validData, defaultLogger);
    expect(result.success).toBe(true);
    expect(kv.put).toHaveBeenCalledOnce();
    const key = kv.put.mock.calls[0]?.[0] as string;
    const value = kv.put.mock.calls[0]?.[1] as string;
    const opts = kv.put.mock.calls[0]?.[2] as { expirationTtl: number };
    expect(key).toBe("repo_snapshot:%40jlmx:myrepo");
    expect(opts.expirationTtl).toBe(604800);
    const parsed = JSON.parse(value) as RepoSnapshot;
    expect(parsed.v).toBe(1);
    expect(parsed.files).toEqual(validData.files);
    expect(parsed.snapshotAt).toMatch(/Z$/);
  });

  it("returns err on KV failure", async () => {
    const kv = makeKV();
    kv.put.mockRejectedValue(new Error("KV unavailable"));
    const result = await writeRepoSnapshot(kv as never, project, validData, defaultLogger);
    expect(result.success).toBe(false);
  });
});

describe("readRepoSnapshot", () => {
  it("returns ok(null) on cache miss", async () => {
    const kv = makeKV();
    const result = await readRepoSnapshot(kv as never, project, defaultLogger);
    assertSuccess(result);
    expect(result.data).toBeNull();
  });

  it("returns ok(snapshot) on valid cache hit", async () => {
    const stored: RepoSnapshot = { v: 1, ...validData, snapshotAt: new Date().toISOString() };
    const kv = makeKV({ "repo_snapshot:%40jlmx:myrepo": JSON.stringify(stored) });
    const result = await readRepoSnapshot(kv as never, project, defaultLogger);
    assertSuccess(result);
    expect(result.data?.files).toEqual(validData.files);
    expect(result.data?.v).toBe(1);
  });

  it("returns ok(null) and deletes key on malformed JSON", async () => {
    const kv = makeKV({ "repo_snapshot:%40jlmx:myrepo": "not-json{{{" });
    const result = await readRepoSnapshot(kv as never, project, defaultLogger);
    assertSuccess(result);
    expect(result.data).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(kv.delete).toHaveBeenCalledWith("repo_snapshot:%40jlmx:myrepo");
  });

  it("returns ok(null) and deletes key on version mismatch", async () => {
    const stale = {
      v: 2,
      files: [],
      commits: [],
      readme: null,
      readmeTruncated: false,
      snapshotAt: "",
    };
    const kv = makeKV({ "repo_snapshot:%40jlmx:myrepo": JSON.stringify(stale) });
    const result = await readRepoSnapshot(kv as never, project, defaultLogger);
    assertSuccess(result);
    expect(result.data).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(kv.delete).toHaveBeenCalled();
  });

  it("returns ok(null) without throwing on KV error", async () => {
    const kv = makeKV();
    kv.get.mockRejectedValue(new Error("KV down"));
    const result = await readRepoSnapshot(kv as never, project, defaultLogger);
    assertSuccess(result);
    expect(result.data).toBeNull();
  });
});

describe("writeSnapshotFromRepo", () => {
  it("does not throw when clone fails", async () => {
    const kv = makeKV();
    await expect(
      writeSnapshotFromRepo(
        kv as never,
        { remote: "https://0.0.0.0/fake.git", token: "x", namespace: "@ns", slug: "repo" },
        defaultLogger,
      ),
    ).resolves.toBeUndefined();
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("readmeTruncated flag", () => {
  it("round-trips readmeTruncated:false through KV write/read", async () => {
    const kv = makeKV();
    await writeRepoSnapshot(
      kv as never,
      project,
      { ...validData, readmeTruncated: false },
      defaultLogger,
    );
    const value = kv.put.mock.calls[0]?.[1] as string;
    const stored = JSON.parse(value) as RepoSnapshot;
    expect(stored.readmeTruncated).toBe(false);
  });

  it("round-trips readmeTruncated:true through KV write/read", async () => {
    const kv = makeKV();
    const bigReadme = "x".repeat(110 * 1024);
    await writeRepoSnapshot(
      kv as never,
      project,
      { ...validData, readme: bigReadme, readmeTruncated: true },
      defaultLogger,
    );
    const value = kv.put.mock.calls[0]?.[1] as string;
    const stored = JSON.parse(value) as RepoSnapshot;
    expect(stored.readmeTruncated).toBe(true);
  });
});
