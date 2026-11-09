/**
 * The `deploy:` section of `.stratum/ci.yaml` (#416).
 *
 * The parser's job is to refuse. The field most likely to be mistyped in this
 * section is the one that makes a production deploy wait for a person, so a
 * key it does not know fails the section rather than being dropped — and a
 * failed section deploys nothing.
 */
import { describe, expect, it } from "vitest";
// Raw import rather than node:fs, so this type-checks under the Workers
// tsconfig — the same trick tests/ci-config.test.ts uses for this file.
import ownCi from "../.stratum/ci.yaml?raw";
// @ts-expect-error - plain .mjs helper run by the deploy pipeline itself; no
// types, and a .d.ts for one exported function would be more indirection than
// it saves.
import { deployedVersion } from "../scripts/record-deploy-version.mjs";
import {
  MAX_DEPLOY_ENVIRONMENTS,
  nextEnvironment,
  parseDeployPipeline,
  parseDeploySection,
} from "../src/deploy/pipeline";
import { parseCiConfig } from "../src/evaluation/ci-config";

const VALID = `version: 1
steps:
  - name: test
    run: npm test

deploy:
  timeoutMinutes: 20
  instance: standard-2
  network:
    allow: [app-staging.example.workers.dev]
  environments:
    - name: staging
      steps:
        - name: migrate
          run: npx wrangler d1 migrations apply app --remote --env staging
          timeoutMinutes: 5
        - name: deploy
          run: npx wrangler deploy --env staging
    - name: production
      requiresApproval: true
      steps:
        - name: deploy
          run: npx wrangler deploy --env production
      rollback:
        - name: rollback
          run: npx wrangler rollback "$STRATUM_ROLLBACK_VERSION" --env production -m rollback
`;

