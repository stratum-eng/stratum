// @ts-nocheck
/**
 * Smoke Tests — Git smart-HTTP push to a workspace (ADR 005 slice 2a)
 *
 * Hits a LIVE deployed Worker backed by real Cloudflare Artifacts — the only
 * place report-status framing and real `git push` behavior are exercised.
 * Creates a workspace via the API, clones its git URL, pushes a commit, and
 * verifies it landed.
 *
 * Run with:
 *   STAGING_URL=https://stratum-staging.jlmx.workers.dev \
 *   GIT_PUSH_SMOKE_PROJECT=@you/some-project \
 *   TEST_AUTH_TOKEN=stratum_user_… \
 *   npm run test:smoke
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TARGET_URL = (process.env.STAGING_URL || "").replace(/\/$/, "");
const PROJECT = process.env.GIT_PUSH_SMOKE_PROJECT || ""; // "@ns/slug"
const TOKEN = process.env.TEST_AUTH_TOKEN || "";

const configured = Boolean(TARGET_URL && PROJECT && TOKEN);
let reachable = false;
let workspaceName = "";

const authHeaders = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

beforeAll(async () => {
  if (!configured) return;
  try {
    const health = await fetch(`${TARGET_URL}/health`, { timeout: 5000 } as RequestInit);
    if (health.status !== 200) return;
    // Create a fresh workspace to push into.
    const [ns, slug] = PROJECT.replace(/^@/, "").split("/");
    const res = await fetch(
      `${TARGET_URL}/api/workspaces/${encodeURIComponent(`@${ns}`)}/${encodeURIComponent(slug)}/workspaces`,
      { method: "POST", headers: authHeaders, body: JSON.stringify({}) },
    );
    if (res.status === 201) {
      workspaceName = ((await res.json()) as { workspace: string }).workspace;
      reachable = true;
    }
  } catch {
    reachable = false;
  }
});

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!configured || !reachable)("Git push to a workspace smoke", () => {
  function workspaceUrl(): string {
    const [ns, slug] = PROJECT.replace(/^@/, "").split("/");
    const base = TARGET_URL.replace("://", `://x:${encodeURIComponent(TOKEN)}@`);
    return `${base}/@${ns}/${slug}/workspaces/${workspaceName}.git`;
  }

  it("clones the workspace, pushes a commit, and the push is accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "stratum-push-"));
    tmpDirs.push(dir);
    execFileSync("git", ["clone", workspaceUrl(), dir], { stdio: "pipe", timeout: 60_000 });

    writeFileSync(join(dir, `smoke-${Date.now()}.txt`), "pushed over git\n");
    execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.email=smoke@test.io",
        "-c",
        "user.name=smoke",
        "commit",
        "-m",
        "smoke push",
      ],
      { stdio: "pipe" },
    );
    // Throws on non-zero exit (a rejected push) — that is the assertion.
    execFileSync("git", ["-C", dir, "push", "origin", "HEAD:main"], {
      stdio: "pipe",
      timeout: 60_000,
    });
  });

  it("a re-clone sees the pushed commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "stratum-push-verify-"));
    tmpDirs.push(dir);
    execFileSync("git", ["clone", workspaceUrl(), dir], { stdio: "pipe", timeout: 60_000 });
    const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toContain("smoke push");
  });
});
