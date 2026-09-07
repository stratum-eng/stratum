import type { AiBinding } from "../types";
import { AppError, ExternalServiceError } from "../utils/errors";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";

/**
 * One turn of the conversation handed to a provider. Structurally identical to
 * the shape `AiBinding.run` already takes, so `WorkersAiProvider` forwards it
 * unchanged.
 */
export interface Message {
  role: string;
  content: string;
}

/** Token counts a provider actually reported. Never an estimate — see `LlmResponse.usage`. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  /** The assistant's text. Empty string when the provider returned a well-formed
   * response carrying no text, which the evaluator then fails closed on. */
  text: string;
  /**
   * Present only when the provider reported real token counts. Its absence is
   * load-bearing: the evaluator falls back to the `~4 chars/token` estimate and
   * marks the cost sample `estimated`. That distinction is **per response, not
   * per source**: every provider here reports counts when it has them (Workers
   * AI included), and any response that omits `usage` — or reports one this
   * file will not trust, see `usageOrNothing` — is estimated.
   */
  usage?: LlmUsage;
}

/**
 * The seam between the LLM evaluator and whoever actually runs the model.
 *
 * Errors are values: a provider never throws across this boundary. Two error
 * shapes are distinguished, because they mean different things to the gate:
 * `LlmProviderResponseError` for a response that arrived but cannot be used
 * (which fails the evaluation closed with a readable reason), and any other
 * `AppError` for a transport failure.
 */
export interface LlmProvider {
  run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>>;
}

/**
 * The provider answered, but the answer is unusable — a non-2xx status, a body
 * that is not JSON, a JSON body of the wrong shape, a verdict truncated at the
 * token cap, or a stream where a completion was expected.
 *
 * **The message is metadata only.** It reaches the user: `LLMEvaluator`
 * intercepts every error of this class and interpolates the message into the
 * `EvalResult.reason` it fails the gate closed with. A provider's error body
 * can quote the request — which contains the diff — and some providers echo the
 * credential that failed, so nothing the provider sent is ever interpolated
 * into it: these messages carry an HTTP status, a fixed description of the
 * shape problem, or a constant this file chose, and nothing else.
 */
export class LlmProviderResponseError extends AppError {
  /**
   * Token counts the provider reported for a response that cannot be used.
   *
   * Present only where the provider *billed* the call anyway — a verdict
   * truncated at the token cap is a completed, charged generation. The
   * evaluator records it as a cost sample, so a run the provider charged for is
   * not recorded as zero. Absent for every failure that produced no tokens (a
   * non-2xx status, an unreadable body), which must not be billed.
   */
  readonly usage?: LlmUsage;

  constructor(message: string, cause?: unknown, usage?: LlmUsage) {
    super(message, "LLM_PROVIDER_RESPONSE", 502);
    this.name = "LlmProviderResponseError";
    // Attached rather than described: a `SyntaxError` from `JSON.parse` quotes
    // the bytes that failed, which are the provider's body — exactly what the
    // message must not carry. Dropping it entirely would swallow the only
    // record of what went wrong, and `LLMEvaluator` logs it (operator-visible)
    // without ever putting it in the user-visible reason.
    if (cause !== undefined) this.cause = cause;
    if (usage !== undefined) this.usage = usage;
  }
}

function transportError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return new ExternalServiceError(
    "LLM",
    message,
    error instanceof Error ? error : undefined,
  ) as AppError;
}

/** How long any provider gets before the gate gives up on it. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The two constant messages the request path can fail with. Constants rather
 * than interpolations because both are reached with attacker-influenced values
 * in hand — a redirect `Location`, or a header value that could not be built —
 * and every message from this file becomes a user-visible evaluation reason.
 */
const REDIRECT_REFUSED = "provider redirected the request, which is not followed";
const HEADER_CONSTRUCTION_FAILED = "provider request headers could not be constructed";

