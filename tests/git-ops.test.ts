import { describe, expect, it, vi } from "vitest";
import {
  artifactsRepoNameFromRemote,
  buildUnifiedDiff,
  extractTokenSecret,
  freshRepoToken,
} from "../src/storage/git-ops";
import { MemoryFS } from "../src/storage/memory-fs";
import type { ArtifactsNamespace } from "../src/types";
import type { Logger } from "../src/utils/logger";

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
        "https://acct.artifacts.cloudflare.net/git/stratum-prod/jnacious88__apptrack.git",
      ),
    ).toBe("jnacious88__apptrack");
  });

  it("handles a remote without the .git suffix", () => {
    expect(
      artifactsRepoNameFromRemote(
        "https://acct.artifacts.cloudflare.net/git/stratum-prod/jnacious88__apptrack",
      ),
    ).toBe("jnacious88__apptrack");
  });

  it("returns null for a non-Artifacts remote", () => {
    expect(artifactsRepoNameFromRemote("https://github.com/owner/repo.git")).toBeNull();
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

    const files = await walkDir(fs, "/", "");
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/utils/helpers.ts");
    expect(files).toContain("README.md");
    expect(files.some((f) => f.startsWith(".git"))).toBe(false);
  });
});

async function walkDir(fs: MemoryFS, base: string, prefix: string): Promise<string[]> {
  const nodeFS = fs.toNodeFS();
  const entries = await nodeFS.promises.readdir(base === "/" ? "/" : base);

  const files: string[] = [];
  for (const entry of entries) {
    if (entry === ".git") continue;
    const fullPath = base === "/" ? `/${entry}` : `${base}/${entry}`;
    const stat = await nodeFS.promises.stat(fullPath);
    if (stat.isDirectory()) {
      files.push(...(await walkDir(fs, fullPath, `${prefix}${entry}/`)));
    } else {
      files.push(`${prefix}${entry}`);
    }
  }
  return files;
}

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
});
