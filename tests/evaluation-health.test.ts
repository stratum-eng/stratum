import { describe, expect, it, vi } from "vitest";
import { LLMEvaluator } from "../src/evaluation/llm-evaluator";
import { WorkersAiProvider } from "../src/evaluation/llm-provider";
import {
  CANARY_SOUND_DIFF,
  CANARY_UNSOUND_DIFF,
  EVALUATION_HEALTH_ALERT_TITLE,
  LLM_UNAVAILABLE_MIN_COUNT,
  LLM_UNAVAILABLE_REASON_PREFIXES,
  RUN_INCOMPLETE_MIN_COUNT,
  RUN_INCOMPLETE_REASON_PREFIX,
  countEvaluationFailures,
  runEvaluationCanary,
  runEvaluationHealthCheck,
} from "../src/services/evaluation-health";
import { evaluationFailureReason } from "../src/services/evaluation-run";
import { parseAlertProject, raiseOpsAlert, resolveOpsAlert } from "../src/services/ops-alerts";
import { SYSTEM_AUTHOR_ID, createIssue, listIssues } from "../src/storage/issues";
import type { AiBinding, Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;
(logger.child as ReturnType<typeof vi.fn>).mockReturnValue(logger);

const NOW = new Date("2026-11-10T06:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const project: ProjectEntry = {
  id: "proj_ops",
  name: "ops",
  slug: "ops",
  namespace: "@acme",
  ownerId: "org_1",
  ownerType: "org",
  remote: "https://acct.artifacts.cloudflare.net/git/acme__ops.git",
  createdAt: NOW.toISOString(),
  visibility: "private",
};

const verdict = (passed: boolean) =>
  JSON.stringify({
    score: passed ? 0.95 : 0,
    passed,
    reason: passed ? "fine" : "unsafe",
    issues: [],
  });

/** A model that passes the sound diff and rejects the unsound one, unless told otherwise. */
function makeAi(answer?: (diff: "sound" | "unsound", call: number) => unknown): AiBinding {
  let call = 0;
  return {
    run: vi.fn(async (_model: string, options: { messages?: Array<{ content: string }> }) => {
      const prompt = (options.messages ?? []).map((m) => m.content).join("\n");
      const which = prompt.includes(CANARY_UNSOUND_DIFF) ? "unsound" : "sound";
      const custom = answer?.(which, call++);
      if (custom !== undefined) {
        if (custom instanceof Error) throw custom;
        return custom as { response: string };
      }
      return { response: verdict(which === "sound") };
    }),
  } as unknown as AiBinding;
}

function makeEnv(overrides: Partial<Env> = {}) {
  const { db, raw } = makeSqliteD1();
  const kv = makeFakeKV();
  kv.store.set("project:@acme:ops", JSON.stringify(project));
  const env = {
    DB: db,
    STATE: kv,
    AI: makeAi(),
    OPS_ALERT_PROJECT: "@acme/ops",
    ...overrides,
  } as unknown as Env;
  return { env, raw };
}

const openAlerts = async (env: Env) => {
  const listed = await listIssues(env.DB, logger, project.name, "open", { projectId: project.id });
  return listed.success ? listed.data : [];
};

describe("parseAlertProject", () => {
  it("accepts a namespace with or without the @", () => {
    expect(parseAlertProject("@acme/ops")).toEqual({ namespace: "@acme", slug: "ops" });
    expect(parseAlertProject(" acme/ops ")).toEqual({ namespace: "acme", slug: "ops" });
  });

  it("refuses anything that is not namespace/slug", () => {
    for (const bad of [undefined, "", "ops", "@acme/", "/ops", "a/b/c", "@acme/ops?x=1"]) {
      expect(parseAlertProject(bad)).toBeNull();
    }
  });
});

describe("ops alerts", () => {
  const alert = { title: "Something is failing", body: "details" };

  it("opens one issue, and does not open a second while it is open", async () => {
    const { env } = makeEnv();
    expect(await raiseOpsAlert(env, logger, alert)).toEqual({ status: "opened", number: 1 });
    expect(await raiseOpsAlert(env, logger, alert)).toEqual({ status: "already-open", number: 1 });

    const open = await openAlerts(env);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      title: alert.title,
      body: alert.body,
      authorType: "agent",
      authorId: SYSTEM_AUTHOR_ID,
      projectId: project.id,
    });
  });

  it("closes its issue on recovery, so the next failure opens a new one", async () => {
    const { env } = makeEnv();
    await raiseOpsAlert(env, logger, alert);
    expect(await resolveOpsAlert(env, logger, alert.title)).toEqual({
      status: "closed",
      number: 1,
    });
    expect(await openAlerts(env)).toHaveLength(0);
    expect(await resolveOpsAlert(env, logger, alert.title)).toEqual({ status: "nothing-open" });
    expect(await raiseOpsAlert(env, logger, alert)).toEqual({ status: "opened", number: 2 });
  });

  it("leaves a person's issue with the same title alone", async () => {
    const { env } = makeEnv();
    await createIssue(env.DB, logger, {
      project: project.name,
      projectId: project.id as string,
      title: alert.title,
      authorType: "user",
      authorId: "usr_someone",
    });

    expect(await resolveOpsAlert(env, logger, alert.title)).toEqual({ status: "nothing-open" });
    expect(await raiseOpsAlert(env, logger, alert)).toEqual({ status: "opened", number: 2 });
    expect(await openAlerts(env)).toHaveLength(2);
  });

  it("only logs when no project is configured, or it does not resolve", async () => {
    for (const value of [undefined, "  ", "not a project", "@acme/missing"]) {
      const { env } = makeEnv({ OPS_ALERT_PROJECT: value } as Partial<Env>);
      const raised = await raiseOpsAlert(env, logger, alert);
      expect(raised.status).toBe("logged-only");
      expect((await resolveOpsAlert(env, logger, alert.title)).status).toBe("logged-only");
    }
    expect(logger.error).toHaveBeenCalledWith("Operational alert", undefined, alert);
  });

  it("reports a database failure instead of throwing", async () => {
    const { env } = makeEnv({ DB: makeThrowingD1() } as Partial<Env>);
    expect((await raiseOpsAlert(env, logger, alert)).status).toBe("failed");
    expect((await resolveOpsAlert(env, logger, alert.title)).status).toBe("failed");
  });
});

