// @ts-nocheck
/**
 * Smoke Tests — Git smart-HTTP clone/fetch (ADR 005, slice 1)
 *
 * These hit a LIVE deployed Worker backed by real Cloudflare Artifacts — the
 * only place the proxy's pkt-line framing, gzip, protocol-v2 negotiation, and
 * redirect handling are actually exercised. Offline unit tests (stubbed fetch)
 * cannot prove a real `git clone` works; this is the gate that does.
 *
 * Run with:
 *   STAGING_URL=https://staging.app.usestratum.dev \
 *   GIT_SMOKE_REPO=@someuser/some-public-repo \
 *   [TEST_AUTH_TOKEN=stratum_user_…] \
 *   npm run test:smoke
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TARGET_URL = process.env.STAGING_URL || process.env.PRODUCTION_URL || "";
const REPO = process.env.GIT_SMOKE_REPO || ""; // e.g. "@alice/my-public-repo"
const TOKEN = process.env.TEST_AUTH_TOKEN || "";

const configured = Boolean(TARGET_URL && REPO);
let reachable = false;

beforeAll(async () => {
  if (!configured) return;
  try {
    const response = await fetch(`${TARGET_URL}/health`, { timeout: 5000 } as RequestInit);
    reachable = response.status === 200;
  } catch {
    reachable = false;
  }
});

const cloneBase = `${TARGET_URL.replace(/\/$/, "")}/${REPO}.git`;
const authedBase = TOKEN
  ? cloneBase.replace("://", `://x:${encodeURIComponent(TOKEN)}@`)
  : cloneBase;

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!configured || !reachable)(`Git clone smoke — ${cloneBase}`, () => {
  it("advertises git-upload-pack with the correct content-type and pkt-line preamble", async () => {
    const res = await fetch(`${cloneBase}/info/refs?service=git-upload-pack`, {
      headers: TOKEN ? { Authorization: `Basic ${btoa(`x:${TOKEN}`)}` } : {},
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const body = await res.text();
    // Smart-HTTP advertisement starts with the service pkt-line.
    expect(body).toContain("# service=git-upload-pack");
  });

  it("refuses git-receive-pack (push) with 403", async () => {
    const res = await fetch(`${cloneBase}/info/refs?service=git-receive-pack`, {
      headers: TOKEN ? { Authorization: `Basic ${btoa(`x:${TOKEN}`)}` } : {},
    });
    expect(res.status).toBe(403);
  });

  it("clones the repo end-to-end with stock git", () => {
    const dir = mkdtempSync(join(tmpdir(), "stratum-clone-"));
    tmpDirs.push(dir);
    execFileSync("git", ["clone", "--depth", "1", authedBase, dir], {
      stdio: "pipe",
      timeout: 60_000,
    });
    const entries = readdirSync(dir);
    expect(entries).toContain(".git");
    expect(entries.length).toBeGreaterThan(1);
  });

  it("fetches again without error", () => {
    const dir = mkdtempSync(join(tmpdir(), "stratum-fetch-"));
    tmpDirs.push(dir);
    execFileSync("git", ["clone", "--depth", "1", authedBase, dir], {
      stdio: "pipe",
      timeout: 60_000,
    });
    execFileSync("git", ["-C", dir, "fetch", "--depth", "1", "origin"], {
      stdio: "pipe",
      timeout: 60_000,
    });
  });
});
