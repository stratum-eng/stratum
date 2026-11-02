/**
 * The remote MCP endpoint (#349).
 *
 * Streamable HTTP, stateless. A client POSTs a JSON-RPC message and gets one
 * back; there is no session to establish, resume or expire, and no
 * `Mcp-Session-Id` to track. That is a real design choice rather than a
 * shortcut: the tools are all request/response calls into the REST API, none of
 * them streams or reports progress, and nothing a client does in one call
 * changes what the next one sees. Statelessness is what lets any Worker isolate
 * answer any request, which in turn is what makes this endpoint free to run at
 * every edge location instead of pinned to a Durable Object.
 *
 * If a future tool needs server-initiated messages — long-running evaluations
 * pushing progress, say — this is where an SSE stream and a session id would
 * be added, and the `GET` handler below is where the spec expects them.
 */
import { Hono } from "hono";
import type { AnalyticsTracker } from "../analytics/tracker";
import { trackerForRequest } from "../analytics/tracker";
import { StratumClient } from "../mcp/client";
import { dispatchApiRequest } from "../mcp/dispatch";
import { describeMcpAnalytics, describeMcpOutcome } from "../mcp/outcome";
import {
  JSON_RPC,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleMessage,
  rpcError,
} from "../mcp/protocol";
import { buildTools } from "../mcp/tools";
import type { Env } from "../types";
import { getExecutionCtx } from "../utils/execution-ctx";
import type { Logger } from "../utils/logger";
import { buildAuthenticateChallenge } from "../utils/oauth-challenge";
import { readTextWithLimit } from "../utils/request-body";
import { requestLogger } from "../utils/request-logger";
import { STRATUM_VERSION } from "../version";

const app = new Hono<{ Bindings: Env }>();

/**
 * One log line and one analytics event per exchange.
 *
 * Both are derived here rather than at the two call sites below (single
 * message, and each message of a batch) so a batched call is counted exactly
 * like an unbatched one. `describeMcpAnalytics` returns null for exchanges
 * that ran nothing, which are logged but not counted.
 */
function recordOutcome(
  logger: Logger,
  tracker: AnalyticsTracker,
  knownTools: ReadonlySet<string>,
  message: unknown,
  reply: Awaited<ReturnType<typeof handleMessage>>,
): void {
  const outcome = describeMcpOutcome(message, reply);
  logger[outcome.level](outcome.message, outcome.meta);

  const analytics = describeMcpAnalytics(message, reply, knownTools);
  if (analytics !== null) tracker.capture("mcp_request", analytics);
}

/**
 * Reported in the `initialize` handshake.
 *
 * Re-exported from `src/version.ts`, which is also what stamps `$lib_version`
 * on every analytics event — one constant, so the version a client is told and
 * the version a metric is attributed to cannot disagree.
 */
export const SERVER_VERSION = STRATUM_VERSION;

/**
 * Cap on a single JSON-RPC body.
 *
 * Deliberately well below the 32 MB the REST commit route accepts, because a
 * body arriving HERE is paid for several times over: the streaming read holds
 * its chunks and then a joined buffer, decodes that to a string, `JSON.parse`
 * builds the object graph, and `StratumClient` re-serializes the tool's
 * arguments into a sub-request that `readJsonWithLimit` buffers and parses
 * again. A near-32 MB body would therefore cost well over 100 MB of live
 * allocation, and a Workers isolate has 128 MB TOTAL — shared across every
 * concurrent request it is serving. Two such calls at once is an Error 1102 for
 * everyone on that isolate, not just for the sender.
 *
 * 8 MiB keeps the multiplied footprint comfortably inside the budget while
 * leaving room for any commit an agent should be making through a tool call.
 * Larger commits are not blocked, they just take the path they always should:
 * the workspace's git remote, or the REST API directly. The tool description
 * and the MCP guide both say so.
 *
 * Enforced with `readTextWithLimit` rather than `readJsonWithLimit` because
 * both failures on this endpoint — too large, and unparseable — have to come
 * back as JSON-RPC error objects, which an MCP client understands, rather than
 * as this codebase's `{error, code}`, which it does not. The cap itself is the
 * shared streaming one, so an absent or understated `Content-Length` cannot get
 * past it.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Answer an unauthenticated request with the challenge that starts the OAuth
 * flow. This 401 is the entire bootstrap: a client that has never seen this
 * instance discovers the authorization server from the header and registers
 * itself, with nothing configured in advance. */