function pipelineOf(content: string) {
  const parsed = parseDeployPipeline(content);
  if (parsed.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(parsed)}`);
  return parsed.pipeline;
}

function reasonOf(deploy: unknown): string {
  const parsed = parseDeploySection(deploy);
  if (parsed.status !== "malformed") throw new Error(`expected malformed, got ${parsed.status}`);
  return parsed.reason;
}

const STEP = { name: "deploy", run: "npx wrangler deploy" };
const ENVIRONMENT = { name: "staging", steps: [STEP] };

describe("a valid deploy section", () => {
  it("becomes ordered environments with their steps, approval gates and rollback steps", () => {
    const pipeline = pipelineOf(VALID);

    expect(pipeline.environments.map((environment) => environment.name)).toEqual([
      "staging",
      "production",
    ]);
    expect(pipeline.environments[0]).toEqual({
      name: "staging",
      requiresApproval: false,
      steps: [
        {
          name: "migrate",
          run: "npx wrangler d1 migrations apply app --remote --env staging",
          timeoutSeconds: 300,
        },
        { name: "deploy", run: "npx wrangler deploy --env staging", timeoutSeconds: 600 },
      ],
    });
    expect(pipeline.environments[1]?.requiresApproval).toBe(true);
    expect(pipeline.environments[1]?.rollback?.map((step) => step.name)).toEqual(["rollback"]);
    expect(pipeline.timeoutSeconds).toBe(1200);
    expect(pipeline.instance).toBe("standard-2");
    expect(pipeline.allowHosts).toEqual(["app-staging.example.workers.dev"]);
  });

  it("defaults: no approval, a thirty minute job, the executor's own size, no extra hosts", () => {
    const parsed = parseDeploySection({ environments: [ENVIRONMENT] });
    if (parsed.status !== "ok") throw new Error("expected ok");
    expect(parsed.pipeline).toEqual({
      environments: [
        { name: "staging", requiresApproval: false, steps: [{ ...STEP, timeoutSeconds: 600 }] },
      ],
      timeoutSeconds: 1800,
      allowHosts: [],
    });
  });

  it("knows which environment follows which, and that the last has none", () => {
    const pipeline = pipelineOf(VALID);
    expect(nextEnvironment(pipeline, "staging")?.name).toBe("production");
    expect(nextEnvironment(pipeline, "production")).toBeUndefined();
    expect(nextEnvironment(pipeline, "nowhere")).toBeUndefined();
  });

  it("is absent, not malformed, when the file has no deploy section", () => {
    expect(parseDeployPipeline("steps:\n  - name: test\n    run: npm test\n")).toEqual({
      status: "absent",
    });
    expect(parseDeployPipeline("")).toEqual({ status: "absent" });
    expect(parseDeploySection(null)).toEqual({ status: "absent" });
  });

  it("is read without regard to the CI half of the file", () => {
    // `steps` is broken here; a deploy of a merged commit is not refused over it.
    const pipeline = pipelineOf(`steps: nonsense\n${VALID.slice(VALID.indexOf("deploy:"))}`);
    expect(pipeline.environments).toHaveLength(2);
  });
});

describe("what the deploy section refuses", () => {
  it("a mistyped approval flag, by name, instead of deploying without the gate", () => {
    const reason = reasonOf({
      environments: [{ ...ENVIRONMENT, name: "production", requireApproval: true }],
    });
    expect(reason).toContain("unrecognized field 'requireApproval'");
  });

  it("an approval flag that is not a boolean: a quoted false is never coerced", () => {
    for (const value of ["false", "true", 1, 0, "yes"]) {
      expect(reasonOf({ environments: [{ ...ENVIRONMENT, requiresApproval: value }] })).toContain(
        "requiresApproval must be true or false",
      );
    }
  });

  it("unknown fields at every level", () => {
    expect(reasonOf({ environments: [ENVIRONMENT], secrets: ["X"] })).toContain(
      "unrecognized field 'secrets'",
    );
    expect(
      reasonOf({ environments: [{ ...ENVIRONMENT, steps: [{ ...STEP, optional: true }] }] }),
    ).toContain("unrecognized field 'optional'");
    expect(reasonOf({ environments: [ENVIRONMENT], network: { deny: [] } })).toContain(
      "unrecognized field 'deny'",
    );
  });

  it("no environments, too many, duplicates and bad names", () => {
    expect(reasonOf({})).toContain("non-empty list");
    expect(reasonOf({ environments: [] })).toContain("non-empty list");
    expect(reasonOf([])).toContain("must be a mapping");
    const many = Array.from({ length: MAX_DEPLOY_ENVIRONMENTS + 1 }, (_, index) => ({
      ...ENVIRONMENT,
      name: `env-${index}`,
    }));
    expect(reasonOf({ environments: many })).toContain(`at most ${MAX_DEPLOY_ENVIRONMENTS}`);
    expect(reasonOf({ environments: [ENVIRONMENT, ENVIRONMENT] })).toContain("declared twice");
    for (const name of ["Production", "prod env", "(unresolved)", "-x", "", 7]) {
      expect(reasonOf({ environments: [{ ...ENVIRONMENT, name }] })).toContain(".name must be");
    }
  });

  it("an environment with no steps, an empty rollback, or a step without a command", () => {
    expect(reasonOf({ environments: [{ name: "staging" }] })).toContain("non-empty list of steps");
    expect(reasonOf({ environments: [{ name: "staging", steps: [] }] })).toContain(
      "non-empty list of steps",
    );
    expect(reasonOf({ environments: [{ ...ENVIRONMENT, rollback: [] }] })).toContain(
      "rollback must be a non-empty list",
    );
    expect(reasonOf({ environments: [{ name: "staging", steps: [{ name: "x" }] }] })).toContain(
      "has no 'run' command",
    );
    expect(reasonOf({ environments: [{ name: "staging", steps: [STEP, STEP] }] })).toContain(
      "twice",
    );
    expect(
      reasonOf({ environments: [{ name: "staging", steps: [{ name: "../x", run: "true" }] }] }),
    ).toContain(".name");
  });

  it("out-of-range limits, an unknown instance, and anything but an exact hostname", () => {
    expect(reasonOf({ environments: [ENVIRONMENT], timeoutMinutes: 0 })).toContain(
      "deploy.timeoutMinutes",
    );
    expect(reasonOf({ environments: [ENVIRONMENT], timeoutMinutes: 100000 })).toContain(
      "deploy.timeoutMinutes",
    );
    expect(
      reasonOf({ environments: [{ name: "staging", steps: [{ ...STEP, timeoutMinutes: 1.5 }] }] }),
    ).toContain("timeoutMinutes");
    expect(reasonOf({ environments: [ENVIRONMENT], instance: "huge" })).toContain(
      "'deploy.instance'",
    );
    for (const host of ["*.example.com", "https://example.com", "10.0.0.1", "localhost", 5]) {
      expect(reasonOf({ environments: [ENVIRONMENT], network: { allow: [host] } })).toContain(
        "exact lowercase hostnames",
      );
    }
  });

  it("YAML that does not parse, without throwing", () => {
    const parsed = parseDeployPipeline("deploy: [unclosed");
    expect(parsed.status).toBe("malformed");
    expect(parseDeployPipeline("- a\n- b\n")).toEqual({
      status: "malformed",
      reason: "the file must be a mapping",
    });
  });
});

describe("the deploy section and the CI half of the file", () => {
  it("does not make the CI configuration malformed, and is not part of its digest", async () => {
    const withDeploy = await parseCiConfig(VALID);
    const withoutDeploy = await parseCiConfig(VALID.slice(0, VALID.indexOf("deploy:")));
    if (withDeploy.status !== "ok" || withoutDeploy.status !== "ok") {
      throw new Error("expected both to parse");
    }
    // Editing how a merged commit is deployed must not invalidate the checks a
    // change already passed.
    expect(withDeploy.config.digest).toBe(withoutDeploy.config.digest);
    expect(withDeploy.config.steps.map((step) => step.name)).toEqual(["test"]);
  });

  it("a broken deploy section does not block the merge gate", async () => {
    const parsed = await parseCiConfig(
      "steps:\n  - name: test\n    run: npm test\ndeploy:\n  environments: nonsense\n",
    );
    expect(parsed.status).toBe("ok");
  });

  it("a file with a deploy section and no steps is a project with no CI steps", async () => {
    const parsed = await parseCiConfig(VALID.slice(VALID.indexOf("deploy:")));
    if (parsed.status !== "ok") throw new Error(`expected ok: ${JSON.stringify(parsed)}`);
    expect(parsed.config.steps).toEqual([]);
  });

  it("an explicitly empty step list is still refused, with or without a deploy section", async () => {
    for (const content of [
      "steps: []\n",
      `steps: []\n${VALID.slice(VALID.indexOf("deploy:"))}`,
      "version: 1\n",
    ]) {
      expect((await parseCiConfig(content)).status).toBe("malformed");
    }
  });
});

describe("this repository's own pipeline", () => {
  const content: string = ownCi;

  it("deploys staging on merge and production after approval", () => {
    const pipeline = pipelineOf(content);
    expect(pipeline.environments.map((environment) => environment.name)).toEqual([
      "staging",
      "production",
    ]);
    expect(pipeline.environments[0]?.requiresApproval).toBe(false);
    expect(pipeline.environments[1]?.requiresApproval).toBe(true);
  });

  it("applies migrations before it deploys, and smoke tests after, in both environments", () => {
    for (const environment of pipelineOf(content).environments) {
      const names = environment.steps.map((step) => step.name);
      expect(names.indexOf("migrate")).toBeGreaterThanOrEqual(0);
      expect(names.indexOf("migrate")).toBeLessThan(names.indexOf("deploy"));
      expect(names.indexOf("deploy")).toBeLessThan(names.indexOf("smoke"));
      expect(environment.rollback?.some((step) => step.run.includes("wrangler rollback"))).toBe(
        true,
      );
    }
  });

  it("holds no credential: tokens are the executor's, attached outside the job", () => {
    expect(content).not.toMatch(/CLOUDFLARE_API_TOKEN\s*[:=]\s*\S/);
    expect(content).not.toMatch(/secrets\./);
  });

  it("still parses as CI configuration", async () => {
    expect((await parseCiConfig(content)).status).toBe("ok");
  });
});

describe("recording the deployed version from Wrangler's output file", () => {
  // The record shape `wrangler deploy` writes to WRANGLER_OUTPUT_FILE_PATH.
  const deploy = (versionId: string) =>
    JSON.stringify({
      type: "deploy",
      version: 1,
      worker_name: "stratum-staging",
      version_id: versionId,
      targets: ["https://stratum-staging.example.workers.dev"],
    });

  it("takes the version id of the deploy record", () => {
    const ndjson = `${JSON.stringify({ type: "wrangler-session", version: 1 })}\n${deploy("v-1")}\n`;
    expect(deployedVersion(ndjson)).toBe("v-1");
  });

  it("takes the last one when a file holds several, and ignores lines that are not records", () => {
    expect(deployedVersion(`${deploy("v-1")}\nnot json\n\n${deploy("v-2")}\n{"type":"dep`)).toBe(
      "v-2",
    );
  });

  it("finds nothing in a file with no deploy record", () => {
    expect(deployedVersion("")).toBeNull();
    expect(deployedVersion(JSON.stringify({ type: "deploy" }))).toBeNull();
    expect(deployedVersion(JSON.stringify({ type: "version-upload", version_id: "v" }))).toBeNull();
  });
});
