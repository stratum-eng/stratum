import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_TARGETS, sanitizeDeploys } from "../src/deploy/config";
import { loadPolicy, parsePolicyContent } from "../src/evaluation/policy-loader";
import type { DeployConfig, EvalPolicy } from "../src/evaluation/types";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

vi.mock("../src/storage/git-ops", () => ({
  readFileFromRepo: vi.fn(),
}));

import { readFileFromRepo } from "../src/storage/git-ops";
const mockReadFileFromRepo = vi.mocked(readFileFromRepo);

/** The one reason string for a single rejected entry. */
function onlyReason(result: ReturnType<typeof sanitizeDeploys>): string {
  expect(result.rejected).toHaveLength(1);
  return result.rejected[0]?.reason ?? "";
}

describe("sanitizeDeploys — accepted entries", () => {
  it("accepts a fully specified entry", () => {
    const { accepted, rejected } = sanitizeDeploys([
      {
        name: "production",
        target: "cloudflare-pages",
        secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        dir: "dist/site",
        requiresApproval: true,
      },
    ]);

    expect(rejected).toEqual([]);
    expect(accepted).toEqual([
      {
        name: "production",
        target: "cloudflare-pages",
        secrets: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        dir: "dist/site",
        requiresApproval: true,
      },
    ]);
  });

  it("accepts a minimal entry and defaults requiresApproval to false", () => {
    // Set explicitly rather than left undefined: the approval gate decides
    // whether a deploy can reach production unattended, so downstream code must
    // never have to guess what an absent field meant.
    const { accepted } = sanitizeDeploys([{ name: "prod", target: "vercel" }]);

    expect(accepted).toEqual([{ name: "prod", target: "vercel", requiresApproval: false }]);
  });

  it("accepts every declared target", () => {
    const { accepted, rejected } = sanitizeDeploys(
      DEPLOY_TARGETS.map((target, i) => ({ name: `d${i}`, target })),
    );

    expect(rejected).toEqual([]);
    expect(accepted.map((d) => d.target)).toEqual([...DEPLOY_TARGETS]);
  });

  it("treats an absent or empty deploys list as no deploys and no rejections", () => {
    expect(sanitizeDeploys(undefined)).toEqual({ accepted: [], rejected: [] });
    expect(sanitizeDeploys(null)).toEqual({ accepted: [], rejected: [] });
    expect(sanitizeDeploys([])).toEqual({ accepted: [], rejected: [] });
  });

  it("returns fresh objects that share no identity with the input", () => {
    // The whole point of rebuilding rather than passing the parsed value
    // through: nothing downstream may reach back into user-supplied input.
    const secrets = ["VERCEL_TOKEN"];
    const entry = { name: "prod", target: "vercel", secrets };
    const input = [entry];

    const { accepted } = sanitizeDeploys(input);

    expect(accepted).not.toBe(input);
    expect(accepted[0]).not.toBe(entry);
    expect(accepted[0]?.secrets).not.toBe(secrets);

    secrets.push("SNEAKED_IN");
    expect(accepted[0]?.secrets).toEqual(["VERCEL_TOKEN"]);
  });
});

