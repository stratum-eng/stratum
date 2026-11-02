import { type Logger, defaultLogger } from "./logger";
import { payloadTooLarge } from "./response";

/** Minimal shape needed from a Hono context to read + cap a request body. */
interface BodyLimitedContext {
  req: {
    raw: Request;
    header(name: string): string | undefined;
  };
}

/**
 * Reads a JSON request body while enforcing a byte ceiling *during* the read
 * (mirrors `readCappedBody` in `src/routes/git-http.ts`), so an oversized
 * payload is aborted before it is ever fully buffered — a `Content-Length`
 * that lies (or is simply absent, e.g. chunked transfer-encoding) cannot get
 * past the cap. A declared `Content-Length` over the ceiling is still used as
 * a cheap early reject before touching the stream at all.
 *
 * Returns the parsed body on success, or a `413` Response (the repo's
 * standard `{ error, code }` shape) ready to return directly from the route
 * handler:
 *
 * ```ts
 * const body = await readJsonWithLimit<{ files?: unknown }>(c, MAX_BYTES);
 * if (body instanceof Response) return body;
 * ```
 *
 * Malformed JSON within the cap still throws, exactly like `c.req.json()`
 * would — callers that already wrap the call in `.catch(() => ({}))` keep
 * that fallback behavior unchanged.
 */
export async function readJsonWithLimit<T>(
  c: BodyLimitedContext,
  maxBytes: number,
  logger?: Logger,
): Promise<T | Response> {
  const read = await readTextWithLimit(c, maxBytes, logger);
  if (read.tooLarge) {
    return payloadTooLarge(`request body too large (max ${maxBytes} bytes)`);
  }
  // An empty body raises the same "Unexpected end of JSON input" that
  // `c.req.json()` would, which callers already wrap where they tolerate it.
  return JSON.parse(read.text) as T;
}

/**
 * The capped read itself, returning the raw text.
 *
 * Split out of `readJsonWithLimit` so a caller that must answer an oversized
 * body in its OWN error shape can still get the enforcement — the MCP endpoint
 * has to reply with a JSON-RPC error object, which an MCP client parses, rather
 * than with this repo's `{ error, code }`, which it cannot. Both callers share
 * one implementation of the cap so there is only ever one thing to get right.
 */
export async function readTextWithLimit(
  c: BodyLimitedContext,
  maxBytes: number,
  logger?: Logger,
): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
  const log = logger ?? defaultLogger;

  // Cheap early reject when the client declares a length outright — saves
  // spinning up the reader for an obviously oversized request. This is a
  // fast path only: an absent or understated Content-Length falls through to
  // the streaming cap below, which is the actual enforcement.
  const declaredLength = c.req.header("content-length");
  if (declaredLength !== undefined) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      log.warn("request body exceeds cap (Content-Length)", { cap: maxBytes, declared });
      return { tooLarge: true };
    }
  }

  const stream = c.req.raw.body;
  if (!stream) return { tooLarge: false, text: "" };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      log.warn("request body exceeds cap", { cap: maxBytes });
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { tooLarge: false, text: new TextDecoder().decode(buffer) };
}
