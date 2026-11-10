/**
 * Daily check that evaluation still works, with an alert when it does not.
 *
 * Evaluation fails closed. That is right for a gate and wrong for noticing: a
 * reviewer model the provider retired, or a worker that runs out of memory,
 * looks from outside like changes that need work. The default `llm` model was
 * retired on 2026-05-30 and went unnoticed for five months, because nothing
 * was counting.
 *
 * Two checks, since they catch different things:
 *
 * - **A canary.** The `llm` evaluator, on the instance's own binding and the
 *   default model, reviews one diff that should pass and one that should not.
 *   Catches a retired model, a changed response format, a model too slow for
 *   the timeout, and a model that has stopped telling the two apart — before a
 *   user meets any of them.
 * - **Failure counts over the last day**, from real runs. Catches what the
 *   canary cannot see, such as runs that never report back.
 *
 * Findings go to {@link raiseOpsAlert}; a clean run closes the alert.
 */
import { LLMEvaluator } from "../evaluation/llm-evaluator";
import { WorkersAiProvider } from "../evaluation/llm-provider";
import type { EvalPolicy } from "../evaluation/types";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";
import {
  type OpsAlertEnv,
  type OpsAlertOutcome,
  raiseOpsAlert,
  resolveOpsAlert,
} from "./ops-alerts";

export const EVALUATION_HEALTH_ALERT_TITLE = "Evaluation health check is failing";

/**
 * Reasons the `llm` evaluator records when it could not get a verdict at all:
 * the provider refused or failed, or did not answer in time. Matched as
 * prefixes of `eval_runs.reason`, which is where `LLMEvaluator` writes them;
 * `tests/evaluation-health.test.ts` runs the real evaluator against both so a
 * reworded reason fails there instead of silently counting nothing.
 *
 * Deliberately not every fail-closed reason. An oversized policy is the
 * project's own doing, and one unparseable verdict is a model having a bad
 * day; neither says the instance is broken.
 */
export const LLM_UNAVAILABLE_REASON_PREFIXES = [
  "LLM error:",
  "LLM evaluator failed closed: no verdict within",
] as const;

/** Prefix of `changes.eval_reason` for a run that never produced a verdict. */
export const RUN_INCOMPLETE_REASON_PREFIX = "Evaluation did not complete:";

/** How far back the failure counts look. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `llm` runs without a verdict that it takes to alert: at least this many, and
 * at least {@link LLM_UNAVAILABLE_MIN_SHARE} of all `llm` runs in the window.
 * Both, because the counts include projects running on their own provider key:
 * one project with a bad key should not page the operator, and neither should
 * two failures on a quiet day.
 */
export const LLM_UNAVAILABLE_MIN_COUNT = 5;
export const LLM_UNAVAILABLE_MIN_SHARE = 0.5;

/** Runs that never reported back that it takes to alert. One can be a deploy
 * landing mid-run; several are a pattern. */
export const RUN_INCOMPLETE_MIN_COUNT = 3;

const CANARY_POLICY: EvalPolicy = { evaluators: [{ type: "llm" }] };

/** A small, sound change. The reviewer should pass it. */
export const CANARY_SOUND_DIFF = `diff --git a/src/utils/clamp.ts b/src/utils/clamp.ts
new file mode 100644
--- /dev/null
+++ b/src/utils/clamp.ts
@@ -0,0 +1,9 @@
+/**
+ * Clamp \`value\` to the inclusive range [min, max].
+ * A value that is not a finite number becomes \`min\`.
+ */
+export function clamp(value: number, min: number, max: number): number {
+  if (!Number.isFinite(value)) return min;
+  return Math.min(max, Math.max(min, value));
+}
+
diff --git a/tests/clamp.test.ts b/tests/clamp.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/clamp.test.ts
@@ -0,0 +1,11 @@
+import { expect, it } from "vitest";
+import { clamp } from "../src/utils/clamp";
+
+it("clamps to the range", () => {
+  expect(clamp(5, 0, 10)).toBe(5);
+  expect(clamp(-1, 0, 10)).toBe(0);
+  expect(clamp(11, 0, 10)).toBe(10);
+});
+
+it("treats a non-finite value as the minimum", () => {
+  expect(clamp(Number.NaN, 0, 10)).toBe(0);
+});
`;

/**
 * A change no reviewer should pass: it evaluates a query parameter as code and
 * builds SQL by concatenating another. Never executed — it is only ever sent to
 * the model as text.
 */
export const CANARY_UNSOUND_DIFF = `diff --git a/src/routes/run.ts b/src/routes/run.ts
new file mode 100644
--- /dev/null
+++ b/src/routes/run.ts
@@ -0,0 +1,14 @@
+import { Hono } from "hono";
+const app = new Hono();
+
+// Admin helper: run whatever the caller sends.
+app.get("/api/run", async (c) => {
+  const code = c.req.query("code") ?? "";
+  // biome-ignore lint: quick hack
+  const result = eval(code);
+  const rows = await c.env.DB.prepare(
+    "SELECT * FROM users WHERE name = '" + c.req.query("name") + "'",
+  ).all();
+  return c.json({ result, rows });
+});
+export default app;
`;

type CanaryCase = { name: string; diff: string; shouldPass: boolean };

const CANARY_CASES: CanaryCase[] = [
  { name: "a sound change", diff: CANARY_SOUND_DIFF, shouldPass: true },
  { name: "an unsound change", diff: CANARY_UNSOUND_DIFF, shouldPass: false },
];

function isUnavailableReason(reason: string | undefined): boolean {
  return LLM_UNAVAILABLE_REASON_PREFIXES.some((prefix) => (reason ?? "").startsWith(prefix));
}

