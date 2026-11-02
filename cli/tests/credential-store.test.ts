import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StratumConfig } from "../src/config.js";

/**
 * `config.ts` resolves its path from `homedir()` at call time, so each test gets
 * a throwaway home and the real `~/.stratum` is never touched.
 */
let home: string;

async function loadConfigModule() {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => home };
  });
  return import("../src/config.js");
}

beforeEach(async () => {
  home = join(tmpdir(), `stratum-cfg-${Math.random().toString(36).slice(2)}`);
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  vi.doUnmock("node:os");
  vi.resetModules();
  // `resetModules` does not undo `vi.spyOn(globalThis, "fetch")`, and no config
  // enables `restoreMocks`. Without this a stubbed fetch leaks into later tests
  // and hides real regressions.
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

const oauthConfig = {
  host: "https://s.example",
  credential: {
    kind: "oauth" as const,
    clientId: "c1",
    accessToken: "stratum_mcp_a",
    refreshToken: "stratum_mcprt_r",
    expiresAt: "2030-01-01T00:00:00.000Z",
    scope: "mcp:read mcp:write",
  },
};

async function modeOf(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

describe("credential file permissions", () => {
  it("writes a new credential file 0600 in a 0700 directory", async () => {
    const { writeConfig } = await loadConfigModule();
    await writeConfig(oauthConfig);
    expect(await modeOf(join(home, ".stratum", "config.json"))).toBe("600");
    expect(await modeOf(join(home, ".stratum"))).toBe("700");
  });

  it("hardens an existing world-readable file and directory", async () => {
    // The upgrade path: a previous release left 0644/0755 behind. Passing `mode`
    // to writeFile/mkdir does NOT fix this, because POSIX honours it only when
    // the call creates the node — which is why the write goes via rename.
    const dir = join(home, ".stratum");
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await writeFile(join(dir, "config.json"), '{"host":"x","apiKey":"k"}', { mode: 0o644 });
    expect(await modeOf(join(dir, "config.json"))).toBe("644");

    const { writeConfig } = await loadConfigModule();
    await writeConfig(oauthConfig);

    expect(await modeOf(join(dir, "config.json"))).toBe("600");
    expect(await modeOf(dir)).toBe("700");
  });
});

describe("atomic credential writes", () => {
  it("leaves the previous credential intact when the write fails", async () => {
    const { writeConfig, readConfig } = await loadConfigModule();
    await writeConfig(oauthConfig);

    const rotated = {
      ...oauthConfig,
      credential: { ...oauthConfig.credential, refreshToken: "stratum_mcprt_r2" },
    };
    // A circular value fails inside JSON.stringify, before anything is renamed
    // over the live file — the shape of any mid-write crash.
    const poisoned = { ...rotated, credential: { ...rotated.credential } } as Record<
      string,
      unknown
    >;
    (poisoned.credential as Record<string, unknown>).self = poisoned;

    await expect(writeConfig(poisoned as unknown as StratumConfig)).rejects.toThrow();

    const survivor = await readConfig();
    expect(survivor?.credential).toMatchObject({ refreshToken: "stratum_mcprt_r" });
  });

  it("leaves no temp files behind, on success or on a failed write", async () => {
    const { writeConfig } = await loadConfigModule();
    const { readdir } = await import("node:fs/promises");
    await writeConfig(oauthConfig);

    const poisoned = { ...oauthConfig, credential: { ...oauthConfig.credential } } as Record<
      string,
      unknown
    >;
    (poisoned.credential as Record<string, unknown>).self = poisoned;
    await expect(writeConfig(poisoned as unknown as StratumConfig)).rejects.toThrow();

    const entries = await readdir(join(home, ".stratum"));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves parseable JSON once a write completes", async () => {
    const { writeConfig, readConfig } = await loadConfigModule();
    await writeConfig(oauthConfig);
    const raw = await readFile(join(home, ".stratum", "config.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect((await readConfig())?.host).toBe("https://s.example");
  });
});

describe("cross-process refresh lock", () => {
  it("serialises holders so only one runs at a time", async () => {
    const { withConfigLock } = await loadConfigModule();
    let active = 0;
    let maxActive = 0;
    const body = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return true;
    };
    await Promise.all([withConfigLock(body), withConfigLock(body), withConfigLock(body)]);
    expect(maxActive).toBe(1);
  });

  it("releases the lock when the action throws", async () => {
    const { withConfigLock } = await loadConfigModule();
    await expect(withConfigLock(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(withConfigLock(async () => "recovered")).resolves.toBe("recovered");
  });

  it("breaks a stale lock left by a dead process", async () => {
    const { withConfigLock } = await loadConfigModule();
    const dir = join(home, ".stratum");
    await mkdir(dir, { recursive: true });
    const lock = join(dir, "config.lock");
    await writeFile(lock, "");
    const old = new Date(Date.now() - 5 * 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lock, old, old);

    await expect(withConfigLock(async () => "proceeded")).resolves.toBe("proceeded");
  });
});

describe("rotation under contention", () => {
  it("adopts the winner's token instead of replaying a retired one", async () => {
    // Replaying a retired refresh token is what makes the server revoke the whole
    // grant, so a provider that waited on the lock must re-read and use what it
    // finds rather than the token it started with.
    const { writeConfig, providerFor, readConfig } = await loadConfigModule();
    await writeConfig({
      ...oauthConfig,
      credential: { ...oauthConfig.credential, expiresAt: "2020-01-01T00:00:00.000Z" },
    });

    // Simulate the winner having already rotated and persisted.
    await writeConfig({
      ...oauthConfig,
      credential: {
        ...oauthConfig.credential,
        refreshToken: "stratum_mcprt_WINNER",
        accessToken: "stratum_mcp_WINNER",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });

    expect(await readConfig()).not.toBeNull();
    // The regression path would POST to s.example. Stub it so that path fails
    // instantly and offline, instead of waiting on a real DNS lookup.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in unit tests"));
    const provider = providerFor({
      host: oauthConfig.host,
      credential: { ...oauthConfig.credential, expiresAt: "2020-01-01T00:00:00.000Z" },
    });

    // Resolving at all is the proof: the stale credential is expired, so any
    // path that did NOT adopt the stored token would call the real token
    // endpoint at s.example and fail rather than return the winner's token.
    await expect(provider.token()).resolves.toBe("stratum_mcp_WINNER");
  });
});

describe("lock ownership", () => {
  it("does not delete a lock it no longer owns", async () => {
    // Without an ownership check, a holder that was broken as stale deletes the
    // NEXT holder's lock on its way out, and mutual exclusion is gone for good.
    const { withConfigLock } = await loadConfigModule();
    const dir = join(home, ".stratum");
    await mkdir(dir, { recursive: true });
    const lock = join(dir, "config.lock");

    let observed: string | null = null;
    await withConfigLock(async () => {
      // Simulate being broken as stale: someone replaces our lock with theirs.
      await writeFile(lock, "another-processes-nonce");
      observed = await readFile(lock, "utf-8");
    });

    expect(observed).toBe("another-processes-nonce");
    // Ours released without destroying theirs.
    await expect(readFile(lock, "utf-8")).resolves.toBe("another-processes-nonce");
    await rm(lock, { force: true });
  });

  it("reports a directory at the lock path instead of wedging forever", async () => {
    const { withConfigLock } = await loadConfigModule();
    const dir = join(home, ".stratum");
    await mkdir(join(dir, "config.lock"), { recursive: true });
    await expect(withConfigLock(async () => "unreachable")).rejects.toThrow(/is a directory/);
  });

  it("does not re-run the action when the action itself raises EEXIST", async () => {
    // mkdir on a path that exists as a file raises EEXIST — the same errno as a
    // busy lock. Conflating them re-runs a rotation with a spent refresh token.
    const { withConfigLock } = await loadConfigModule();
    let runs = 0;
    const failing = async () => {
      runs += 1;
      const err = new Error("EEXIST: file already exists") as Error & { code: string };
      err.code = "EEXIST";
      throw err;
    };
    await expect(withConfigLock(failing)).rejects.toThrow(/EEXIST/);
    expect(runs).toBe(1);
  });
});

describe("credential replaced while refreshing", () => {
  async function providerAgainstStored(stored: unknown) {
    const mod = await loadConfigModule();
    const dir = join(home, ".stratum");
    await mkdir(dir, { recursive: true });
    if (stored !== null) {
      await writeFile(join(dir, "config.json"), JSON.stringify(stored), { mode: 0o600 });
    }
    return mod.providerFor({
      host: "https://s.example",
      credential: { ...oauthConfig.credential, expiresAt: "2020-01-01T00:00:00.000Z" },
    });
  }

  it("refuses to rotate after a logout instead of recreating the file", async () => {
    const provider = await providerAgainstStored(null);
    await expect(provider.token()).rejects.toThrow(/removed, or you logged out/);
  });

  it("refuses to rotate when the stored credential is now an API token", async () => {
    const provider = await providerAgainstStored({ host: "https://s.example", apiKey: "k" });
    await expect(provider.token()).rejects.toThrow(/now an API token/);
  });

  it("refuses to send this host's refresh token to a different host", async () => {
    const provider = await providerAgainstStored({
      host: "https://other.example",
      oauth: { ...oauthConfig.credential, kind: undefined },
    });
    await expect(provider.token()).rejects.toThrow(/now belongs to https:\/\/other\.example/);
  });
});