function unauthenticated(url: string, description: string): Response {
  return Response.json(
    // Shaped as a JSON-RPC error as well as an HTTP 401, so a client that
    // routes the body to its RPC layer before checking the status still gets
    // something it can report rather than a parse failure.
    rpcError(null, JSON_RPC.INVALID_REQUEST, description),
    {
      status: 401,
      headers: {
        "WWW-Authenticate": buildAuthenticateChallenge(url, "invalid_token", description),
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Reject a protocol version we do not speak.
 *
 * The header is optional — clients that negotiated during `initialize` may omit
 * it — so only an explicitly WRONG value is refused. Treating an absent header
 * as a violation would break every client that follows the older revision,
 * where the header does not exist at all.
 */
function unsupportedProtocol(header: string | undefined): Response | null {
  if (header === undefined) return null;
  if (SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === header)) return null;
  return Response.json(
    rpcError(
      null,
      JSON_RPC.INVALID_REQUEST,
      `Unsupported MCP protocol version '${header}'. This server speaks: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
    ),
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

app.post("/mcp", async (c) => {
  const logger = requestLogger(c, {
    userId: c.get("userId"),
    agentId: c.get("agentId"),
    oauthClientId: c.get("oauthClientId"),
  });

  // `authMiddleware` has already resolved (or rejected) the credential. What is
  // left is the authorization question: MCP has no anonymous mode, so a request
  // that arrived with no credential at all is answered with the challenge that
  // bootstraps OAuth rather than with a bare 401.
  const authorization = c.req.header("Authorization");
  if (authorization === undefined) {
    return unauthenticated(c.req.url, "Authentication required to use the Stratum MCP server");
  }
  const userId = c.get("userId");
  const agentId = c.get("agentId");
  if (userId === undefined && agentId === undefined) {
    return unauthenticated(c.req.url, "The presented credential is not valid");
  }

  const versionProblem = unsupportedProtocol(c.req.header("Mcp-Protocol-Version"));
  if (versionProblem !== null) return versionProblem;

  const body = await readTextWithLimit(c, MAX_BODY_BYTES, logger);
  if (body.tooLarge) {
    return Response.json(
      rpcError(
        null,
        JSON_RPC.INVALID_REQUEST,
        `Request body too large (max ${MAX_BODY_BYTES} bytes)`,
      ),
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return Response.json(rpcError(null, JSON_RPC.PARSE_ERROR, "Request body is not valid JSON"), {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // The credential is replayed verbatim rather than re-minted, so every tool
  // call is authorized as the caller by the real middleware. See dispatch.ts.
  const client = new StratumClient(new URL(c.req.url).origin, authorization, (request) =>
    dispatchApiRequest(request, c.env, getExecutionCtx(c)),
  );
  const ctx = { tools: buildTools(client), serverVersion: SERVER_VERSION };
  // The tool names this build actually defines, so an unrecognised name in a
  // client's request is never echoed into the export. Derived from `ctx.tools`
  // rather than from a second list, which would drift.
  const knownTools = new Set(ctx.tools.map((t) => t.name));
  // `api_request` already counts this POST; `mcp_request` is what makes the
  // traffic legible — one HTTP request can carry a batch, and "which tool, for
  // which client, with what outcome" is not recoverable from a route pattern.
  const tracker = trackerForRequest(c);

  // A batch is a JSON array. Dropped from the 2025-06-18 revision but still
  // sent by clients on the two older ones we accept, so it is handled rather
  // than refused. Notifications contribute no reply, and a batch of only
  // notifications correctly produces an empty 202 instead of `[]`.
  if (Array.isArray(parsed)) {
    // Unless the client declared 2025-06-18, where batching does not exist. The
    // header is the client's own statement about which revision it speaks, so a
    // batch under it is that client contradicting itself — and answering anyway
    // would leave it believing this server supports something the revision
    // removed. An ABSENT header stays permissive: it says nothing, and the two
    // older revisions do batch.
    if (c.req.header("Mcp-Protocol-Version") === LATEST_PROTOCOL_VERSION) {
      return Response.json(
        rpcError(
          null,
          JSON_RPC.INVALID_REQUEST,
          `JSON-RPC batching was removed in ${LATEST_PROTOCOL_VERSION}. Send one message per request, or declare an older revision.`,
        ),
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (parsed.length === 0) {
      return Response.json(rpcError(null, JSON_RPC.INVALID_REQUEST, "Empty batch"), {
        status: 400,
      });
    }
    // Sequential, not `Promise.all`: these calls hit D1 and the git layer, and
    // a model that batches twenty commits should not get twenty concurrent
    // writers racing inside one isolate.
    const replies = [];
    for (const message of parsed) {
      const reply = await handleMessage(message, ctx);
      recordOutcome(logger, tracker, knownTools, message, reply);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) return new Response(null, { status: 202 });
    return Response.json(replies, { headers: { "Cache-Control": "no-store" } });
  }

  const reply = await handleMessage(parsed, ctx);
  recordOutcome(logger, tracker, knownTools, parsed, reply);
  // A notification gets no body. 202 Accepted is what the spec prescribes, and
  // it is distinguishable from a 200 with an empty body, which some clients
  // treat as a truncated response.
  if (reply === null) return new Response(null, { status: 202 });

  return Response.json(reply, {
    headers: {
      "Cache-Control": "no-store",
      "Mcp-Protocol-Version": c.req.header("Mcp-Protocol-Version") ?? LATEST_PROTOCOL_VERSION,
    },
  });
});

/**
 * The spec's server-to-client stream. This server never initiates a message, so
 * there is nothing to stream; 405 is the prescribed answer and clients treat it
 * as "no server-initiated messages here" rather than as a failure.
 *
 * Answered before the auth check on purpose: the response is identical for
 * every caller, so requiring a credential to learn it would only make clients
 * run the OAuth flow to be told the same thing.
 */
app.get("/mcp", () =>
  Response.json(
    rpcError(
      null,
      JSON_RPC.METHOD_NOT_FOUND,
      "This server does not offer a server-initiated stream",
    ),
    { status: 405, headers: { Allow: "POST, DELETE" } },
  ),
);

/** Session teardown. There is no session to tear down, so this succeeds
 * unconditionally — a client that tidies up on exit should not see an error for
 * doing the right thing. */
app.delete("/mcp", () => new Response(null, { status: 204 }));

export { app as mcpRouter };
