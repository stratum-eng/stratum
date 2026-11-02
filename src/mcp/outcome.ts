/**
 * What to log about one MCP exchange (#355).
 *
 * The endpoint used to log a single debug line per message, which the default
 * info level suppressed, so a connector that connected and then failed every
 * tool call left no trace beyond auth-middleware warnings. This turns each
 * (message, reply) pair into a log entry at the level it deserves: the
 * handshake at info, because "Claude connected, speaking protocol X" is the
 * first thing an operator wants to see; a tool that ran and failed at warn,
 * with the tool name and the error the model was shown; everything routine at
 * debug.
 *
 * Kept as a pure function, separate from the transport-agnostic protocol
 * layer, so it is testable by handing it plain objects.
 */
import type { SurfaceEventProperties } from "../analytics/events";
import { type JsonRpcResponse, isJsonRpcRequest } from "./protocol";

export interface McpOutcome {
  level: "debug" | "info" | "warn";
  message: string;
  meta: Record<string, unknown>;
}

/** A non-empty string, or nothing; the client's self-description is untyped. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The first text block of a tool result, truncated. Tool failures put the
 * API's error message there, which is what an operator needs to see. */
function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block !== null && typeof block === "object") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") return text.slice(0, 200);
    }
  }
  return undefined;
}

/**
 * Classify one exchange for logging. `reply` is what `handleMessage` returned:
 * a response, or `null` for a notification.
 */
export function describeMcpOutcome(message: unknown, reply: JsonRpcResponse | null): McpOutcome {
  if (!isJsonRpcRequest(message)) {
    return { level: "warn", message: "MCP message rejected", meta: { reason: "not JSON-RPC" } };
  }
  const method = message.method;

  // A notification gets no reply and, for the request-style methods below,
  // runs nothing: `handleMessage` returns null for a `tools/call` with no id
  // without invoking the tool. Classifying by method first would log a tool
  // that never ran as a success, so notifications are settled before any
  // method-specific branch.
  if (reply === null) {
    return { level: "debug", message: "MCP notification handled", meta: { method } };
  }

  if (method === "initialize") {
    const params = (message.params ?? {}) as {
      protocolVersion?: unknown;
      clientInfo?: { name?: unknown; version?: unknown };
    };
    const result = reply.result as { protocolVersion?: unknown } | undefined;
    return {
      level: "info",
      message: "MCP client initialized",
      meta: {
        clientName: asString(params.clientInfo?.name),
        clientVersion: asString(params.clientInfo?.version),
        requestedProtocolVersion: asString(params.protocolVersion),
        protocolVersion: asString(result?.protocolVersion),
      },
    };
  }

  if (method === "tools/call") {
    const tool = asString((message.params as { name?: unknown } | undefined)?.name);
    if (reply.error !== undefined) {
      return {
        level: "warn",
        message: "MCP tool call rejected",
        meta: { tool, code: reply.error.code, error: reply.error.message },
      };
    }
    const result = reply.result as { isError?: unknown; content?: unknown } | undefined;
    if (result?.isError === true) {
      return {
        level: "warn",
        message: "MCP tool call failed",
        meta: { tool, detail: firstText(result.content) },
      };
    }
    return { level: "debug", message: "MCP tool call succeeded", meta: { tool } };
  }

  if (reply.error !== undefined) {
    return {
      level: "warn",
      message: "MCP request rejected",
      meta: { method, code: reply.error.code, error: reply.error.message },
    };
  }
  return { level: "debug", message: "MCP message handled", meta: { method } };
}

/**
 * What to *export* about one MCP exchange, as opposed to what to log.
 *
 * Separate from `describeMcpOutcome` because the two answer different
 * questions with different rules. A log line stays on the operator's own
 * instance and may quote the error a model was shown; an analytics event
 * leaves for a third party and may carry only bounded values. The overlap is
 * real but the constraint is not shared, so merging them would mean one
 * function whose output is safe for exactly one of its two consumers.
 *
 * Returns `null` for anything that did not run: a malformed message, and a
 * notification (which `handleMessage` answers with no reply, without invoking
 * the tool). Counting those as tool calls would overstate MCP usage with
 * traffic that never reached a tool.
 */
export function describeMcpAnalytics(
  message: unknown,
  reply: JsonRpcResponse | null,
  knownTools: ReadonlySet<string>,
): SurfaceEventProperties["mcp_request"] | null {
  if (!isJsonRpcRequest(message) || reply === null) return null;

  const props: SurfaceEventProperties["mcp_request"] = {
    mcp_method: boundedMethod(message.method),
    outcome: "ok",
  };

  if (message.method === "initialize") {
    const params = (message.params ?? {}) as {
      protocolVersion?: unknown;
      clientInfo?: { name?: unknown; version?: unknown };
    };
    // Self-reported by the connecting software, so it is capped rather than
    // trusted: "which editors and agents connect to Stratum" is the question
    // the handshake answers, and a client that names itself at length is not
    // going to make it more answerable. Documented in the public FAQ as the
    // one free-text field any event carries.
    const name = clientLabel(params.clientInfo?.name);
    const version = clientLabel(params.clientInfo?.version);
    const protocol = clientLabel(
      (reply.result as { protocolVersion?: unknown } | undefined)?.protocolVersion,
    );
    if (name !== undefined) props.client_name = name;
    if (version !== undefined) props.client_version = version;
    if (protocol !== undefined) props.protocol_version = protocol;
  }

  if (message.method === "tools/call") {
    // Reported only when it names a tool this build actually defines. An
    // unrecognised name is a client's arbitrary string, and echoing it would
    // put unbounded caller-supplied text into the export.
    const requested = asString((message.params as { name?: unknown } | undefined)?.name);
    props.tool = requested !== undefined && knownTools.has(requested) ? requested : "unknown";
  }

  if (reply.error !== undefined) {
    props.outcome = "rejected";
  } else if ((reply.result as { isError?: unknown } | undefined)?.isError === true) {
    props.outcome = "tool_error";
  }

  return props;
}

/**
 * The JSON-RPC methods this server implements — the `handleMessage` switch in
 * `./protocol`, spelled out so analytics can bound the value it exports.
 *
 * A request's `method` is caller-supplied free text: an authenticated client
 * can POST any string and get `METHOD_NOT_FOUND` back, so exporting it verbatim
 * would put arbitrary caller text in the analytics payload — the one thing the
 * catalog's privacy rule forbids. Unrecognised methods collapse to `unknown`,
 * which still answers the question worth asking ("are clients calling things we
 * do not implement") without carrying whatever they typed.
 */
const KNOWN_MCP_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "tools/call",
]);

function boundedMethod(method: string): string {
  return KNOWN_MCP_METHODS.has(method) ? method : "unknown";
}

/** Cap on a client's self-reported name or version before it is exported. */
const MAX_CLIENT_LABEL = 64;

function clientLabel(value: unknown): string | undefined {
  const text = asString(value);
  return text === undefined ? undefined : text.slice(0, MAX_CLIENT_LABEL);
}
