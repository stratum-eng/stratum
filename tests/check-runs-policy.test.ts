/**
 * Check runs (#414): the policy-file surface and the pure half of the merge
 * gate. `tests/check-runs.test.ts` covers the flow through the whole Worker;
 * this covers what a policy file may and may not say, and every status the
 * gate has to fail closed on.
 */
import { describe, expect, it, vi } from "vitest";
import { parsePolicyContent } from "../src/evaluation/policy-loader";
import {
  checkMergeProtection,
  checkResolutionMergeProtection,
  requiredCheckReasons,
} from "../src/merge/protection";
import { buildEvaluators } from "../src/services/change-flow";
import {
  applyCheckReport,
  createCheckRuns,
  expireOverdueChecks,
  latestChecksForRevision,
} from "../src/storage/checks";
import type { Change, Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

function parse(yaml: string) {
  return parsePolicyContent(yaml, "yaml", logger);
}

const VALID = `
evaluators:
  - type: checks
    url: https://ci.example.com/hook
    secretRef: WEBHOOK_CI
    checks: [lint, ci/test]
merge:
  requiredChecks: [lint]
`;

describe("the checks evaluator in a policy file", () => {
  it("parses a valid entry into a whitelisted config", () => {
    const parsed = parse(
      VALID.replace("checks: [lint, ci/test]", "checks: [lint, ci/test]\n    madeUp: true"),
    );
    if (parsed.status !== "ok") throw new Error(parsed.reason);
    expect(parsed.policy.evaluators).toEqual([
      {
        type: "checks",
        url: "https://ci.example.com/hook",
        secretRef: "WEBHOOK_CI",
        checks: ["lint", "ci/test"],
      },
    ]);
    expect(parsed.policy.merge).toEqual({ requiredChecks: ["lint"] });
  });

  it("clamps the dispatch timeout and the deadline into range", () => {
    const parsed = parse(
      VALID.replace(
        "secretRef: WEBHOOK_CI",
        "secretRef: WEBHOOK_CI\n    timeoutMs: 1\n    deadlineMs: 5",
      ),
    );
    if (parsed.status !== "ok") throw new Error(parsed.reason);
    expect(parsed.policy.evaluators[0]).toMatchObject({ timeoutMs: 1000, deadlineMs: 60_000 });

    const huge = parse(
      VALID.replace("secretRef: WEBHOOK_CI", "secretRef: WEBHOOK_CI\n    deadlineMs: 999999999999"),
    );
    if (huge.status !== "ok") throw new Error(huge.reason);
    expect(huge.policy.evaluators[0]).toMatchObject({ deadlineMs: 6 * 60 * 60_000 });
  });

  it.each([
    ["no url", VALID.replace("    url: https://ci.example.com/hook\n", ""), "has no 'url'"],
    ["no secretRef", VALID.replace("    secretRef: WEBHOOK_CI\n", ""), "requires 'secretRef'"],
    [
      "a secretRef outside the signing namespace",
      VALID.replace("WEBHOOK_CI", "CLOUDFLARE_API_TOKEN"),
      "must be a project secret name starting with WEBHOOK_",
    ],
    [
      "a literal secret",
      VALID.replace("secretRef: WEBHOOK_CI", "secretRef: WEBHOOK_CI\n    secret: hunter2"),
      "does not accept a literal 'secret'",
    ],
    ["no checks", VALID.replace("    checks: [lint, ci/test]\n", ""), "requires 'checks'"],
    ["an empty checks list", VALID.replace("[lint, ci/test]", "[]"), "requires 'checks'"],
    [
      "a check name with a space",
      VALID.replace("ci/test", '"unit tests"'),
      "must be 1-64 characters",
    ],
    ["a non-string check name", VALID.replace("ci/test", "7"), "must be 1-64 characters"],
    ["a name listed twice", VALID.replace("ci/test", "lint"), "is listed twice"],
  ])("fails the whole file closed on %s", (_label, yaml, needle) => {
    const parsed = parse(yaml);
    expect(parsed.status).toBe("malformed");
    if (parsed.status === "malformed") expect(parsed.reason).toContain(needle);
  });

  it("never echoes a literal secret into the rejection", () => {
    const parsed = parse(
      VALID.replace(
        "secretRef: WEBHOOK_CI",
        "secretRef: WEBHOOK_CI\n    secret: hunter2-do-not-print",
      ),
    );
    expect(JSON.stringify(parsed)).not.toContain("hunter2-do-not-print");
  });

  it("refuses a check name declared by two endpoints", () => {
    const parsed = parse(`
evaluators:
  - type: checks
    url: https://ci.example.com/a
    secretRef: WEBHOOK_A
    checks: [lint]
  - type: checks
    url: https://attacker.example.com/b
    secretRef: WEBHOOK_B
    checks: [lint]
`);
    expect(parsed.status).toBe("malformed");
    if (parsed.status === "malformed") {
      expect(parsed.reason).toContain("'lint' is declared by more than one 'checks' evaluator");
    }
  });

  it("allows several endpoints with distinct names", () => {
    const parsed = parse(`
evaluators:
  - type: checks
    url: https://ci.example.com/a
    secretRef: WEBHOOK_A
    checks: [lint]
  - type: checks
    url: https://ci.example.com/b
    secretRef: WEBHOOK_B
    checks: [test]
merge:
  requiredChecks: [lint, test]
`);
    expect(parsed.status).toBe("ok");
  });

  it("refuses more check names than one dispatch may carry", () => {
    const names = Array.from({ length: 33 }, (_, index) => `c${index}`).join(", ");
    const parsed = parse(VALID.replace("[lint, ci/test]", `[lint, ${names}]`));
    expect(parsed.status).toBe("malformed");
  });

  it("builds no evaluator for the entry: a dispatch is not a verdict", async () => {
    const parsed = parse(VALID);
    if (parsed.status !== "ok") throw new Error(parsed.reason);
    const built = await buildEvaluators(
      {} as Env,
      parsed.policy,
      { id: "prj_1", name: "app" } as ProjectEntry,
      logger,
    );
    // Only the always-on secret scan. Were the entry an evaluator that passed
    // on dispatch, `requireAll: false` would accept every change.
    expect(built.map((entry) => entry.type)).toEqual(["secret_scan"]);
  });
});

describe("merge.requiredChecks in a policy file", () => {
  it.each([
    ["a string instead of a list", "requiredChecks: lint"],
    ["a list containing a non-string", "requiredChecks: [lint, 3]"],
    ["an invalid name", 'requiredChecks: ["has space"]'],
  ])("fails the file closed on %s rather than requiring nothing", (_label, line) => {
    const parsed = parse(VALID.replace("requiredChecks: [lint]", line));
    expect(parsed.status).toBe("malformed");
    if (parsed.status === "malformed") expect(parsed.reason).toContain("merge.requiredChecks");
  });

  it("fails the file closed on a required check nothing dispatches", () => {
    const parsed = parse(VALID.replace("requiredChecks: [lint]", "requiredChecks: [lint, deploy]"));
    expect(parsed.status).toBe("malformed");
    if (parsed.status === "malformed") {
      expect(parsed.reason).toContain("names 'deploy', which no 'checks' evaluator declares");
    }
  });

  it("de-duplicates, and treats an empty list as no requirement", () => {
    const duplicated = parse(
      VALID.replace("requiredChecks: [lint]", "requiredChecks: [lint, lint]"),
    );
    if (duplicated.status !== "ok") throw new Error(duplicated.reason);
    expect(duplicated.policy.merge?.requiredChecks).toEqual(["lint"]);

    const empty = parse(VALID.replace("requiredChecks: [lint]", "requiredChecks: []"));
    if (empty.status !== "ok") throw new Error(empty.reason);
    expect(empty.policy.merge?.requiredChecks).toBeUndefined();
  });
});

describe("requiredCheckReasons", () => {
  const now = new Date("2026-11-09T12:00:00.000Z");
  const later = "2026-11-09T13:00:00.000Z";
  const earlier = "2026-11-09T11:00:00.000Z";
  const check = (name: string, status: string, deadlineAt = later) =>
    ({ name, status, deadlineAt }) as Parameters<typeof requiredCheckReasons>[0][number];

  it("allows only a passed check", () => {
    expect(requiredCheckReasons([check("lint", "passed")], ["lint"], now)).toEqual([]);
  });

  it.each([
    ["missing", [], "Required check 'lint' has not been reported for the evaluated revision"],
    ["queued", [check("lint", "queued")], "Required check 'lint' is queued"],
    ["running", [check("lint", "running")], "Required check 'lint' is still running"],
    ["failed", [check("lint", "failed")], "Required check 'lint' failed"],
    ["errored", [check("lint", "errored")], "Required check 'lint' errored"],
    [
      "queued past its deadline",
      [check("lint", "queued", earlier)],
      "Required check 'lint' did not report before its deadline",
    ],
    [
      "running past its deadline",
      [check("lint", "running", earlier)],
      "Required check 'lint' did not report before its deadline",
    ],
    // A status this code has never heard of is not a pass.
    ["an unknown status", [check("lint", "skipped")], "Required check 'lint' errored"],
  ])("blocks a required check that is %s", (_label, latest, reason) => {
    expect(requiredCheckReasons(latest, ["lint"], now)).toEqual([reason]);
  });

  it("ignores checks nobody required, and requires nothing when the list is empty", () => {
    expect(requiredCheckReasons([check("docs", "failed")], ["lint"], now)).toEqual([
      "Required check 'lint' has not been reported for the evaluated revision",
    ]);
    expect(requiredCheckReasons([check("docs", "failed")], [], now)).toEqual([]);
    expect(requiredCheckReasons([check("docs", "failed")], undefined, now)).toEqual([]);
  });
});

describe("the gate against stored checks", () => {
  const change = (overrides: Partial<Change> = {}): Change =>
    ({
      id: "chg_1",
      project: "@owner/app",
      workspace: "ws",
      status: "accepted",
      evaluatedSha: "tip-1",
      createdAt: "2026-11-09T00:00:00.000Z",
      ...overrides,
    }) as Change;
  const policy = { evaluators: [], merge: { requiredChecks: ["lint"] } };
  const seed = (db: D1Database, revision: string, supersede: "all" | "same-names" = "all") =>
    createCheckRuns(db, logger, {
      changeId: "chg_1",
      projectId: "prj_1",
      revision,
      names: ["lint"],
      secretRef: "WEBHOOK_CI",
      deadlineAt: "2999-01-01T00:00:00.000Z",
      supersede,
    });

  it("blocks a change with no evaluated revision: every required check is missing", async () => {
    const { db } = makeSqliteD1();
    const { evaluatedSha: _none, ...unpinned } = change();
    const verdict = await checkMergeProtection(db, logger, unpinned as Change, policy);
    expect(verdict.success && verdict.data).toEqual({
      allowed: false,
      reasons: ["Required check 'lint' has not been reported for the evaluated revision"],
    });
  });

  it("does not let a pass on another revision satisfy the gate", async () => {
    const { db } = makeSqliteD1();
    const created = await seed(db, "tip-0");
    if (!created.success) throw created.error;
    const [run] = created.data;
    await applyCheckReport(db, logger, { id: run?.id ?? "", status: "passed", sequence: 1 });

    const stale = await checkMergeProtection(db, logger, change({ evaluatedSha: "tip-1" }), policy);
    expect(stale.success && stale.data.allowed).toBe(false);
    const current = await checkMergeProtection(
      db,
      logger,
      change({ evaluatedSha: "tip-0" }),
      policy,
    );
    expect(current.success && current.data.allowed).toBe(true);
  });

  it("reads the newest attempt: a passed first run does not outlive its re-run", async () => {
    const { db } = makeSqliteD1();
    const first = await seed(db, "tip-1");
    if (!first.success) throw first.error;
    await applyCheckReport(db, logger, {
      id: first.data[0]?.id ?? "",
      status: "passed",
      sequence: 1,
    });
    const second = await seed(db, "tip-1", "same-names");
    if (!second.success) throw second.error;
    expect(second.data[0]?.attempt).toBe(2);

    const latest = await latestChecksForRevision(db, logger, "chg_1", "tip-1");
    expect(latest.success && latest.data.map((c) => [c.attempt, c.status])).toEqual([
      [2, "queued"],
    ]);
    const verdict = await checkMergeProtection(db, logger, change(), policy);
    expect(verdict.success && verdict.data.reasons).toEqual(["Required check 'lint' is queued"]);
    // The replaced run can no longer be written to at all.
    const late = await applyCheckReport(db, logger, {
      id: first.data[0]?.id ?? "",
      status: "failed",
      sequence: 2,
    });
    expect(late.success && late.data.applied).toBe(false);
  });

  it("the deadline sweep expires only pending runs past their deadline", async () => {
    const { db, raw } = makeSqliteD1();
    const created = await createCheckRuns(db, logger, {
      changeId: "chg_1",
      projectId: "prj_1",
      revision: "tip-1",
      names: ["due", "done", "fresh"],
      secretRef: "WEBHOOK_CI",
      deadlineAt: "2026-11-09T12:00:00.000Z",
      supersede: "all",
      now: "2026-11-09T11:00:00.000Z",
    });
    if (!created.success) throw created.error;
    const id = (name: string) => created.data.find((c) => c.name === name)?.id ?? "";
    await applyCheckReport(db, logger, {
      id: id("done"),
      status: "passed",
      sequence: 1,
      now: "2026-11-09T11:30:00.000Z",
    });
    raw
      .prepare("UPDATE checks SET deadline_at = ? WHERE id = ?")
      .run("2026-11-09T18:00:00.000Z", id("fresh"));

    const expired = await expireOverdueChecks(db, logger, "2026-11-09T12:00:00.000Z");
    expect(expired.success && expired.data).toBe(1);
    const rows = raw.prepare("SELECT name, status FROM checks ORDER BY name").all();
    expect(rows).toEqual([
      { name: "done", status: "passed" },
      { name: "due", status: "errored" },
      { name: "fresh", status: "queued" },
    ]);
    // Idempotent: a second, overlapping sweep finds nothing left to do.
    const again = await expireOverdueChecks(db, logger, "2026-11-09T12:00:00.000Z");
    expect(again.success && again.data).toBe(0);
  });

  it("refuses a manual conflict resolution when checks are required", async () => {
    const { db } = makeSqliteD1();
    const verdict = await checkResolutionMergeProtection(
      db,
      logger,
      { diff: "diff --git a/x b/x\n+resolved\n", evalRuns: [] },
      policy,
    );
    expect(verdict.success && verdict.data.allowed).toBe(false);
    expect(verdict.success && verdict.data.reasons[0]).toContain(
      "Required check 'lint' cannot run against a manual conflict resolution",
    );
  });
});