describe("sanitizeDeploys — rejected entries", () => {
  it("rejects a non-list deploys value", () => {
    const result = sanitizeDeploys({ name: "prod", target: "vercel" });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { name: null, reason: expect.stringMatching(/must be a list/) },
    ]);
  });

  it("rejects entries that are not mappings", () => {
    const { accepted, rejected } = sanitizeDeploys([null, "vercel", 42, []]);

    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(4);
    for (const entry of rejected) {
      expect(entry.name).toBeNull();
      expect(entry.reason).toMatch(/must be a mapping/);
    }
  });

  it("rejects a missing or non-string name", () => {
    expect(onlyReason(sanitizeDeploys([{ target: "vercel" }]))).toMatch(/"name" is required/);
    expect(onlyReason(sanitizeDeploys([{ name: 7, target: "vercel" }]))).toMatch(
      /"name" is required/,
    );
  });

  it("rejects names that do not match the slug pattern", () => {
    const bad = ["Production", "1prod", "-prod", "pro_duction", "prod!", "p".repeat(33), ""];

    for (const name of bad) {
      const result = sanitizeDeploys([{ name, target: "vercel" }]);
      expect(result.accepted, `expected ${JSON.stringify(name)} to be rejected`).toEqual([]);
      expect(onlyReason(result)).toMatch(/"name"/);
    }

    // The boundary on the other side of the length rule still passes.
    expect(
      sanitizeDeploys([{ name: `p${"o".repeat(31)}`, target: "vercel" }]).accepted,
    ).toHaveLength(1);
  });

  it("rejects a duplicate name and keeps the first", () => {
    const { accepted, rejected } = sanitizeDeploys([
      { name: "prod", target: "vercel" },
      { name: "prod", target: "cloudflare-pages" },
    ]);

    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.target).toBe("vercel");
    expect(rejected).toEqual([{ name: "prod", reason: expect.stringMatching(/duplicate/i) }]);
  });

  it("rejects an unknown or missing target", () => {
    const unknown = sanitizeDeploys([{ name: "prod", target: "netlify" }]);
    expect(unknown.accepted).toEqual([]);
    expect(unknown.rejected[0]).toEqual({
      name: "prod",
      reason: expect.stringMatching(/unknown target "netlify"/),
    });

    expect(onlyReason(sanitizeDeploys([{ name: "prod" }]))).toMatch(/"target" is required/);
  });

  it("rejects malformed secret names", () => {
    expect(
      onlyReason(sanitizeDeploys([{ name: "p", target: "vercel", secrets: "TOKEN" }])),
    ).toMatch(/"secrets" must be a list/);

    for (const secret of ["vercel_token", "1TOKEN", "TOKEN-1", `A${"B".repeat(64)}`]) {
      const result = sanitizeDeploys([{ name: "p", target: "vercel", secrets: [secret] }]);
      expect(result.accepted, `expected ${secret} to be rejected`).toEqual([]);
      expect(onlyReason(result)).toMatch(/invalid secret name/);
    }

    expect(onlyReason(sanitizeDeploys([{ name: "p", target: "vercel", secrets: [1] }]))).toMatch(
      /invalid secret name/,
    );

    const tooMany = sanitizeDeploys([
      { name: "p", target: "vercel", secrets: Array.from({ length: 17 }, (_, i) => `S${i}`) },
    ]);
    expect(onlyReason(tooMany)).toMatch(/at most/);
  });

  it("rejects a dir that escapes the repo root", () => {
    const traversals = [
      "..",
      "../secrets",
      "dist/../../etc",
      "/etc/passwd",
      "\\windows",
      "dist\\..\\..\\etc",
      "dist/\0",
      "",
      "   ",
      "d".repeat(256),
    ];

    for (const dir of traversals) {
      const result = sanitizeDeploys([{ name: "p", target: "cloudflare-pages", dir }]);
      expect(result.accepted, `expected ${JSON.stringify(dir)} to be rejected`).toEqual([]);
      expect(onlyReason(result)).toMatch(/"dir"/);
    }

    expect(
      onlyReason(sanitizeDeploys([{ name: "p", target: "cloudflare-pages", dir: 1 }])),
    ).toMatch(/"dir" must be a string/);
  });

  it("keeps a relative dir, trimmed", () => {
    const { accepted } = sanitizeDeploys([
      { name: "p", target: "cloudflare-pages", dir: "  dist/site  " },
    ]);

    expect(accepted[0]?.dir).toBe("dist/site");
  });

  it("rejects a non-boolean requiresApproval instead of coercing it", () => {
    // "false" is a truthy string; coercion here would arm or disarm the gate
    // that keeps an agent from shipping to production.
    for (const value of ["true", "false", 1, 0, null]) {
      const result = sanitizeDeploys([{ name: "p", target: "vercel", requiresApproval: value }]);
      expect(result.accepted, `expected ${JSON.stringify(value)} to be rejected`).toEqual([]);
      expect(onlyReason(result)).toMatch(/"requiresApproval" must be a boolean/);
    }
  });

  it("rejects an entry carrying an unrecognized field", () => {
    // `requireApproval` (no "s") is the typo that matters: a whitelist rebuild
    // that dropped it silently would ship an approval-gated deploy unattended.
    const result = sanitizeDeploys([
      { name: "prod", target: "vercel", requireApproval: true, token: "hunter2" },
    ]);

    expect(result.accepted).toEqual([]);
    expect(onlyReason(result)).toMatch(/unrecognized fields "requireApproval", "token"/);
  });

  it("reports every problem with an entry, not just the first", () => {
    const reason = onlyReason(
      sanitizeDeploys([{ name: "Prod", target: "netlify", secrets: ["nope"] }]),
    );

    expect(reason).toMatch(/"name"/);
    expect(reason).toMatch(/unknown target/);
    expect(reason).toMatch(/invalid secret name/);
  });

  it("locates the offending entry by index and names it when it has a usable name", () => {
    const { rejected } = sanitizeDeploys([
      { name: "ok", target: "vercel" },
      { name: "staging", target: "netlify" },
    ]);

    expect(rejected).toEqual([
      { name: "staging", reason: expect.stringMatching(/^deploys\[1\]: /) },
    ]);
  });

  it("truncates a huge policy-supplied value out of the reason string", () => {
    // The reason is persisted and rendered; a megabyte of YAML must not become
    // a megabyte of deployment row.
    const reason = onlyReason(sanitizeDeploys([{ name: "x".repeat(5000), target: "vercel" }]));

    expect(reason.length).toBeLessThan(500);
  });

  it("keeps the good entries when a sibling is rejected", () => {
    // Unlike `evaluators`, one bad deploy entry does not discard the rest — it
    // is reported on its own so the others still ship.
    const { accepted, rejected } = sanitizeDeploys([
      { name: "prod", target: "vercel" },
      { name: "broken", target: "netlify" },
    ]);

    expect(accepted.map((d) => d.name)).toEqual(["prod"]);
    expect(rejected.map((r) => r.name)).toEqual(["broken"]);
  });
});