export interface ProviderOptions {
  /** Give up on the request after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * Bound a call that cannot be cancelled.
 *
 * `AiBinding.run` takes no `AbortSignal`, so unlike the HTTP providers there is
 * nothing here to abort: the inference keeps running (and is still billed)
 * after this rejects. What it bounds is how long the *gate* waits, which is the
 * failure that matters — a binding that never settles otherwise holds the
 * evaluation open for as long as the Worker's own limits allow.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not respond within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * The Workers AI binding, and the default. Behaviour here is deliberately
 * identical to what `LLMEvaluator` did inline before the seam existed:
 * a `ReadableStream` is rejected rather than consumed, and a response object
 * with no usable `response` field yields `""` so the evaluator fails it closed
 * as unparseable output rather than treating it as a distinct condition.
 *
 * It does report token counts — Cloudflare documents the synchronous output of
 * a text-generation model as `response`, `tool_calls` and `usage`, and its own
 * generated types name the counts `usage.prompt_tokens` /
 * `usage.completion_tokens` (`AiTextGenerationOutput` in
 * `@cloudflare/workers-types`). They go through the same `usageOrNothing`
 * validation as the HTTP providers, so this path falls back to the
 * `~4 chars/token` estimate only when a response actually omits them.
 */
export class WorkersAiProvider implements LlmProvider {
  constructor(
    private ai: AiBinding,
    private options: ProviderOptions = {},
  ) {}

  async run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>> {
    let raw: Awaited<ReturnType<AiBinding["run"]>>;
    try {
      raw = await withTimeout(
        this.ai.run(model, { messages }),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        "Workers AI",
      );
    } catch (error) {
      return err(transportError(error));
    }

    if (raw instanceof ReadableStream) {
      return err(new LlmProviderResponseError("unexpected stream response"));
    }

    // Checked, not asserted: the binding's own types make `response` optional,
    // and the evaluator dereferences `.length` on whatever comes back.
    const text = typeof raw.response === "string" ? raw.response : "";
    return ok({
      text,
      ...usageOrNothing(raw.usage?.prompt_tokens, raw.usage?.completion_tokens),
    });
  }
}

/**
 * Credentials and endpoints for both HTTP providers are **constructor
 * arguments supplied by the caller** — never read from `env` here, and never
 * taken from `.stratum/policy.yaml`.
 *
 * The omission is deliberate, not a gap. A base URL a repository's own policy
 * file can choose turns this Worker into a request-forgery primitive aimed at
 * whatever host the policy names, and the prompt it would receive contains the
 * diff (PRD §7). Resolving a provider name against an operator-configured
 * allowlist is Task 7's job; these classes only take what they are handed.
 */
abstract class HttpLlmProvider implements LlmProvider {
  constructor(
    protected readonly baseUrl: string,
    protected readonly apiKey: string,
    protected readonly options: ProviderOptions = {},
  ) {}

  abstract run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>>;

