import {
  type EnforcementSubject,
  checkMeter,
  resolveEnforcementSubject,
  settleMeter,
} from "../billing/enforcement";
import { usagePeriod } from "../storage/usage";
import type { Env } from "../types";
import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import type { LlmProvider } from "./llm-provider";
import { LlmProviderResponseError } from "./llm-provider";
import { sanitizePolicy } from "./sanitize-policy";
import type {
  EvalPolicy,
  EvalResult,
  EvaluationContext,
  Evaluator,
  LlmEvaluatorConfig,
} from "./types";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MAX_DIFF_CHARS = 24_000;
// Policy-supplied window bounds: the ceiling stops a hostile policy blowing the
// model's context or the Worker's memory; the floor stops a tiny/fractional
// value feeding the model an effectively empty diff that it would still score.
const MAX_DIFF_CHARS_CEILING = 100_000;
const MAX_DIFF_CHARS_FLOOR = 1_000;
// The serialized policy shares the model's input budget with the diff; a
// pathological policy must not blow the context (or starve the diff), so an
// oversize one fails closed before any model call.
const MAX_POLICY_CONTEXT_CHARS = 8_000;
/**
 * Upper bound on the verdict this evaluator asks for, in tokens.
 *
 * Reserved alongside the input estimate because a reservation has to cover the
 * whole spend before any of it happens, and the response is part of it. The
 * verdict is a small JSON object — a score, a boolean, one sentence, a short
 * issue list — so this is generous by a wide margin on purpose: over-reserving
 * is corrected by the settle a few seconds later, while under-reserving is a
 * limit that admits more than it says.
 */
const MAX_OUTPUT_TOKENS = 1_000;

/**
 * What the refusals call the thing they are refusing. One string so the two
 * metered gates below cannot describe the same evaluator differently.
 */
const GATE_LABEL = "AI review";

const SYSTEM_PROMPT = [
  "You are a rigorous code reviewer acting as an automated merge gate.",
  "Review the diff for correctness bugs, security vulnerabilities, leaked credentials,",
  "and violations of the supplied policy context.",
  "Score 1.0 means safe to merge; 0.0 means must not merge.",
  "Respond with ONLY a JSON object and no other text:",
  '{"score": <0.0-1.0>, "passed": <bool>, "reason": "<one sentence>", "issues": ["<finding>"]}',
].join(" ");

export class LLMEvaluator implements Evaluator {
  /**
   * @param provider Who runs the model. Workers AI by default; an operator-
   *   configured HTTP provider on the project's own credential under BYOK.
   * @param costSource Who paid for the tokens this run reports. `"byok"` marks
   *   every cost sample so a project running on its own key does not decrement
   *   the hosted allowance — the whole point of the field, and something no
   *   later layer can reconstruct, since the recorded sample is all it sees.
   *   Defaults to `"platform"`, which the sample omits entirely (absent means
   *   the operator paid).
   * @param enforcement What this evaluator needs to consult an allowance: the
   *   `Env` holding the entitlements configuration and the `USAGE_METER`
   *   binding, and a `waitUntil` for warming an org's plan off the response
   *   path (PRD §4a). Omitted where a caller has no environment to give —
   *   every check is then skipped, exactly as it is for a self-hoster with no
   *   billing service configured.
   */
  constructor(
    private provider: LlmProvider,
    private costSource: "platform" | "byok" = "platform",
    private enforcement?: {
      env: Env;
      waitUntil?: (promise: Promise<unknown>) => void;
    },
  ) {}

  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
    context?: EvaluationContext,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting LLM evaluation");

    const nowMs = Date.now();
    const period = usagePeriod(new Date(nowMs));
    /** Set once a reservation is taken, so the `finally` knows what to settle. */
    let subject: EnforcementSubject | null = null;
    let tokensReserved: number | null = null;
    let rateReserved = false;
    let reachedProvider = false;
    /** True token cost of the run, once known; settled against the reservation. */
    let tokensSpent = 0;

