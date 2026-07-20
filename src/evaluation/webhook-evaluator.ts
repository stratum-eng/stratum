import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import { validateWebhookUrl } from "../utils/validation";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

async function computeHmacSha256(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class WebhookEvaluator implements Evaluator {
  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting webhook evaluation");

    const config = policy.evaluators.find((e) => e.type === "webhook");
    if (!config || config.type !== "webhook") {
      logger.warn("No webhook configuration found");
      return ok({ score: 0, passed: false, reason: "Webhook: no configuration found." });
    }

    // The URL comes from the repo's own policy file, so it must pass the same
    // private-host / SSRF filter as delivery webhooks. Fail the evaluation
    // closed (score 0, not passed) rather than fetch an internal address.
    const urlCheck = validateWebhookUrl(config.url, logger);
    if (!urlCheck.success) {
      logger.warn("Webhook evaluator URL rejected", { url: config.url });
      return ok({
        score: 0,
        passed: false,
        reason: `Webhook: URL not allowed (${urlCheck.error[0]?.message ?? "invalid URL"}).`,
      });
    }

    const timeoutMs = config.timeoutMs ?? 10000;
    const body = JSON.stringify({ diff, policy });
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (config.secret) {
      const hex = await computeHmacSha256(config.secret, body);
      headers["X-Stratum-Signature"] = `sha256=${hex}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      logger.debug("Sending webhook request", { url: config.url, timeoutMs });

      const response = await fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        // Never follow a redirect to a (possibly internal) address; a 3xx here
        // is treated as a failed evaluation below via !response.ok.
        redirect: "manual",
      });

      if (!response.ok) {
        logger.error("Webhook evaluation failed", new Error(`HTTP ${response.status}`));
        return ok({ score: 0, passed: false, reason: `Webhook failed: HTTP ${response.status}` });
      }

      const json = (await response.json()) as { score: number; passed: boolean; reason: string };
      logger.info("Webhook evaluation complete", { score: json.score, passed: json.passed });
      return ok({ score: json.score, passed: json.passed, reason: json.reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        "Webhook evaluation failed",
        error instanceof Error ? error : new Error(message),
      );
      return err(
        new ExternalServiceError(
          "Webhook",
          message,
          error instanceof Error ? error : undefined,
        ) as AppError,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
