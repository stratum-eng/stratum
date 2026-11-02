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
 *   GIT_SMOKE_TAG=v1.0.0 \
 *   [GIT_SMOKE_BRANCH=main] \
 *   [TEST_AUTH_TOKEN=stratum_user_…] \
 *   npm run test:smoke
 *
 * Fixture contract for `GIT_SMOKE_REPO`:
 *   - It must be readable over smart HTTP with the supplied token (or public).
 *   - It must contain the tag named by `GIT_SMOKE_TAG` (lightweight or
 *     annotated). The isomorphic-git tag-fetch test below fetches exactly that
 *     tag and fails if the local `refs/tags/<GIT_SMOKE_TAG>` ref isn't created
 *     (#285). With `GIT_SMOKE_TAG` unset that one test is skipped; the
 *     stock-git tests still run.
 *   - `GIT_SMOKE_BRANCH` (default `main`) is the branch the tag-fetch test
 *     clones first (as `cloneRepo` does); set it if the fixture's default
 *     branch differs.
 *
 * Without `STAGING_URL`/`PRODUCTION_URL` and `GIT_SMOKE_REPO` the whole file
 * is skipped, so a plain offline `vitest run` makes no network calls.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneRepo, fetchRemoteTag } from "../../src/storage/git-ops";
import { defaultLogger } from "../../src/utils/logger";

const TARGET_URL = process.env.STAGING_URL || process.env.PRODUCTION_URL || "";
const REPO = process.env.GIT_SMOKE_REPO || ""; // e.g. "@alice/my-public-repo"
const TOKEN = process.env.TEST_AUTH_TOKEN || "";
const TAG = process.env.GIT_SMOKE_TAG || ""; // must exist in GIT_SMOKE_REPO
const BRANCH = process.env.GIT_SMOKE_BRANCH || "main";

const configured = Boolean(TARGET_URL && REPO);
let reachable = false;

beforeAll(async () => {
  if (!configured) return;
  try {
    // `RequestInit.timeout` is non-standard and ignored by the runtime's fetch;
    // use an abort signal so an unresponsive endpoint fails promptly.
    const response = await fetch(`${TARGET_URL}/health`, { signal: AbortSignal.timeout(5000) });
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

// `configured` is known at load time (env vars); `reachable` is only set in
// beforeAll, after describe-level skip conditions were already evaluated, so
// each test skips on it at run time instead.
describe.skipIf(!configured)(`Git clone smoke — ${cloneBase}`, () => {
  it("advertises git-upload-pack with the correct content-type and pkt-line preamble", async (ctx) => {
    if (!reachable) ctx.skip();
    const res = await fetch(`${cloneBase}/info/refs?service=git-upload-pack`, {
      headers: TOKEN ? { Authorization: `Basic ${btoa(`x:${TOKEN}`)}` } : {},
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const body = await res.text();
    // Smart-HTTP advertisement starts with the service pkt-line.
    expect(body).toContain("# service=git-upload-pack");
  });

  it("refuses git-receive-pack (push) with 403", async (ctx) => {
    if (!reachable) ctx.skip();
    const res = await fetch(`${cloneBase}/info/refs?service=git-receive-pack`, {
      headers: TOKEN ? { Authorization: `Basic ${btoa(`x:${TOKEN}`)}` } : {},
    });
    expect(res.status).toBe(403);
  });

  it("clones the repo end-to-end with stock git", (ctx) => {
    if (!reachable) ctx.skip();
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

  it("fetches again without error", (ctx) => {
    if (!reachable) ctx.skip();
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

// Uses the REAL isomorphic-git client and Stratum's own http client through
// `fetchRemoteTag` — the exact per-tag fetch `cloneRepo({ includeTags })`
// runs — rather than the stock git CLI above or the unit suite's stubbed
// `git.fetch`. Fails if that fetch stops creating the local tag ref, e.g. if
// its load-bearing `tags: true` option is removed (#285).
describe.skipIf(!configured || !TAG)(`isomorphic-git tag fetch smoke — ${REPO} ${TAG}`, () => {
  it("fetches the configured tag and creates the local refs/tags/<name> ref", async (ctx) => {
    if (!reachable) ctx.skip();
    // Same sequence as `cloneRepo({ includeTags: true })`: a singleBranch clone
    // (which never brings tags down), then the per-tag fetch. Calling
    // `fetchRemoteTag` directly fetches exactly GIT_SMOKE_TAG, independent of
    // MAX_TAGS truncation.
    const cloned = await cloneRepo(cloneBase, TOKEN, defaultLogger, {
      ref: BRANCH,
      timeoutMs: 60_000,
    });
    if (!cloned.success) throw cloned.error;
    const { fs, dir } = cloned.data;

    await fetchRemoteTag(fs, cloneBase, TOKEN, TAG, { timeoutMs: 60_000 });

    const tagRefs = await git.listRefs({ fs, dir, filepath: "refs/tags" });
    expect(tagRefs, `local refs/tags/${TAG} was not created by the tag fetch`).toContain(TAG);
    const oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${TAG}` });
    // The ref must point at an object the fetch actually brought down.
    const { type } = await git.readObject({ fs, dir, oid, format: "parsed" });
    expect(["tag", "commit"]).toContain(type);
  });
});