    try {
      const config = policy.evaluators.find((e): e is LlmEvaluatorConfig => e.type === "llm");
      const model = config?.model ?? DEFAULT_MODEL;
      const threshold = config?.threshold ?? DEFAULT_THRESHOLD;
      const maxDiffChars =
        typeof config?.maxDiffChars === "number" && Number.isFinite(config.maxDiffChars)
          ? Math.min(
              Math.max(Math.floor(config.maxDiffChars), MAX_DIFF_CHARS_FLOOR),
              MAX_DIFF_CHARS_CEILING,
            )
          : DEFAULT_MAX_DIFF_CHARS;

      logger.debug("LLM config", { model, threshold, maxDiffChars });

      const truncated = diff.length > maxDiffChars;
      const truncationNote = truncated
        ? `Diff truncated for review: evaluated first ${maxDiffChars} of ${diff.length} chars`
        : undefined;

      const policyContext = JSON.stringify(sanitizePolicy(policy));
      if (policyContext.length > MAX_POLICY_CONTEXT_CHARS) {
        logger.warn("Policy context too large for LLM evaluation, failing closed", {
          policyChars: policyContext.length,
        });
        return ok({
          score: 0,
          passed: false,
          reason: `LLM evaluator failed closed: policy context is ${policyContext.length} chars (limit ${MAX_POLICY_CONTEXT_CHARS})`,
        });
      }

      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Policy context: ${policyContext}\n\nDiff to review:\n${diff.slice(0, maxDiffChars)}`,
        },
      ];

      const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);

      // Allowances are consulted HERE, between building the request and making
      // it, and a refusal below returns a FAILING gate rather than an absent
      // one. That is the whole shape of this check: a policy that requires AI
      // review must not stop requiring it because someone ran out of credit,
      // which is what dropping the evaluator (or passing it) would do. It
      // mirrors the oversize-policy branch above — `ok()` with `passed: false`
      // and a reason a human and an agent can both act on.
      if (this.enforcement && context?.billing) {
        const { env, waitUntil } = this.enforcement;
        subject = await resolveEnforcementSubject(env, logger, {
          ...(context.billing.actorUserId !== undefined
            ? { actorUserId: context.billing.actorUserId }
            : {}),
          owner: { ownerId: context.billing.ownerId, ownerType: context.billing.ownerType },
          ...(waitUntil !== undefined ? { waitUntil } : {}),
        });

        if (subject) {
          // The burst bound first, and it applies to BYOK too (PRD §4b): the
          // operator still pays for the subrequest and the Worker wall time,
          // whoever owns the tokens. One evaluation, no settle — a rate check
          // is a reserve that is never given back.
          const rate = await checkMeter(env, logger, {
            subject,
            meter: "evaluations_per_hour",
            estimate: 1,
            nowMs,
            period,
            what: GATE_LABEL,
          });
          rateReserved = rate.reserved;
          if (!rate.admitted) {
            return ok({
              score: 0,
              passed: false,
              reason: rate.reason ?? `${GATE_LABEL} could not run: evaluation rate limit reached`,
            });
          }

          // The token allowance, and the one thing BYOK does lift: a project
          // paying its own provider bill is not spending the hosted allowance,
          // so charging it against one would be charging twice.
          if (this.costSource === "platform") {
            // The PROMPT that is about to be sent, not the window it is allowed
            // to fill. Reserving `maxDiffChars` charged a three-line diff ~6,000
            // tokens up front, so someone with 5,000 left was refused for a call
            // that would have cost 300 — a refusal produced by the estimate
            // rather than by the spend. It is still an upper bound: ~4 chars per
            // token is the conservative direction for English and code, and the
            // response is covered by MAX_OUTPUT_TOKENS on top.
            const estimate = Math.ceil(promptChars / 4) + MAX_OUTPUT_TOKENS;
            const tokens = await checkMeter(env, logger, {
              subject,
              meter: "llm_tokens_month",
              estimate,
              nowMs,
              period,
              what: GATE_LABEL,
            });
            if (tokens.reserved) tokensReserved = estimate;
            if (!tokens.admitted) {
              return ok({
                score: 0,
                passed: false,
                reason: tokens.reason ?? `${GATE_LABEL} could not run: token allowance is used up`,
              });
            }
          }
        }
      }

      // Written only for `byok`: an absent `source` already means "platform",
      // so always emitting it would add a field that says nothing to every
      // sample the operator pays for.
      const source = this.costSource === "byok" ? { source: "byok" as const } : {};

      reachedProvider = true;
      const runResult = await this.provider.run(model, messages);

      if (!runResult.success) {
        // A response that arrived but cannot be used fails the gate closed with
        // a readable reason; a transport failure stays an error the caller
        // surfaces. Either way the provider's own message is metadata only and
        // becomes user-visible: this block interpolates it into the reason
        // below, and `runEvaluation` copies the message of the error the other
        // branch returns into a reason of its own.
        if (runResult.error instanceof LlmProviderResponseError) {
          // The `cause` is logged, not described. It is the only record of what
          // the provider actually sent — a `SyntaxError` from `JSON.parse`
          // quotes the bytes that failed — and attaching it would be pointless
          // if nothing ever read it. It goes to the OPERATOR's log and never
          // into the reason below, which is rendered to anyone who can read the
          // change; the bound keeps a large body out of a log line.
          const cause = runResult.error.cause;
          logger.error(
            `LLM evaluation failed: ${runResult.error.message}`,
            runResult.error,
            cause === undefined
              ? undefined
              : { cause: String(cause instanceof Error ? cause.message : cause).slice(0, 200) },
          );
          // A verdict truncated at the provider's token cap was generated, and
          // billed. `failClosed` further down records the cost of a response it
          // could not read, and this is the same case one layer up: without it a
          // charged call records zero. Only counts the provider actually
          // REPORTED are recorded — a failure that produced no tokens (a 401, a
          // refused redirect) carries none and bills nothing.
          const billed = runResult.error.usage;
          if (billed) tokensSpent = billed.inputTokens + billed.outputTokens;
          return ok({
            score: 0,
            passed: false,
            reason: `LLM evaluator error: ${runResult.error.message}`,
            ...(billed
              ? {
                  costs: [
                    {
                      kind: "llm_tokens" as const,
                      quantity: billed.inputTokens + billed.outputTokens,
                      ...source,
                    },
                  ],
                }
              : {}),
          });
        }
        logger.error("LLM evaluation failed", runResult.error);
        return err(runResult.error);
      }

      const responseText = runResult.data.text;
      const usage = runResult.data.usage;
      // Real counts when the provider reports them, otherwise ~4 chars/token —
      // the distinction is per response, not per source. Every provider behind
      // this seam reports counts when it has them, Workers AI included; a
      // response that omits them, or reports ones the provider would not trust,
      // is what keeps a run on the estimate.
      const costs: EvalResult["costs"] = usage
        ? [{ kind: "llm_tokens", quantity: usage.inputTokens + usage.outputTokens, ...source }]
        : [
            {
              kind: "llm_tokens",
              quantity: Math.ceil((promptChars + responseText.length) / 4),
              estimated: true,
              ...source,
            },
          ];
      // What the settle in the `finally` corrects the reservation by. Read off
      // the same sample the ledger records, so the counter and the ledger
      // cannot disagree about what one run cost.
      tokensSpent = costs[0]?.quantity ?? 0;

      // A gate whose verdict can't be read has not passed. Never infer a score
      // from prose ("LGTM") — that let unparseable output half-approve a merge.
      // Never echo raw model output into the result: the model can quote the
      // diff, and the diff can contain exactly the secrets this gate catches.
      const failClosed = (why: string): Result<EvalResult, AppError> => {
        logger.warn("LLM response unusable, failing closed", { why });
        return ok({
          score: 0,
          passed: false,
          reason: `LLM evaluator failed closed: ${why}`,
          issues: [
            `Model response (${responseText.length} chars) was not a valid verdict object`,
            ...(truncationNote ? [truncationNote] : []),
          ],
          costs,
        });
      };

      let parsed: { score: unknown; passed: unknown; reason: unknown; issues?: unknown };
      try {
        parsed = JSON.parse(responseText) as {
          score: unknown;
          passed: unknown;
          reason: unknown;
          issues?: unknown;
        };
      } catch {
        return failClosed("response was not valid JSON");
      }

      if (
        typeof parsed.score !== "number" ||
        !Number.isFinite(parsed.score) ||
        typeof parsed.passed !== "boolean" ||
        typeof parsed.reason !== "string"
      ) {
        return failClosed("response JSON missing score/passed/reason fields");
      }

      const score = Math.min(1, Math.max(0, parsed.score));
      const passed = parsed.passed && score >= threshold;
      const modelIssues =
        Array.isArray(parsed.issues) && parsed.issues.every((i) => typeof i === "string")
          ? (parsed.issues as string[])
          : [];
      const issues = truncationNote ? [...modelIssues, truncationNote] : modelIssues;

      logger.info("LLM evaluation complete", { score, passed, truncated });

      return ok({
        score,
        passed,
        reason: parsed.reason,
        ...(issues.length > 0 ? { issues } : {}),
        costs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("LLM evaluation failed", error instanceof Error ? error : new Error(message));
      return err(
        new ExternalServiceError(
          "LLM",
          message,
          error instanceof Error ? error : undefined,
        ) as AppError,
      );
    } finally {
      // In a `finally` because a provider call that throws has still consumed
      // the reservation. Leaving it standing would charge the subject the whole
      // upper bound for a run that produced nothing, and a handful of those
      // walls somebody off at a fraction of an allowance they never spent.
      const settleSubject = subject;
      if (settleSubject && this.enforcement) {
        const { env } = this.enforcement;
        // Contained deliberately, exactly as `SandboxEvaluator` contains its
        // teardown: an `await` that rejects inside `finally` REPLACES the
        // returned Result with a rejection, which rejects the `Promise.all` in
        // `runEvaluation` and fails change creation outright. A Durable Object
        // RPC that cannot be reached is an operational problem to log — a
        // correction to a counter, not a merge outage. It is the same failure
        // the meter's malformed-input deviation exists to prevent, and it must
        // not be reintroduced by the settle path.
        const settle = async (
          meter: "llm_tokens_month" | "evaluations_per_hour",
          delta: number,
        ) => {
          try {
            await settleMeter(env, logger, { subject: settleSubject, meter, delta, nowMs, period });
          } catch (error) {
            logger.error(
              "Usage meter settle failed; the reservation stands until the period rolls",
              error instanceof Error ? error : new Error(String(error)),
              { meter, delta },
            );
          }
        };
        if (tokensReserved !== null) {
          await settle("llm_tokens_month", tokensSpent - tokensReserved);
        }
        // A rate slot is given back only when the evaluation never reached the
        // provider — a token refusal after the rate check admitted. Once the
        // request is out the door the operator has paid for the subrequest and
        // the wall time it bounds, so a failed run still costs its slot.
        if (rateReserved && !reachedProvider) {
          await settle("evaluations_per_hour", -1);
        }
      }
    }
  }
}
