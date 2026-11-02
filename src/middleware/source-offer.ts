import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { LICENSE_URL, STRATUM_SOURCE_URL } from "../ui/components/source-footer";

/**
 * The AGPL-3.0 §13 source offer for callers who never receive an HTML page.
 *
 * The page footer covers browsers. It does not cover the REST API, the `/mcp`
 * endpoint, or anything else that answers with JSON — and §13 reaches "all
 * users interacting with [the Program] remotely through a computer network",
 * not only the ones looking at markup. An agent driving Stratum entirely over
 * `/mcp` is such a user, and before this middleware it was offered nothing.
 *
 * Headers, because they are the only channel every response shares:
 *
 * - `Link: <…>; rel="license"` is the registered relation for this (RFC 8288 /
 *   RFC 4946), and points at the license text.
 * - `X-Source-Code` carries where to obtain the Corresponding Source. There is
 *   no registered relation that means "the source of the running program", and
 *   inventing a `rel` would be less legible than a header that says what it is.
 *   Several AGPL services use this same name.
 *
 * A self-hoster running modifications repoints `STRATUM_SOURCE_URL` and both
 * this and the footer follow; there is nothing separate to configure.
 *
 * Git smart-HTTP responses are skipped for the same reason
 * `securityHeadersMiddleware` skips them: git clients and proxies get exactly
 * the bytes they expect, and a `git clone` is already receiving the source.
 */
const isGitHttpPath = (path: string): boolean =>
  path.endsWith("/info/refs") ||
  path.endsWith("/git-upload-pack") ||
  path.endsWith("/git-receive-pack");

const LINK_HEADER = `<${LICENSE_URL}>; rel="license"`;

export const sourceOfferMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (isGitHttpPath(c.req.path)) {
    await next();
    return;
  }

  // Twice, because neither placement alone covers every response.
  //
  // Before next(): `c.header()` buffers onto the context, which is what
  // `c.json()`/`c.text()`/`c.html()` build their response from, and it survives
  // a downstream throw that unwinds past this middleware entirely.
  c.header("Link", LINK_HEADER);
  c.header("X-Source-Code", STRATUM_SOURCE_URL);

  try {
    await next();
  } finally {
    // After next(): a handler returning a raw `new Response(...)` replaces the
    // context response wholesale, and Hono does not merge the buffered headers
    // into it — verified against this repo's Hono, not assumed. `/mcp` returns
    // raw 202s and 204s on its main paths (`src/routes/mcp.ts`), so without
    // this the one interface the offer most needed to reach would not have
    // carried it. In `finally` so an error response is covered too; mutating
    // `c.res.headers` here does not mask or alter the error itself.
    c.res.headers.set("Link", LINK_HEADER);
    c.res.headers.set("X-Source-Code", STRATUM_SOURCE_URL);
  }
};
