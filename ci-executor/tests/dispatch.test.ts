import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { parseDispatch, profileAllowedForOrigin } from "../src/dispatch";
import { CONFIG, REPO_PASSWORD, SECRET, STRATUM, dispatchBody } from "./helpers/fixtures";

const NOW = Date.UTC(2026, 10, 9, 12);

function parse(overrides: Record<string, unknown> = {}, config = CONFIG) {
  return parseDispatch(JSON.stringify(dispatchBody(NOW, overrides)), config);
}

function reason(overrides: Record<string, unknown>, config = CONFIG): string {
  const result = parse(overrides, config);
  if (result.ok) throw new Error("dispatch was accepted");
  return result.reason;
}

describe("a valid dispatch", () => {
  it("becomes a job with the executor's defaults filled in", () => {
    const result = parse();
    if (!result.ok) throw new Error(result.reason);
    const { job } = result;

    expect(job.instance).toBe("standard-1");
    expect(job.profile).toEqual({
      name: "ci",
      image: "ci",
      allowedHosts: ["registry.npmjs.org", "registry.yarnpkg.com", "nodejs.org"],
    });
    expect(job.steps.map((step) => [step.name, step.checkRunId])).toEqual([
      ["lint", "chk_lint"],
      ["test", "chk_test"],
    ]);
    expect(job.repository.authorization).toBe(`Basic ${btoa(`x:${REPO_PASSWORD}`)}`);
    expect(job.callbackUrl).toBe(`${STRATUM}/api/checks`);
  });

  it("carries only the fields it validated", () => {
    const result = parse({ smuggled: "value", job: { smuggled: true } });
    if (!result.ok) throw new Error(result.reason);
    expect(JSON.stringify(result.job)).not.toContain("smuggled");
  });

  it("adds a project's hosts to the default allowlist", () => {
    const result = parse({ job: { allowHosts: ["registry.example.com", "nodejs.org"] } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.job.profile.allowedHosts).toEqual([
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "nodejs.org",
      "registry.example.com",
    ]);
  });

  it("accepts every name Stratum accepts for a check, including a namespaced one", () => {
    const result = parse({
      checkRunIds: { "ci/lint": "chk_1", "unit.tests_v2-fast": "chk_2" },
      job: {
        steps: [
          { name: "ci/lint", run: "a", timeoutSeconds: 60 },
          { name: "unit.tests_v2-fast", run: "b", timeoutSeconds: 60 },
        ],
        logUrls: { "ci/lint": `${STRATUM}/l/1`, "unit.tests_v2-fast": `${STRATUM}/l/2` },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("grants a larger instance up to the executor's maximum", () => {
    const result = parse({ job: { instance: "standard-2" } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.job.instance).toBe("standard-2");
  });
});

describe("what the executor's own limits refuse", () => {
  it("an instance above the configured maximum", () => {
    expect(reason({ job: { instance: "standard-4" } })).toMatch(/larger than this executor allows/);
  });

  it("an unknown instance name", () => {
    expect(reason({ job: { instance: "huge" } })).toMatch(/instance must be one of/);
  });

  it("a job longer than the configured maximum", () => {
    expect(reason({ job: { timeoutSeconds: 7200 } })).toMatch(/time limit/);
  });

  it("extra hosts when the operator has turned that off", () => {
    const locked = { ...CONFIG, allowProjectHosts: false };
    expect(reason({ job: { allowHosts: ["registry.example.com"] } }, locked)).toMatch(
      /does not let a project extend/,
    );
    // The defaults are still the defaults.
    expect(parse({ job: { allowHosts: ["nodejs.org"] } }, locked).ok).toBe(true);
  });

  it.each([
    ["a wildcard", "*.example.com"],
    ["an IP address", "10.0.0.1"],
    ["a port", "example.com:8443"],
    ["a URL", "https://example.com"],
    ["an internal name", "localhost"],
    ["the repository proxy", "git.stratum.internal"],
    ["uppercase", "Example.com"],
  ])("an allowlist entry that is %s", (_name, host) => {
    expect(reason({ job: { allowHosts: [host] } })).toMatch(/allowHosts/);
  });

  it("a callback or log URL on any origin but its Stratum's", () => {
    expect(reason({ callbackUrl: "https://attacker.example.com/api/checks" })).toMatch(
      /callbackUrl/,
    );
    expect(
      reason({
        job: { logUrls: { lint: "https://attacker.example.com/l", test: `${STRATUM}/t` } },
      }),
    ).toMatch(/log URL/);
  });

  it("a repository outside the configured host suffix", () => {
    for (const url of [
      "https://github.com/owner/repo.git",
      "https://artifacts.cloudflare.net.attacker.example.com/r.git",
      "http://acct.artifacts.cloudflare.net/git/ns/r.git",
      "https://u:p@acct.artifacts.cloudflare.net/git/ns/r.git",
      "https://acct.artifacts.cloudflare.net:8443/git/ns/r.git",
      "https://acct.artifacts.cloudflare.net/git/ns/r.git?x=1",
    ]) {
      const repository = { url, username: "x", password: "p", expiresAt: "2026-11-09T13:00:00Z" };
      expect(reason({ job: { repository } }), url).toMatch(/repository.url/);
    }
  });
});

describe("a job for an external change", () => {
  it("is accepted under the ci profile, and keeps its origin", () => {
    const result = parse({ job: { origin: "external" } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.job.origin).toBe("external");
    expect(result.job.profile.name).toBe("ci");
  });

  it("treats a dispatch that does not say as the project's own", () => {
    const result = parse();
    if (!result.ok) throw new Error(result.reason);
    expect(result.job.origin).toBe("project");
  });

  it("is refused under any other profile, for the reason that it is external", () => {
    // The reason matters: it shows the origin rule fired, not merely the
    // "no such profile" rule that a future deploy profile will relax.
    expect(reason({ job: { origin: "external", profile: "deploy" } })).toMatch(/external change/);
    expect(reason({ job: { origin: "external", profile: "publish" } })).toMatch(/external change/);
  });

  it("is refused for an origin the executor does not know", () => {
    expect(reason({ job: { origin: "trusted" } })).toMatch(/origin/);
  });

  it("can never be given a profile other than ci, whatever profiles exist", () => {
    for (const profile of ["deploy", "publish", "release", "", undefined, null, 1]) {
      expect(profileAllowedForOrigin(profile, "external")).toBe(false);
    }
    expect(profileAllowedForOrigin("ci", "external")).toBe(true);
    // The rule constrains external jobs only.
    expect(profileAllowedForOrigin("deploy", "project")).toBe(true);
  });
});

describe("malformed dispatches", () => {
  it("is refused for a body that is not a JSON object", () => {
    expect(parseDispatch("not json", CONFIG).ok).toBe(false);
    expect(parseDispatch("[]", CONFIG).ok).toBe(false);
  });

  it.each([
    ["another event", { event: "checks.completed" }],
    ["a short commit id", { baseSha: "abc123" }],
    ["a missing tree id", { headTreeSha: undefined }],
    ["a ref instead of a commit id", { headSha: "refs/heads/main" }],
    ["a non-string diff", { diff: 5 }],
    ["an unparseable deadline", { deadline: "soon" }],
    ["another profile", { job: { profile: "deploy" } }],
    ["no steps", { job: { steps: [] } }],
    ["a step with no command", { job: { steps: [{ name: "lint", run: "", timeoutSeconds: 60 }] } }],
    ["a step with no check run", { job: { steps: [{ name: "x", run: "y", timeoutSeconds: 60 }] } }],
    [
      "a step named like a relative path",
      { job: { steps: [{ name: "../lint", run: "y", timeoutSeconds: 60 }] } },
    ],
    [
      "a duplicate step",
      {
        job: {
          steps: [
            { name: "lint", run: "a", timeoutSeconds: 60 },
            { name: "lint", run: "b", timeoutSeconds: 60 },
          ],
        },
      },
    ],
    [
      "a sub-minute step limit",
      { job: { steps: [{ name: "lint", run: "a", timeoutSeconds: 5 }] } },
    ],
    [
      "credentials that are not ASCII",
      {
        job: {
          repository: {
            url: "https://acct.artifacts.cloudflare.net/git/ns/r.git",
            username: "x",
            password: "pässword",
            expiresAt: "2026-11-09T13:00:00Z",
          },
        },
      },
    ],
  ])("is refused for %s", (_name, overrides) => {
    expect(parse(overrides).ok).toBe(false);
  });

  it("refuses more steps than the limit", () => {
    const steps = Array.from({ length: 17 }, (_, i) => ({
      name: `s${i}`,
      run: "true",
      timeoutSeconds: 60,
    }));
    expect(reason({ job: { steps } })).toMatch(/1 to 16 steps/);
  });
});

describe("executor configuration", () => {
  const ENV = {
    CI_EXECUTOR_SECRET: SECRET,
    STRATUM_ORIGIN: STRATUM,
    CI_MAX_CONCURRENT_JOBS: "2",
  };

  it("reads a minimal configuration with conservative defaults", () => {
    const result = readConfig(ENV);
    if (!result.ok) throw new Error(result.reason);
    expect(result.config).toMatchObject({
      maxConcurrentJobs: 2,
      maxQueuedJobs: 10,
      defaultInstance: "standard-1",
      maxInstance: "standard-2",
      maxJobSeconds: 3600,
      allowProjectHosts: true,
      gitHostSuffix: ".artifacts.cloudflare.net",
    });
  });

  it("has no default for the concurrency limit, and no way to say unlimited", () => {
    for (const value of [undefined, "", "0", "-1", "unlimited", "Infinity", "2.5", "1e9"]) {
      const result = readConfig({ ...ENV, CI_MAX_CONCURRENT_JOBS: value });
      expect(result.ok, String(value)).toBe(false);
    }
  });

  it("refuses a missing or short secret, and never echoes it", () => {
    const result = readConfig({ ...ENV, CI_EXECUTOR_SECRET: "too-short-secret" });
    expect(result).toEqual({
      ok: false,
      reason: "CI_EXECUTOR_SECRET is not set or shorter than 32 characters",
    });
    expect(readConfig({ ...ENV, CI_EXECUTOR_SECRET: undefined }).ok).toBe(false);
  });

  it("requires the Stratum origin, over https", () => {
    expect(readConfig({ ...ENV, STRATUM_ORIGIN: undefined }).ok).toBe(false);
    expect(readConfig({ ...ENV, STRATUM_ORIGIN: "http://stratum.example.com" }).ok).toBe(false);
    expect(readConfig({ ...ENV, STRATUM_ORIGIN: "http://localhost:8787" }).ok).toBe(true);
  });

  it("refuses a default instance larger than the maximum, and unknown sizes", () => {
    expect(
      readConfig({ ...ENV, CI_DEFAULT_INSTANCE: "standard-3", CI_MAX_INSTANCE: "standard-1" }).ok,
    ).toBe(false);
    expect(readConfig({ ...ENV, CI_MAX_INSTANCE: "enormous" }).ok).toBe(false);
  });

  it("refuses unusable values rather than guessing", () => {
    expect(readConfig({ ...ENV, CI_ALLOW_PROJECT_HOSTS: "yes" }).ok).toBe(false);
    expect(readConfig({ ...ENV, CI_MAX_QUEUED_JOBS: "many" }).ok).toBe(false);
    expect(readConfig({ ...ENV, CI_MAX_JOB_MINUTES: "0" }).ok).toBe(false);
    expect(readConfig({ ...ENV, CI_LOG_MAX_BYTES: "12" }).ok).toBe(false);
    expect(readConfig({ ...ENV, CI_GIT_HOST_SUFFIX: "*" }).ok).toBe(false);
  });
});
