import type { AiBinding } from "../types";
import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import type { EvalPolicy, EvalResult, Evaluator, EvaluatorConfig } from "./types";

function sanitizePolicy(policy: EvalPolicy): EvalPolicy {
  return {
    ...policy,
    evaluators: policy.evaluators.map((cfg: EvaluatorConfig) => {
      if (cfg.type === "webhook") {
        const { secret: _secret, ...rest } = cfg;
        return rest;
      }
      return cfg;
    }),
  };
}

export class LLMEvaluator implements Evaluator {
  constructor(private ai: AiBinding) {}

  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting LLM evaluation");

    try {
      const config = policy.evaluators.find((e) => e.type === "llm") as
        | { type: "llm"; model?: string; threshold?: number }
        | undefined;
      const model = config?.model ?? "@cf/meta/llama-3.1-8b-instruct";
      const threshold = config?.threshold ?? 0.7;

      logger.debug("LLM config", { model, threshold });

      const messages = [
        {
          role: "system",
          content:
            '{"score": <0.0-1.0>, "passed": <bool>, "reason": "<string>", "issues": ["<string>"]}',
        },
        {
          role: "user",
          content: `Policy context: ${JSON.stringify(sanitizePolicy(policy))}\n\nDiff to review:\n${diff.slice(0, 8000)}`,
        },
      ];

      const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
      const raw = await this.ai.run(model, { messages });

      if (raw instanceof ReadableStream) {
        logger.error("LLM evaluation failed: unexpected stream response");
        return ok({
          score: 0,
          passed: false,
          reason: "LLM evaluator error: unexpected stream response",
        });
      }

      const responseText = raw.response;
      // Workers AI does not report token usage; ~4 chars/token is the standard estimate.
      const estimatedTokens = Math.ceil((promptChars + (responseText?.length ?? 0)) / 4);
      const costs: EvalResult["costs"] = [
        { kind: "llm_tokens", quantity: estimatedTokens, estimated: true },
      ];

      let parsed: { score: unknown; passed: unknown; reason: unknown; issues?: unknown };
      try {
        parsed = JSON.parse(responseText ?? "") as {
          score: unknown;
          passed: unknown;
          reason: unknown;
          issues?: unknown;
        };
      } catch {
        const fallbackScore = responseText?.includes("LGTM") ? 0.8 : 0.3;
        logger.warn("LLM response parse failed, using fallback", { fallbackScore });
        return ok({
          score: fallbackScore,
          passed: false,
          reason: responseText?.slice(0, 200) ?? "No response",
          costs,
        });
      }

      if (
        typeof parsed.score !== "number" ||
        typeof parsed.passed !== "boolean" ||
        typeof parsed.reason !== "string"
      ) {
        const fallbackScore = responseText?.includes("LGTM") ? 0.8 : 0.3;
        logger.warn("LLM response validation failed, using fallback", { fallbackScore });
        return ok({
          score: fallbackScore,
          passed: false,
          reason: responseText?.slice(0, 200) ?? "No response",
          costs,
        });
      }

      const score = Math.min(1, Math.max(0, parsed.score));
      const passed = score >= threshold;
      const issues =
        Array.isArray(parsed.issues) && parsed.issues.every((i) => typeof i === "string")
          ? (parsed.issues as string[])
          : undefined;

      logger.info("LLM evaluation complete", { score, passed });

      return ok({
        score,
        passed,
        reason: parsed.reason,
        ...(issues !== undefined ? { issues } : {}),
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
    }
  }
}
