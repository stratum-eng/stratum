/// <reference types="vite/client" />

/**
 * `.stratum/ci.yaml` (#415): the parser, the loader that puts it on the
 * policy, and the protection that keeps a change from editing its own gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Read via Vite's raw import, like tests/wrangler-migration-chain.test.ts, so
// this type-checks under the Workers tsconfig without node:fs.
import ownCi from "../.stratum/ci.yaml?raw";
import {
  CI_CONFIG_PATH,
  type CiConfig,
  ciStepNames,
  parseCiConfig,
  requiredCiStepNames,
} from "../src/evaluation/ci-config";
import {
  PROTECTED_CONFIG_FILES,
  diffTouchesProtectedConfig,
  loadPolicy,
  parsePolicyContent,
} from "../src/evaluation/policy-loader";
import { requiredCheckNames, staleCiSteps } from "../src/merge/protection";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { repoWithFiles } from "./helpers/repo-files";

vi.mock("../src/storage/git-ops", () => ({ readFileFromRepo: vi.fn() }));
import { readFileFromRepo } from "../src/storage/git-ops";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const CI = `
steps:
  - name: lint
    run: npm run lint
  - name: test
    run: |
      npm ci
      npm test
    timeoutMinutes: 20
  - name: audit
    run: npm audit
    optional: true
`;

async function config(yaml: string): Promise<CiConfig> {
  const parsed = await parseCiConfig(yaml);
  if (parsed.status !== "ok") throw new Error(parsed.reason);
  return parsed.config;
}

async function reason(yaml: string): Promise<string> {
  const parsed = await parseCiConfig(yaml);
  if (parsed.status === "ok") throw new Error("the file was accepted");
  return parsed.reason;
}

describe("parseCiConfig", () => {
  it("reads steps in order, with defaults for what the file leaves out", async () => {
    const ci = await config(CI);
    expect(ci.steps).toEqual([
      { name: "lint", run: "npm run lint", timeoutSeconds: 600, required: true },
      { name: "test", run: "npm ci\nnpm test\n", timeoutSeconds: 1200, required: true },
      { name: "audit", run: "npm audit", timeoutSeconds: 600, required: false },
    ]);
    expect(ci.timeoutSeconds).toBe(1800);
    expect(ci.instance).toBeUndefined();
    expect(ci.allowHosts).toEqual([]);
    expect(ciStepNames(ci)).toEqual(["lint", "test", "audit"]);
  });

  it("makes every step required unless it says optional", async () => {
    expect(requiredCiStepNames(await config(CI))).toEqual(["lint", "test"]);
  });

  it("reads the job's own limits", async () => {
    const ci = await config(`
version: 1
timeoutMinutes: 45
instance: standard-2
network:
  allow: [registry.example.com, registry.example.com, cdn.example.org]
steps:
  - { name: build, run: make }
`);
    expect(ci.timeoutSeconds).toBe(2700);
    expect(ci.instance).toBe("standard-2");
    expect(ci.allowHosts).toEqual(["registry.example.com", "cdn.example.org"]);
  });

  it("refuses rather than repairs: a misspelled field fails the file", async () => {
    // `optinal: true` silently ignored would make a step required that its
    // author meant to be advisory — or, the other way round, drop a gate.
    expect(await reason("steps:\n  - { name: lint, run: x, optinal: true }\n")).toMatch(
      /unrecognized field 'optinal'/,
    );
    expect(await reason("step:\n  - { name: lint, run: x }\n")).toMatch(
      /unrecognized field 'step'/,
    );
    expect(await reason("steps: [{ name: a, run: b }]\nnetwork: { deny: [] }\n")).toMatch(
      /unrecognized field 'deny'/,
    );
  });

  it.each([
    ["no steps", "steps: []\n", /non-empty list/],
    ["no steps key", "timeoutMinutes: 5\n", /non-empty list/],
    ["a scalar document", "just a string\n", /must be a mapping/],
    ["an empty document", "", /must be a mapping/],
    ["invalid YAML", "steps: [\n", /./],
    ["a step without a command", "steps:\n  - name: lint\n", /has no 'run' command/],
    ["a blank command", "steps:\n  - { name: lint, run: '  ' }\n", /has no 'run' command/],
    ["a step without a name", "steps:\n  - run: x\n", /name/],
    ["a name that is not a check name", "steps:\n  - { name: 'a b', run: x }\n", /name/],
    ["a duplicate name", "steps:\n  - { name: a, run: x }\n  - { name: a, run: y }\n", /twice/],
    [
      "a fractional timeout",
      "steps:\n  - { name: a, run: x, timeoutMinutes: 1.5 }\n",
      /whole number/,
    ],
    ["a zero timeout", "steps:\n  - { name: a, run: x, timeoutMinutes: 0 }\n", /whole number/],
    [
      "an enormous timeout",
      "steps:\n  - { name: a, run: x, timeoutMinutes: 999 }\n",
      /from 1 to 120/,
    ],
    ["a string timeout", "steps:\n  - { name: a, run: x, timeoutMinutes: '10' }\n", /whole number/],
    [
      "a non-boolean optional",
      "steps:\n  - { name: a, run: x, optional: yes please }\n",
      /true or false/,
    ],
    ["an unknown instance", "instance: gigantic\nsteps:\n  - { name: a, run: x }\n", /instance/],
    ["another version", "version: 2\nsteps:\n  - { name: a, run: x }\n", /version/],
    [
      "a wildcard host",
      "network: { allow: ['*.example.com'] }\nsteps: [{ name: a, run: x }]\n",
      /hostnames/,
    ],
    [
      "an IP address",
      "network: { allow: ['10.0.0.1'] }\nsteps: [{ name: a, run: x }]\n",
      /hostnames/,
    ],
    [
      "a URL for a host",
      "network: { allow: ['https://example.com'] }\nsteps: [{ name: a, run: x }]\n",
      /hostnames/,
    ],
    [
      "an internal host",
      "network: { allow: [localhost] }\nsteps: [{ name: a, run: x }]\n",
      /hostnames/,
    ],
  ])("refuses %s", async (_name, yaml, expected) => {
    expect(await reason(yaml)).toMatch(expected);
  });

  it("refuses more steps, a longer command or more hosts than the limits", async () => {
    const steps = Array.from({ length: 17 }, (_, i) => `  - { name: s${i}, run: x }`).join("\n");
    expect(await reason(`steps:\n${steps}\n`)).toMatch(/at most 16/);
    expect(await reason(`steps:\n  - name: a\n    run: "${"x".repeat(4001)}"\n`)).toMatch(/4000/);
    const hosts = Array.from({ length: 17 }, (_, i) => `h${i}.example.com`).join(", ");
    expect(await reason(`network: { allow: [${hosts}] }\nsteps: [{ name: a, run: x }]\n`)).toMatch(
      /at most 16/,
    );
  });

  it("never throws, whatever it is given", async () => {
    for (const input of ["a: &a [*a]", "\0", "- - - -", "{".repeat(500)]) {
      await expect(parseCiConfig(input)).resolves.toHaveProperty("status");
    }
  });

  describe("the digest", () => {
    it("is the same for the same configuration, however the file is written", async () => {
      const a = await config("steps:\n  - name: lint\n    run: npm run lint\n");
      const b = await config(
        "# a comment\nversion: 1\nsteps: [{ run: 'npm run lint', name: lint, timeoutMinutes: 10 }]\n",
      );
      expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(b.digest).toBe(a.digest);
    });

    it.each([
      ["a command", "steps:\n  - { name: lint, run: 'true' }\n"],
      ["a step's name", "steps:\n  - { name: lint2, run: npm run lint }\n"],
      [
        "a step's time limit",
        "steps:\n  - { name: lint, run: npm run lint, timeoutMinutes: 11 }\n",
      ],
      [
        "whether a step is optional",
        "steps:\n  - { name: lint, run: npm run lint, optional: true }\n",
      ],
      [
        "the job's time limit",
        "timeoutMinutes: 31\nsteps:\n  - { name: lint, run: npm run lint }\n",
      ],
      ["the instance", "instance: lite\nsteps:\n  - { name: lint, run: npm run lint }\n"],
      [
        "the network allowlist",
        "network: { allow: [x.example.com] }\nsteps:\n  - { name: lint, run: npm run lint }\n",
      ],
      [
        "an added step",
        "steps:\n  - { name: lint, run: npm run lint }\n  - { name: test, run: npm test }\n",
      ],
    ])("changes when %s changes", async (_name, yaml) => {
      const base = await config("steps:\n  - { name: lint, run: npm run lint }\n");
      expect((await config(yaml)).digest).not.toBe(base.digest);
    });
  });
});

describe("Stratum's own .stratum/ci.yaml", () => {
  it("is valid, and gates on every suite the PR checks run", async () => {
    const ci = await config(ownCi);
    expect(requiredCiStepNames(ci)).toEqual([
      "install",
      "typecheck",
      "test",
      "integration",
      "cli",
      "agent",
      "ci-executor",
      "lint",
    ]);
    // Lint last, per AGENTS.md.
    expect(ci.steps.at(-1)?.name).toBe("lint");
    // The steps' own limits fit inside the job's.
    expect(Math.max(...ci.steps.map((step) => step.timeoutSeconds))).toBeLessThanOrEqual(
      ci.timeoutSeconds,
    );
  });
});

describe("protection of the file", () => {
  it("is a protected config file, so a change editing it needs a human", () => {
    expect(PROTECTED_CONFIG_FILES).toContain(CI_CONFIG_PATH);
    expect(
      diffTouchesProtectedConfig(
        "diff --git a/.stratum/ci.yaml b/.stratum/ci.yaml\n--- a/.stratum/ci.yaml\n+++ b/.stratum/ci.yaml\n",
      ),
    ).toBe(true);
    expect(diffTouchesProtectedConfig("diff --git a/ci.yaml b/ci.yaml\n")).toBe(false);
  });

  it("is protected when added or deleted, not only when edited", () => {
    const added = "diff --git a/.stratum/ci.yaml b/.stratum/ci.yaml\nnew file mode 100644\n";
    const deleted = "diff --git a/.stratum/ci.yaml b/.stratum/ci.yaml\ndeleted file mode 100644\n";
    expect(diffTouchesProtectedConfig(added)).toBe(true);
    expect(diffTouchesProtectedConfig(deleted)).toBe(true);
  });
});

describe("loadPolicy with a CI file", () => {
  const POLICY = "evaluators:\n  - type: diff\n";
  beforeEach(() => {
    vi.mocked(readFileFromRepo).mockReset();
  });

  async function load(files: Record<string, string>) {
    vi.mocked(readFileFromRepo).mockImplementation(repoWithFiles(files));
    return loadPolicy("https://repo.example.com", "tok", logger, "trunk");
  }

  it("puts the base branch's steps on the policy", async () => {
    const policy = await load({ ".stratum/policy.yaml": POLICY, ".stratum/ci.yaml": CI });
    expect(policy.configError).toBeUndefined();
    expect(policy.ci?.steps.map((step) => step.name)).toEqual(["lint", "test", "audit"]);
    const ciRead = vi
      .mocked(readFileFromRepo)
      .mock.calls.find((call) => call[2] === CI_CONFIG_PATH);
    expect(ciRead?.[4]).toBe("trunk");
  });

  it("works with no policy file at all: CI on the default policy", async () => {
    const policy = await load({ ".stratum/ci.yaml": CI });
    expect(policy.ci?.steps).toHaveLength(3);
    expect(policy.evaluators).toEqual([{ type: "diff" }]);
    expect(policy.configError).toBeUndefined();
  });

  it("leaves a project without the file exactly as it was", async () => {
    const policy = await load({ ".stratum/policy.yaml": POLICY });
    expect(policy.ci).toBeUndefined();
    expect(policy.configError).toBeUndefined();
  });

  it("fails the merge gate closed on a file that is present but invalid", async () => {
    const policy = await load({
      ".stratum/policy.yaml": POLICY,
      ".stratum/ci.yaml": "steps:\n  - { name: lint, run: x, optinal: true }\n",
    });
    expect(policy.ci).toBeUndefined();
    expect(policy.configError).toMatch(/\.stratum\/ci\.yaml is present but invalid/);
    expect(policy.configError).toContain("optinal");
  });

  it("fails closed when the file cannot be read but the repository can", async () => {
    vi.mocked(readFileFromRepo).mockImplementation(async (remote, token, path, log, branch) => {
      if (path === CI_CONFIG_PATH) {
        return { success: false, error: new AppError("clone timed out", "GIT_ERROR", 502) };
      }
      return repoWithFiles({ ".stratum/policy.yaml": POLICY })(remote, token, path, log, branch);
    });
    const policy = await loadPolicy("https://repo.example.com", "tok", logger);
    // "Could not read it" must not quietly mean "no required checks".
    expect(policy.configError).toMatch(/ci\.yaml could not be read/);
  });

  it("treats a repository that cannot be read at all as it always has: no config", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValue({
      success: false,
      error: new AppError("Failed to clone repository", "EXTERNAL_SERVICE_ERROR", 502),
    });
    const policy = await loadPolicy("https://repo.example.com", "tok", logger);
    // An empty repository fails its clone too, and must stay usable.
    expect(policy.configError).toBeUndefined();
    expect(policy.ci).toBeUndefined();
    // But "could not look" is recorded as such, not as "there is no CI file":
    // the merge gate refuses a revision CI ran on while this is set.
    expect(policy.ciUnverified).toBe(true);
  });

  it("does not mark a repository that answered as unverified", async () => {
    expect((await load({ ".stratum/policy.yaml": POLICY })).ciUnverified).toBeUndefined();
    expect((await load({})).ciUnverified).toBeUndefined();
    expect((await load({ ".stratum/ci.yaml": CI })).ciUnverified).toBeUndefined();
  });

  it("refuses a step named like a check the policy already declares", async () => {
    const policy = await load({
      ".stratum/policy.yaml":
        "evaluators:\n  - type: checks\n    url: https://ci.example.com/x\n    secretRef: WEBHOOK_CI\n    checks: [lint]\n",
      ".stratum/ci.yaml": CI,
    });
    expect(policy.configError).toMatch(/lint/);
    expect(policy.ci).toBeUndefined();
  });

  it("lets merge.requiredChecks name a CI step, including an optional one", async () => {
    const policy = await load({
      ".stratum/policy.yaml": `${POLICY}merge:\n  requiredChecks: [audit]\n`,
      ".stratum/ci.yaml": CI,
    });
    expect(policy.configError).toBeUndefined();
    expect(requiredCheckNames(policy).sort()).toEqual(["audit", "lint", "test"]);
  });

  it("still refuses a required check that nothing declares", async () => {
    const policy = await load({
      ".stratum/policy.yaml": `${POLICY}merge:\n  requiredChecks: [deploy-preview]\n`,
      ".stratum/ci.yaml": CI,
    });
    expect(policy.configError).toMatch(/deploy-preview/);
  });

  it("shows the policy file's own error first when both files are broken", async () => {
    const policy = await load({
      ".stratum/policy.yaml": "evaluators: 5\n",
      ".stratum/ci.yaml": "steps: []\n",
    });
    expect(policy.configError).toMatch(/policy\.yaml/);
  });

  it("ignores a `ci:` key written into the policy file itself", async () => {
    const parsed = parsePolicyContent(
      `${POLICY}ciUnverified: true\nci:\n  steps: [{ name: forged, run: 'true', required: false }]\n  digest: x\n`,
      "yaml",
      logger,
    );
    if (parsed.status !== "ok") throw new Error(parsed.reason);
    // Steps come from `.stratum/ci.yaml` and nowhere else.
    expect(parsed.policy.ci).toBeUndefined();
    expect("ciUnverified" in parsed.policy).toBe(false);
  });
});

describe("what the merge gate requires", () => {
  it("adds every non-optional step to merge.requiredChecks, without duplicates", async () => {
    const ci = await config(CI);
    expect(requiredCheckNames({ ci })).toEqual(["lint", "test"]);
    expect(requiredCheckNames({ ci, merge: { requiredChecks: ["external", "lint"] } })).toEqual([
      "external",
      "lint",
      "test",
    ]);
    expect(requiredCheckNames({ merge: { requiredChecks: ["external"] } })).toEqual(["external"]);
    expect(requiredCheckNames({})).toEqual([]);
  });

  it("calls a step stale unless its latest run was dispatched under the current file", async () => {
    const ci = await config(CI);
    const current = (name: string) => ({ name, ciConfigDigest: ci.digest });

    expect(staleCiSteps([current("lint"), current("test"), current("audit")], ci)).toEqual([]);
    // Never dispatched at all.
    expect(staleCiSteps([current("lint")], ci)).toEqual(["test", "audit"]);
    // Dispatched under an older file — same name, possibly a different command.
    expect(
      staleCiSteps(
        [current("lint"), { name: "test", ciConfigDigest: "old" }, current("audit")],
        ci,
      ),
    ).toEqual(["test"]);
    // A project runner's check of the same name is not a run of the step.
    expect(staleCiSteps([current("lint"), { name: "test" }, current("audit")], ci)).toEqual([
      "test",
    ]);
    expect(staleCiSteps([], undefined)).toEqual([]);
  });
});