describe("runEvaluationCanary", () => {
  it("is skipped on an instance with no AI binding", async () => {
    expect(await runEvaluationCanary({}, logger)).toEqual({ skipped: true });
  });

  it("finds nothing when the reviewer passes the sound diff and rejects the unsound one", async () => {
    const ai = makeAi();
    expect(await runEvaluationCanary({ AI: ai }, logger)).toEqual({ skipped: false, findings: [] });
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(ai.run).toHaveBeenCalledWith(LLMEvaluator.DEFAULT_MODEL, expect.anything());
  });

  it("does not report a wrong answer that comes right on the second try", async () => {
    const ai = makeAi((which, call) =>
      which === "sound" && call === 0 ? { response: verdict(false) } : undefined,
    );
    expect(await runEvaluationCanary({ AI: ai }, logger)).toEqual({ skipped: false, findings: [] });
    expect(ai.run).toHaveBeenCalledTimes(3);
  });

  it("reports a provider error, such as a retired model", async () => {
    const ai = makeAi(() => new Error("5028: model was deprecated"));
    const result = await runEvaluationCanary({ AI: ai }, logger);
    expect(result).toMatchObject({ skipped: false });
    if (result.skipped) return;
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toContain("gave no verdict on a sound change");
    expect(result.findings[0]).toContain("5028");
  });

  it("reports a reviewer that passes the unsound diff", async () => {
    const ai = makeAi(() => ({ response: verdict(true) }));
    const result = await runEvaluationCanary({ AI: ai }, logger);
    if (result.skipped) throw new Error("not skipped");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain("passed an unsound change");
  });

  it("reports a reviewer that rejects the sound diff", async () => {
    const ai = makeAi(() => ({ response: verdict(false) }));
    const result = await runEvaluationCanary({ AI: ai }, logger);
    if (result.skipped) throw new Error("not skipped");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toContain("rejected a sound change");
  });
});