/** One attempt at one case. Returns what was wrong, or null if it went as expected. */
async function attemptCanaryCase(
  evaluator: LLMEvaluator,
  testCase: CanaryCase,
  logger: Logger,
): Promise<string | null> {
  const result = await evaluator.evaluate(testCase.diff, CANARY_POLICY, logger);
  // A provider failure comes back as an error; `runEvaluation` records its
  // message as the run's reason, which is the `LLM error:` the counts match.
  if (!result.success) {
    return `The reviewer gave no verdict on ${testCase.name}: ${result.error.message}`;
  }
  const { passed, reason, score } = result.data;
  if (isUnavailableReason(reason)) {
    return `The reviewer gave no verdict on ${testCase.name}: ${reason}`;
  }
  if (passed === testCase.shouldPass) return null;
  return testCase.shouldPass
    ? `The reviewer rejected ${testCase.name} (score ${score}): ${reason}`
    : `The reviewer passed ${testCase.name} (score ${score}): ${reason}`;
}

/**
 * Run the canary. A case that goes wrong is tried once more before it counts:
 * a model's answer varies from call to call, and an alert that fires on one
 * odd answer teaches people to ignore it.
 */
export async function runEvaluationCanary(
  env: Pick<Env, "AI">,
  logger: Logger,
): Promise<{ skipped: true } | { skipped: false; findings: string[] }> {
  if (!env.AI) return { skipped: true };
  const evaluator = new LLMEvaluator(new WorkersAiProvider(env.AI));

  const findings: string[] = [];
  for (const testCase of CANARY_CASES) {
    const first = await attemptCanaryCase(evaluator, testCase, logger);
    if (first === null) continue;
    const second = await attemptCanaryCase(evaluator, testCase, logger);
    if (second !== null) findings.push(second);
  }
  return { skipped: false, findings };
}

/** Count real runs in the last day that ended without a verdict. */
export async function countEvaluationFailures(
  env: Pick<Env, "DB">,
  logger: Logger,
  now: Date,
): Promise<{ findings: string[] }> {
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const findings: string[] = [];
  try {
    const unavailable = LLM_UNAVAILABLE_REASON_PREFIXES.map(() => "reason LIKE ?").join(" OR ");
    const llm = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN ${unavailable} THEN 1 ELSE 0 END), 0) AS unavailable
         FROM eval_runs
        WHERE evaluator_type = 'llm' AND ran_at >= ?`,
    )
      .bind(...LLM_UNAVAILABLE_REASON_PREFIXES.map((prefix) => `${prefix}%`), since)
      .first<{ total: number; unavailable: number }>();
    const total = llm?.total ?? 0;
    const failed = llm?.unavailable ?? 0;
    if (failed >= LLM_UNAVAILABLE_MIN_COUNT && failed >= total * LLM_UNAVAILABLE_MIN_SHARE) {
      findings.push(
        `${failed} of ${total} AI reviews in the last 24 hours got no verdict from the model (provider error or timeout).`,
      );
    }

    const incomplete = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM changes WHERE eval_reason LIKE ? AND eval_requested_at >= ?",
    )
      .bind(`${RUN_INCOMPLETE_REASON_PREFIX}%`, since)
      .first<{ count: number }>();
    const stuck = incomplete?.count ?? 0;
    if (stuck >= RUN_INCOMPLETE_MIN_COUNT) {
      findings.push(
        `${stuck} changes in the last 24 hours had an evaluation that never reported back. The evaluation worker is probably being stopped mid-run (memory or time limit).`,
      );
    }
  } catch (error) {
    // Not a finding: failing to count is a database problem, and reporting it
    // as "evaluation is failing" would send someone to the wrong place.
    logger.error(
      "Evaluation health: could not count failures",
      error instanceof Error ? error : undefined,
    );
  }
  return { findings };
}

function alertBody(findings: string[], model: string): string {
  return [
    "Stratum's daily evaluation health check found a problem.",
    "",
    ...findings.map((finding) => `- ${finding}`),
    "",
    "Evaluation fails closed, so while this lasts, affected changes are marked as needing changes whatever their content.",
    "",
    "Where to look:",
    `- The default \`llm\` model is \`${model}\`. Workers AI retires models; check its deprecation notices at https://developers.cloudflare.com/changelog/product/workers-ai/`,
    "- The `stratum-evaluations` queue consumer in the Worker's logs, for runs ending in `exceededMemory` or `exceededCpu`.",
    "",
    "This issue was opened automatically and closes itself when the check passes again.",
  ].join("\n");
}

/**
 * The scheduled job. Never rejects: a health check that throws takes nothing
 * down with it, but it also must not look like a finding.
 */
export async function runEvaluationHealthCheck(
  env: Pick<Env, "AI"> & OpsAlertEnv,
  logger: Logger,
  now: Date = new Date(),
): Promise<{ findings: string[]; canarySkipped: boolean; alert: OpsAlertOutcome }> {
  const canary = await runEvaluationCanary(env, logger);
  const counted = await countEvaluationFailures(env, logger, now);
  const findings = [...(canary.skipped ? [] : canary.findings), ...counted.findings];

  const alert =
    findings.length > 0
      ? await raiseOpsAlert(env, logger, {
          title: EVALUATION_HEALTH_ALERT_TITLE,
          body: alertBody(findings, LLMEvaluator.DEFAULT_MODEL),
        })
      : await resolveOpsAlert(env, logger, EVALUATION_HEALTH_ALERT_TITLE);

  logger.info("Evaluation health check finished", {
    findings: findings.length,
    canarySkipped: canary.skipped,
    alert: alert.status,
  });
  return { findings, canarySkipped: canary.skipped, alert };
}