describe("sanitizeDeploys — entry-count cap", () => {
  const entry = (index: number) => ({ name: `deploy-${index}`, target: "vercel" });

  it("accepts a file declaring exactly the cap", () => {
    const { accepted, rejected } = sanitizeDeploys(
      Array.from({ length: 16 }, (_, index) => entry(index)),
    );

    expect(accepted).toHaveLength(16);
    expect(rejected).toEqual([]);
  });

  it("runs only the first 16 entries and rejects the excess", () => {
    const { accepted, rejected } = sanitizeDeploys(
      Array.from({ length: 20 }, (_, index) => entry(index)),
    );

    expect(accepted.map((d) => d.name)).toEqual(
      Array.from({ length: 16 }, (_, index) => `deploy-${index}`),
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.name).toBeNull();
    expect(rejected[0]?.reason).toContain("at most 16 entries");
    expect(rejected[0]?.reason).toContain("20 were declared");
    expect(rejected[0]?.reason).toContain("entries 17-20");
  });

  it("reports the excess once, not once per entry — a huge file cannot flood the history", () => {
    // Every rejection becomes a persisted `deployments` row, so the cap must not
    // itself be the thing that writes thousands of them.
    const { accepted, rejected } = sanitizeDeploys(
      Array.from({ length: 500 }, (_, index) => entry(index)),
    );

    expect(accepted).toHaveLength(16);
    expect(rejected).toHaveLength(1);
  });

  it("still validates the entries it does keep", () => {
    const raw: unknown[] = Array.from({ length: 20 }, (_, index) => entry(index));
    raw[0] = { name: "bad", target: "netlify" };

    const { accepted, rejected } = sanitizeDeploys(raw);

    expect(accepted).toHaveLength(15);
    expect(rejected.map((r) => r.name)).toEqual([null, "bad"]);
  });
});

describe("parsePolicyContent", () => {
  it("parses YAML and JSON to the same policy without any fetch", () => {
    const yaml = parsePolicyContent(
      ["evaluators:", "  - type: diff", "deploys:", "  - name: prod", "    target: vercel"].join(
        "\n",
      ),
      "yaml",
      mockLogger,
    );
    const json = parsePolicyContent(
      JSON.stringify({
        evaluators: [{ type: "diff" }],
        deploys: [{ name: "prod", target: "vercel" }],
      }),
      "json",
      mockLogger,
    );

    expect(yaml.status).toBe("ok");
    expect(json.status).toBe("ok");
    if (yaml.status !== "ok" || json.status !== "ok") return;
    expect(yaml.policy.deploys).toEqual([
      { name: "prod", target: "vercel", requiresApproval: false },
    ]);
    expect(yaml.policy).toEqual(json.policy);
  });

  it("reports unparseable content as malformed rather than throwing", () => {
    const result = parsePolicyContent("not { valid json", "json", mockLogger);

    expect(result.status).toBe("malformed");
  });

  it("reports a missing evaluators list as malformed", () => {
    const result = parsePolicyContent(JSON.stringify({ minScore: 0.5 }), "json", mockLogger);

    expect(result).toEqual({ status: "malformed", reason: expect.stringMatching(/evaluators/) });
  });

  it("works without a logger argument", () => {
    // The deploy runner parses policy bytes from a pinned tree; the signature
    // must not force it to invent a logger.
    const result = parsePolicyContent(JSON.stringify({ evaluators: [] }), "json");

    expect(result.status).toBe("ok");
  });
});