describe("the reasons the counts match", () => {
  // The counts match prefixes of text other modules write. These run the real
  // writers, so a reworded reason fails here.
  it("covers a provider error and a timeout from the real evaluator", async () => {
    const failing = { run: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as AiBinding;
    const errored = await new LLMEvaluator(new WorkersAiProvider(failing)).evaluate(
      CANARY_SOUND_DIFF,
      { evaluators: [{ type: "llm" }] },
      logger,
    );
    // `runEvaluation` records a failed evaluator's error message as the run's reason.
    expect(errored.success).toBe(false);
    if (!errored.success) expect(errored.error.message).toMatch(/^LLM error:/);

    vi.useFakeTimers();
    try {
      const hanging = { run: () => new Promise(() => {}) } as unknown as AiBinding;
      const pending = new LLMEvaluator(new WorkersAiProvider(hanging)).evaluate(
        CANARY_SOUND_DIFF,
        { evaluators: [{ type: "llm" }] },
        logger,
      );
      await vi.advanceTimersByTimeAsync(120_000);
      const timedOut = await pending;
      const reason = timedOut.success ? (timedOut.data.reason ?? "") : "";
      expect(LLM_UNAVAILABLE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix))).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers a run that never reported back", () => {
    expect(evaluationFailureReason("the evaluation run never reported back")).toMatch(
      new RegExp(`^${RUN_INCOMPLETE_REASON_PREFIX}`),
    );
  });
});

