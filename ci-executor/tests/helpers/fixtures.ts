import type { DeployTargets, ExecutorConfig } from "../../src/config";
import type { DeployContext, Job } from "../../src/dispatch";

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
  maxQueuedDeployJobs: 2,
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
    origin: "project",
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

// ------------------------------------------------------------------ deploys

/** The VALUE of the deploy credential. Tests assert this string goes nowhere but upstream. */
export const DEPLOY_TOKEN = "cf-deploy-token-VERYSECRET-0123456789";
export const DEPLOY_SECRET = "DEPLOY_CRED_STAGING";
export const DEPLOY_PROJECT_ID = "prj_app";
export const DEPLOY_ID = "dep_0123456789abcdef";
export const COMMIT_SHA = "d".repeat(40);

export const DEPLOY_TARGETS: DeployTargets = {
  [DEPLOY_PROJECT_ID]: {
    staging: {
      credentials: [{ host: "api.cloudflare.com", secret: DEPLOY_SECRET }],
      env: { CLOUDFLARE_ACCOUNT_ID: "acct123" },
      allowHosts: ["app-staging.example.workers.dev"],
    },
  },
};

/** The executor's own deploy configuration, with every named secret set. */
export const DEPLOY_CONTEXT: DeployContext = {
  targets: { ok: true, targets: DEPLOY_TARGETS },
  hasSecret: (name) => name === DEPLOY_SECRET,
};

/** A deploy dispatch body as Stratum sends it. Note what is absent: any credential for the target. */
export function deployDispatchBody(now: number, overrides: Record<string, unknown> = {}) {
  const job = {
    profile: "deploy",
    steps: [
      {
        name: "migrate",
        run: "npx wrangler d1 migrations apply app --remote",
        timeoutSeconds: 600,
      },
      { name: "deploy", run: "npx wrangler deploy", timeoutSeconds: 600 },
      {
        name: "smoke",
        run: "curl -sf https://app-staging.example.workers.dev/health",
        timeoutSeconds: 120,
      },
    ],
    timeoutSeconds: 1800,
    allowHosts: [],
    repository: {
      url: REPO_URL,
      username: "x",
      password: REPO_PASSWORD,
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
    },
    logUrl: `${STRATUM}/@owner/app/deployments/${DEPLOY_ID}`,
    ...((overrides.job as Record<string, unknown> | undefined) ?? {}),
  };
  return {
    event: "deploy.requested",
    deploymentId: DEPLOY_ID,
    project: "@owner/app",
    projectId: DEPLOY_PROJECT_ID,
    environment: "staging",
    commitSha: COMMIT_SHA,
    callbackUrl: `${STRATUM}/api/deployments/callback`,
    deadline: new Date(now + 47 * 60_000).toISOString(),
    ...overrides,
    job,
  };
}

/** A validated deploy job, as `parseDispatch` would produce it. */
export function makeDeployJob(now: number, overrides: Partial<Job> = {}): Job {
  const logUrl = `${STRATUM}/@owner/app/deployments/${DEPLOY_ID}`;
  const step = (name: string, run: string, index: number) => ({
    name,
    run,
    timeoutSeconds: 600,
    checkRunId: `${DEPLOY_ID}-${index}`,
    logUrl,
  });
  return {
    changeId: DEPLOY_ID,
    project: "@owner/app",
    baseSha: COMMIT_SHA,
    headSha: COMMIT_SHA,
    headTreeSha: "",
    diff: "",
    deploy: {
      deploymentId: DEPLOY_ID,
      projectId: DEPLOY_PROJECT_ID,
      environment: "staging",
      env: { CLOUDFLARE_ACCOUNT_ID: "acct123" },
    },
    callbackUrl: `${STRATUM}/api/deployments/callback`,
    deadline: now + 47 * 60_000,
    profile: {
      name: "deploy",
      image: "deploy",
      allowedHosts: ["registry.npmjs.org", "app-staging.example.workers.dev"],
      credentials: [{ host: "api.cloudflare.com", secret: DEPLOY_SECRET }],
    },
    steps: [
      step("migrate", "npx wrangler d1 migrations apply app --remote", 0),
      step("deploy", "npx wrangler deploy", 1),
      step("smoke", "curl -sf https://app-staging.example.workers.dev/health", 2),
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