  /**
   * POST a JSON body and parse a JSON response, converting every failure into
   * a `Result`. Returns the decoded body as `unknown`: each provider validates
   * its own shape, because a body that parsed is not a body that can be read.
   */
  protected async post(path: string, headers: Record<string, string>, body: unknown) {
    // Built HERE, outside the try, and never from inside it. `new Headers` throws
    // a `TypeError` whose message QUOTES the offending value, and the value here
    // is the project's API key: inside the try that message would become a
    // transport error, then an `ExternalServiceError`, then `EvalResult.reason`,
    // which is persisted on the change and rendered on a page that is
    // world-readable for a public project. The store rejects control characters
    // in a secret value (`storage/project-secrets.ts`) so this should be
    // unreachable; it is the second of the two ends, and it maps to a constant
    // that interpolates nothing.
    let requestHeaders: Headers;
    try {
      requestHeaders = new Headers({ "content-type": "application/json", ...headers });
    } catch {
      return err(new LlmProviderResponseError(HEADER_CONSTRUCTION_FAILED) as AppError);
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
        // Never follow a redirect: the allowlist binds the host this request was
        // *sent* to, and a followed 3xx would re-send the prompt (the diff and
        // the policy) to a host nobody validated — with `x-api-key` still
        // attached, since the Fetch spec strips only `Authorization`
        // cross-origin. The sibling `webhook-evaluator.ts` does the same.
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        return err(new LlmProviderResponseError(REDIRECT_REFUSED) as AppError);
      }

      if (!response.ok) {
        // The status, never the body: an error body can echo the API key that
        // failed, and this message becomes a user-visible evaluation reason.
        return err(
          new LlmProviderResponseError(`provider returned HTTP ${response.status}`) as AppError,
        );
      }

      // Read the bytes first, parse them second. `response.json()` rejects both
      // when the transfer drops mid-body and when a body that arrived whole is
      // not JSON, and those mean opposite things to the gate: the first is a
      // transport failure the caller surfaces (it falls to the outer catch),
      // the second fails the evaluation closed with a user-visible reason.
      const raw = await response.text();
      try {
        return ok(JSON.parse(raw) as unknown);
      } catch (error) {
        return err(
          new LlmProviderResponseError("provider response was not valid JSON", error) as AppError,
        );
      }
    } catch (error) {
      return err(transportError(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The output budget for one verdict, shared by both HTTP providers so the gate
 * is bounded by the same number whichever one runs it. The evaluator asks for a
 * single small JSON object; a response that needs more than this has stopped
 * answering the question it was asked.
 */
const VERDICT_TOKEN_BUDGET = 1024;

/**
 * Anthropic's Messages API: `POST {baseUrl}/messages`, `x-api-key` plus the
 * required `anthropic-version` header, assistant text in `content[]` blocks of
 * type `text`, real token counts in `usage.input_tokens` / `usage.output_tokens`.
 *
 * Docs: https://platform.claude.com/docs/en/api/messages/create and
 * https://platform.claude.com/docs/en/api/overview (headers table).
 */
export class AnthropicProvider extends HttpLlmProvider {
  /** Pinned rather than configurable: the API is versioned by this header, and
   * a value the caller could vary is a shape this code has not been written for. */
  static readonly API_VERSION = "2023-06-01";
  /** The evaluator asks for one small JSON verdict; `max_tokens` is required. */
  static readonly MAX_TOKENS = VERDICT_TOKEN_BUDGET;

  async run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>> {
    // Anthropic takes the system prompt as a top-level parameter, not as a
    // message with role "system" — a system-role message is rejected.
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages.filter((m) => m.role !== "system");

    const posted = await this.post(
      "/messages",
      {
        "x-api-key": this.apiKey,
        "anthropic-version": AnthropicProvider.API_VERSION,
      },
      {
        model,
        max_tokens: AnthropicProvider.MAX_TOKENS,
        ...(system.length > 0 ? { system } : {}),
        messages: turns,
      },
    );
    if (!posted.success) return posted;

    const body = posted.data as {
      content?: unknown;
      stop_reason?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    } | null;

    if (body === null || typeof body !== "object" || !Array.isArray(body.content)) {
      return err(
        new LlmProviderResponseError("provider response had no content array") as AppError,
      );
    }

    // A verdict cut off at our own cap is well-formed JSON containing half a
    // JSON object, so without this the evaluator fails closed blaming the
    // model's formatting for a limit this file chose. Anthropic says so
    // explicitly: `stop_reason` is `"max_tokens"` in exactly that case.
    if (body.stop_reason === "max_tokens") {
      // With the counts: the generation ran to the cap and the provider billed
      // it, so an unusable verdict here still costs real tokens.
      return err(
        new LlmProviderResponseError(
          `provider response was truncated at the ${AnthropicProvider.MAX_TOKENS}-token limit`,
          undefined,
          usageOrNothing(body.usage?.input_tokens, body.usage?.output_tokens).usage,
        ) as AppError,
      );
    }

    const text = body.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("");

    return ok({ text, ...usageOrNothing(body.usage?.input_tokens, body.usage?.output_tokens) });
  }
}

/**
 * The OpenAI Chat Completions shape, which OpenAI, OpenRouter, Groq, Together
 * and a self-hosted vLLM server all speak: `POST {baseUrl}/chat/completions`
 * with `Authorization: Bearer`, assistant text at `choices[0].message.content`,
 * token counts at `usage.prompt_tokens` / `usage.completion_tokens`.
 *
 * Docs: https://developers.openai.com/api/reference/chat-completions/overview,
 * https://openrouter.ai/docs/api-reference/chat-completion,
 * https://console.groq.com/docs/api-reference,
 * https://docs.vllm.ai/en/latest/serving/openai_compatible_server/.
 */
export class OpenAiCompatibleProvider extends HttpLlmProvider {
  /** The same budget the Anthropic sibling sends; see `VERDICT_TOKEN_BUDGET`. */
  static readonly MAX_COMPLETION_TOKENS = VERDICT_TOKEN_BUDGET;

  async run(model: string, messages: Message[]): Promise<Result<LlmResponse, AppError>> {
    // `max_completion_tokens`, never `max_tokens`: OpenAI documents `max_tokens`
    // as deprecated in its favour and "not compatible with o-series models",
    // Groq documents the same deprecation, and OpenRouter and vLLM take either.
    // Together AI documents only `max_tokens` and its schema does not forbid
    // extra fields, so there the bound is still the timeout — an unenforced
    // field on one vendor beats a 400 on the ones that reject `max_tokens`.
    const posted = await this.post(
      "/chat/completions",
      { authorization: `Bearer ${this.apiKey}` },
      {
        model,
        messages,
        max_completion_tokens: OpenAiCompatibleProvider.MAX_COMPLETION_TOKENS,
      },
    );
    if (!posted.success) return posted;

    const body = posted.data as {
      choices?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    } | null;

    if (body === null || typeof body !== "object" || !Array.isArray(body.choices)) {
      return err(
        new LlmProviderResponseError("provider response had no choices array") as AppError,
      );
    }

    const choice = body.choices[0] as
      | { message?: { content?: unknown }; finish_reason?: unknown }
      | undefined;

    // The same truncation the Anthropic path reports, under this shape's name
    // for it: `finish_reason: "length"` means the cap above ended the verdict,
    // not the model, and the half-object left behind must not be reported as
    // the model's own formatting failure.
    if (choice?.finish_reason === "length") {
      // Billed, like the Anthropic sibling — see the note there.
      return err(
        new LlmProviderResponseError(
          `provider response was truncated at the ${OpenAiCompatibleProvider.MAX_COMPLETION_TOKENS}-token limit`,
          undefined,
          usageOrNothing(body.usage?.prompt_tokens, body.usage?.completion_tokens).usage,
        ) as AppError,
      );
    }

    const content = choice?.message?.content;
    if (typeof content !== "string") {
      return err(
        new LlmProviderResponseError("provider response had no assistant message text") as AppError,
      );
    }

    return ok({
      text: content,
      ...usageOrNothing(body.usage?.prompt_tokens, body.usage?.completion_tokens),
    });
  }
}

/**
 * A count that could actually be a number of tokens: a non-negative integer.
 *
 * `Number.isInteger` already excludes `NaN` and both infinities, so the whole
 * test is integrality plus sign. Both halves matter downstream — a negative
 * quantity becomes a ledger row for negative spend, and a fractional one a
 * fractional token — and neither is a count any provider can legitimately
 * report, so a value failing this is a malformed `usage`, not a small error.
 */
function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Report usage only when both counts are usable. A partial or malformed
 * `usage` object is treated as absent rather than half-trusted: a wrong token
 * count recorded as exact is worse than an estimate labelled as one — the
 * estimate at least carries `estimated: true` into `cost_records`.
 */
function usageOrNothing(input: unknown, output: unknown): { usage?: LlmUsage } {
  if (!isTokenCount(input) || !isTokenCount(output)) return {};
  return { usage: { inputTokens: input, outputTokens: output } };
}