describe("countEvaluationFailures", () => {
  function seed(raw: ReturnType<typeof makeSqliteD1>["raw"]) {
    let n = 0;
    const change = (reason: string | null, requestedAt: Date) => {
      const id = `chg_${n++}`;
      raw
        .prepare(
          "INSERT INTO changes (id, project, workspace, status, eval_reason, eval_requested_at) VALUES (?, 'p', 'w', 'needs_changes', ?, ?)",
        )
        .run(id, reason, requestedAt.toISOString());
      return id;
    };
    const llmRun = (reason: string, ranAt: Date) => {
      const changeId = change(null, ranAt);
      raw
        .prepare(
          "INSERT INTO eval_runs (id, change_id, evaluator_type, score, passed, reason, ran_at) VALUES (?, ?, 'llm', 0, 0, ?, ?)",
        )
        .run(`evl_${n++}`, changeId, reason, ranAt.toISOString());
    };
    return { change, llmRun };
  }
  const recent = new Date(NOW.getTime() - HOUR);
  const old = new Date(NOW.getTime() - 30 * HOUR);

  it("finds nothing on a healthy day", async () => {
    const { env, raw } = makeEnv();
    const { llmRun } = seed(raw);
    for (let i = 0; i < 20; i++) llmRun("Looks fine", recent);
    llmRun("LLM error: blip", recent);
    expect(await countEvaluationFailures(env, logger, NOW)).toEqual({ findings: [] });
  });

  it("reports AI reviews that mostly got no verdict", async () => {
    const { env, raw } = makeEnv();
    const { llmRun } = seed(raw);
    for (let i = 0; i < LLM_UNAVAILABLE_MIN_COUNT; i++)
      llmRun("LLM error: 5028: deprecated", recent);
    llmRun("LLM evaluator failed closed: no verdict within 30000ms", recent);
    llmRun("Looks fine", recent);
    const { findings } = await countEvaluationFailures(env, logger, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(
      `${LLM_UNAVAILABLE_MIN_COUNT + 1} of ${LLM_UNAVAILABLE_MIN_COUNT + 2} AI reviews`,
    );
  });

  it("does not report a few failures, a minority of failures, or old ones", async () => {
    const { env, raw } = makeEnv();
    const { llmRun } = seed(raw);
    // Below the count.
    for (let i = 0; i < LLM_UNAVAILABLE_MIN_COUNT - 1; i++) llmRun("LLM error: x", recent);
    expect((await countEvaluationFailures(env, logger, NOW)).findings).toEqual([]);
    // At the count, but a minority of the day's runs.
    llmRun("LLM error: x", recent);
    for (let i = 0; i < LLM_UNAVAILABLE_MIN_COUNT * 3; i++) llmRun("Looks fine", recent);
    expect((await countEvaluationFailures(env, logger, NOW)).findings).toEqual([]);
    // Outside the window.
    for (let i = 0; i < 50; i++) llmRun("LLM error: x", old);
    expect((await countEvaluationFailures(env, logger, NOW)).findings).toEqual([]);
  });

  it("does not count failures that are the project's own or a one-off", async () => {
    const { env, raw } = makeEnv();
    const { llmRun } = seed(raw);
    for (let i = 0; i < 10; i++) {
      llmRun("LLM evaluator failed closed: policy context is 9000 chars (limit 8000)", recent);
      llmRun("LLM evaluator failed closed: response was not valid JSON", recent);
    }
    expect((await countEvaluationFailures(env, logger, NOW)).findings).toEqual([]);
  });

  it("reports runs that never reported back", async () => {
    const { env, raw } = makeEnv();
    const { change } = seed(raw);
    const reason = evaluationFailureReason("the evaluation run never reported back");
    for (let i = 0; i < RUN_INCOMPLETE_MIN_COUNT - 1; i++) change(reason, recent);
    change(reason, old);
    expect((await countEvaluationFailures(env, logger, NOW)).findings).toEqual([]);

    change(reason, recent);
    const { findings } = await countEvaluationFailures(env, logger, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${RUN_INCOMPLETE_MIN_COUNT} changes`);
  });

  it("treats a database failure as no finding, and logs it", async () => {
    const { env } = makeEnv({ DB: makeThrowingD1() } as Partial<Env>);
    expect(await countEvaluationFailures(env, logger, NOW)).toEqual({ findings: [] });
    expect(logger.error).toHaveBeenCalledWith(
      "Evaluation health: could not count failures",
      expect.anything(),
    );
  });
});

describe("runEvaluationHealthCheck", () => {
  it("opens an issue naming the findings and the default model, then closes it on recovery", async () => {
    const broken = makeAi(() => new Error("5028: model was deprecated"));
    const { env } = makeEnv({ AI: broken } as Partial<Env>);

    const failing = await runEvaluationHealthCheck(env, logger, NOW);
    expect(failing.alert).toEqual({ status: "opened", number: 1 });
    expect(failing.findings).toHaveLength(2);
    const [issue] = await openAlerts(env);
    expect(issue?.title).toBe(EVALUATION_HEALTH_ALERT_TITLE);
    expect(issue?.body).toContain("gave no verdict on a sound change");
    expect(issue?.body).toContain(LLMEvaluator.DEFAULT_MODEL);

    // Still failing the next day: no second issue.
    expect((await runEvaluationHealthCheck(env, logger, NOW)).alert).toEqual({
      status: "already-open",
      number: 1,
    });

    const healthy = await runEvaluationHealthCheck({ ...env, AI: makeAi() }, logger, NOW);
    expect(healthy).toMatchObject({ findings: [], alert: { status: "closed", number: 1 } });
    expect(await openAlerts(env)).toHaveLength(0);
  });

  it("still counts real failures on an instance with no AI binding", async () => {
    const { env, raw } = makeEnv({ AI: undefined } as Partial<Env>);
    const reason = evaluationFailureReason("the evaluation run never reported back");
    for (let i = 0; i < RUN_INCOMPLETE_MIN_COUNT; i++) {
      raw
        .prepare(
          "INSERT INTO changes (id, project, workspace, status, eval_reason, eval_requested_at) VALUES (?, 'p', 'w', 'needs_changes', ?, ?)",
        )
        .run(`chg_${i}`, reason, new Date(NOW.getTime() - HOUR).toISOString());
    }
    const result = await runEvaluationHealthCheck(env, logger, NOW);
    expect(result).toMatchObject({ canarySkipped: true, alert: { status: "opened" } });
    expect(result.findings).toHaveLength(1);
  });

  it("does nothing visible on a healthy instance", async () => {
    const { env } = makeEnv();
    expect(await runEvaluationHealthCheck(env, logger, NOW)).toEqual({
      findings: [],
      canarySkipped: false,
      alert: { status: "nothing-open" },
    });
  });
});
