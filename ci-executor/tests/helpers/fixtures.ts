import type { ExecutorConfig } from "../../src/config";
import type { Job } from "../../src/dispatch";

export const SECRET = "executor-shared-secret-0123456789abcdef";
export const STRATUM = "https://stratum.example.com";
export const REPO_PASSWORD = "art_v1_SUPERSECRETTOKEN0123456789";
export const REPO_URL = "https://acct.artifacts.cloudflare.net/git/ns/prj-app.git";

export const BASE_SHA = "a".repeat(40);
export const HEAD_SHA = "b".repeat(40);
export const HEAD_TREE_SHA = "c".repeat(40);

export const CONFIG: ExecutorConfig = {
  secret: SECRET,
  stratumOrigin: STRATUM,
  maxConcurrentJobs: 2,
  maxQueuedJobs: 2,
  defaultInstance: "standard-1",
  maxInstance: "standard-2",
  maxJobSeconds: 3600,
  allowProjectHosts: true,
  gitHostSuffix: ".artifacts.cloudflare.net",
  logMaxBytes: 1024 * 1024,
};

/** A dispatch body as Stratum sends it. `now` anchors its deadlines. */
export function dispatchBody(now: number, overrides: Record<string, unknown> = {}) {
  const job = {
    profile: "ci",
    steps: [
      { name: "lint", run: "npm run lint", timeoutSeconds: 600 },
      { name: "test", run: "npm test", timeoutSeconds: 600 },
    ],
    timeoutSeconds: 1800,
    allowHosts: [],
    repository: {
      url: REPO_URL,
      username: "x",
      password: REPO_PASSWORD,
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
    },
    logUrls: {
      lint: `${STRATUM}/api/changes/chg_1/checks/chk_lint/log`,
      test: `${STRATUM}/api/changes/chg_1/checks/chk_test/log`,
    },
    ...((overrides.job as Record<string, unknown> | undefined) ?? {}),
  };
  return {
    event: "checks.requested",
    changeId: "chg_1",
    project: "@owner/app",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    headTreeSha: HEAD_TREE_SHA,
    diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    checkRunIds: { lint: "chk_lint", test: "chk_test" },
    callbackUrl: `${STRATUM}/api/checks`,
    deadline: new Date(now + 47 * 60_000).toISOString(),
    ...overrides,
    job,
  };
}

/** A validated job, as `parseDispatch` would produce it. */
export function makeJob(now: number, overrides: Partial<Job> = {}): Job {
  return {
    changeId: "chg_1",
    project: "@owner/app",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    headTreeSha: HEAD_TREE_SHA,
    diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    callbackUrl: `${STRATUM}/api/checks`,
    deadline: now + 47 * 60_000,
    profile: {
      name: "ci",
      image: "ci",
      allowedHosts: ["registry.npmjs.org", "registry.yarnpkg.com", "nodejs.org"],
    },
    steps: [
      {
        name: "lint",
        run: "npm run lint",
        timeoutSeconds: 600,
        checkRunId: "chk_lint",
        logUrl: `${STRATUM}/api/changes/chg_1/checks/chk_lint/log`,
      },
      {
        name: "test",
        run: "npm test",
        timeoutSeconds: 600,
        checkRunId: "chk_test",
        logUrl: `${STRATUM}/api/changes/chg_1/checks/chk_test/log`,
      },
    ],
    timeoutSeconds: 1800,
    instance: "standard-1",
    repository: {
      url: REPO_URL,
      authorization: `Basic ${btoa(`x:${REPO_PASSWORD}`)}`,
      expiresAt: now + 60 * 60_000,
    },
    ...overrides,
  };
}