describe("loadPolicy — deploys wiring", () => {
  beforeEach(() => {
    mockReadFileFromRepo.mockReset();
  });

  /** Loads `config` as the policy file. */
  async function loadConfig(config: unknown): Promise<EvalPolicy> {
    mockReadFileFromRepo.mockResolvedValue({ success: true, data: JSON.stringify(config) });
    return loadPolicy("https://repo.example.com", "tok", mockLogger);
  }

  it("carries sanitized deploys onto the policy", async () => {
    const policy = await loadConfig({
      evaluators: [{ type: "diff" }],
      deploys: [{ name: "production", target: "vercel", secrets: ["VERCEL_TOKEN"] }],
    });

    expect(policy.configError).toBeUndefined();
    expect(policy.deploys).toEqual([
      {
        name: "production",
        target: "vercel",
        secrets: ["VERCEL_TOKEN"],
        requiresApproval: false,
      },
    ]);
    expect(policy.deployRejections).toBeUndefined();
  });

  it("leaves deploys absent when the policy declares none", async () => {
    const policy = await loadConfig({ evaluators: [{ type: "diff" }] });

    expect(policy.deploys).toBeUndefined();
    expect(policy.deployRejections).toBeUndefined();
  });

  it("does not let a raw deploys value bypass sanitization through the spread", async () => {
    // Regression: the policy is built as `{...DEFAULT_POLICY, ...parsed}`, so
    // once `deploys` exists on EvalPolicy the *parsed* value flows straight
    // through — unsanitized and by reference — unless it is rebuilt. Each of
    // these would be visible on the policy under that bug.
    const notAList = await loadConfig({
      evaluators: [{ type: "diff" }],
      deploys: { name: "prod" },
    });
    expect(notAList.deploys).toBeUndefined();
    expect(notAList.deployRejections?.[0]?.reason).toMatch(/must be a list/);

    const withExtras = await loadConfig({
      evaluators: [{ type: "diff" }],
      deploys: [{ name: "prod", target: "vercel", token: "hunter2" }],
    });
    expect(withExtras.deploys).toBeUndefined();
    expect(JSON.stringify(withExtras)).not.toContain("hunter2");

    // `deployRejections` is loader-owned output, not policy-file input.
    const forged = await loadConfig({
      evaluators: [{ type: "diff" }],
      deployRejections: [{ name: "fake", reason: "forged" }],
    });
    expect(forged.deployRejections).toBeUndefined();
  });

  it("returns entries that share no identity with the parsed policy file", async () => {
    // A second load must not be able to observe a mutation made to the first.
    const policy = await loadConfig({
      evaluators: [{ type: "diff" }],
      deploys: [{ name: "prod", target: "vercel", secrets: ["VERCEL_TOKEN"] }],
    });
    (policy.deploys as DeployConfig[])[0]?.secrets?.push("MUTATED");

    const second = await loadConfig({
      evaluators: [{ type: "diff" }],
      deploys: [{ name: "prod", target: "vercel", secrets: ["VERCEL_TOKEN"] }],
    });

    expect(second.deploys?.[0]?.secrets).toEqual(["VERCEL_TOKEN"]);
  });

  it("reports a rejected entry without blocking merges", async () => {
    // Deliberately unlike `evaluators`, where one unusable entry fails the file
    // closed. A deploy runs after the merge, so a bad entry is reported as a
    // failed deployment instead of changing the merge gate's behavior.
    const policy = await loadConfig({
      evaluators: [{ type: "diff" }],
      deploys: [
        { name: "prod", target: "vercel" },
        { name: "staging", target: "netlify" },
      ],
    });

    expect(policy.configError).toBeUndefined();
    expect(policy.deploys?.map((d) => d.name)).toEqual(["prod"]);
    expect(policy.deployRejections).toEqual([
      { name: "staging", reason: expect.stringMatching(/unknown target/) },
    ]);
  });

  it("surfaces a malformed policy file as a deploy rejection, not silence", async () => {
    // malformedPolicy returns DEFAULT_POLICY, which declares no deploys — so a
    // YAML typo would otherwise disable every deploy with nothing to show for it.
    mockReadFileFromRepo.mockResolvedValue({ success: true, data: "evaluators: [ unclosed" });

    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);

    expect(policy.configError).toBeDefined();
    expect(policy.deploys).toBeUndefined();
    expect(policy.deployRejections).toHaveLength(1);
    expect(policy.deployRejections?.[0]?.name).toBeNull();
    expect(policy.deployRejections?.[0]?.reason).toMatch(/\.stratum\/policy\.yaml/);
  });

  it("does not invent a deploy rejection when the policy file is simply absent", async () => {
    mockReadFileFromRepo.mockResolvedValue({
      success: false,
      error: new AppError("missing", "NOT_FOUND", 404),
    });

    const policy = await loadPolicy("https://repo.example.com", "tok", mockLogger);

    expect(policy.deployRejections).toBeUndefined();
    expect(policy.deploys).toBeUndefined();
  });
});
