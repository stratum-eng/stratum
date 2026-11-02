/**
 * The JSON-RPC 2.0 / MCP message layer (#349).
 *
 * Deliberately transport-agnostic: it turns one parsed JSON-RPC message into
 * one reply (or `null`, for a notification), and knows nothing about HTTP. The
 * route in `src/routes/mcp.ts` owns framing, auth and status codes. Keeping the
 * split means the protocol is testable by handing it plain objects, which is
 * how `tests/mcp-endpoint.test.ts` exercises it.
 *
 * MCP is a thin layer over JSON-RPC, and the parts that matter here are the
 * handshake (`initialize`), discovery (`tools/list`) and invocation
 * (`tools/call`). Everything else in the spec — prompts, resources, sampling —
 * is capability-gated, and we advertise only `tools`, so a well-behaved client
 * never asks for the rest.
 */
import type { ToolDef } from "./tools";
import { toolListing } from "./tools";

/** Protocol revisions this server speaks, newest first.
 *
 * Negotiation is "echo the client's version when we know it, otherwise answer
 * with our newest and let the client decide". Answering with a version the
 * client did not ask for is explicitly allowed and is how a client older than
 * this list still connects. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_NAME = "stratum";

/** JSON-RPC 2.0 §5.1 reserved codes. */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A JSON-RPC success response. */
export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** A JSON-RPC error response. `data` is omitted rather than set to
 * `undefined`, which would serialize as a present-but-null field. */
export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/**
 * Is this a well-formed JSON-RPC request or notification?
 *
 * A notification is a request with no `id`, and it gets NO reply — replying to
 * one is a protocol violation that some clients treat as a fatal desync, which
 * is why `handleMessage` returns `null` rather than an empty response.
 *
 * An explicit `id: null` is neither, and MCP rejects it outright where JSON-RPC
 * merely discourages it. Accepting one would leave the reply indistinguishable
 * from the error responses that carry `id: null` precisely because no id could
 * be determined — so a client correlating replies by id would match the answer
 * to the wrong request. `JsonRpcId` still admits `null` for exactly those
 * responses; it is only inbound that it is refused.
 */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return false;
  if (typeof message.method !== "string") return false;
  const id = message.id;
  return id === undefined || typeof id === "string" || typeof id === "number";
}

export interface McpContext {
  tools: ToolDef[];
  /** Reported in the `initialize` handshake. Read from package.json at build
   * time by the caller so the wire version cannot drift from the release. */
  serverVersion: string;
}

interface InitializeParams {
  protocolVersion?: unknown;
}

/** Pick the protocol revision to answer with: the client's when we speak it,
 * otherwise our newest. See `SUPPORTED_PROTOCOL_VERSIONS` for why answering
 * with a version the client did not ask for is the right fallback. */
function negotiateVersion(params: unknown): string {
  const requested = (params as InitializeParams | undefined)?.protocolVersion;
  if (typeof requested === "string") {
    const known = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested);
    if (known !== undefined) return known;
  }
  return LATEST_PROTOCOL_VERSION;
}

interface CallToolParams {
  name?: unknown;
  arguments?: unknown;
}

/**
 * Handle one message. Returns `null` for notifications.
 *
 * Note what is NOT here: session state. Every MCP request to this server is
 * self-contained, authenticated by its own bearer token, and answered without
 * reference to anything a previous request did. That is what lets the endpoint
 * run on stateless Workers isolates with no Durable Object behind it — any
 * isolate can answer any request, and a client that reconnects loses nothing.
 * `initialize` is therefore a handshake that reports capabilities rather than
 * one that opens a session.
 */
export async function handleMessage(
  message: unknown,
  ctx: McpContext,
): Promise<JsonRpcResponse | null> {
  if (!isJsonRpcRequest(message)) {
    return rpcError(null, JSON_RPC.INVALID_REQUEST, "Not a valid JSON-RPC 2.0 request");
  }

  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  switch (message.method) {
    case "initialize": {
      if (isNotification) return null;
      return rpcResult(id, {
        protocolVersion: negotiateVersion(message.params),
        // Only `tools`. Advertising a capability we do not implement invites
        // clients to call into it and get a method-not-found they cannot
        // distinguish from a bug.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: ctx.serverVersion },
        instructions:
          "Stratum's evaluation-gated change flow. Fork a workspace, commit to it, then open a change — that runs the project's policy gates and returns each verdict. Merges are blocked by failing gates, and review verdicts are a human gate that agent credentials are refused.",
      });
    }

    // Post-handshake acknowledgements. They carry no data and, sent correctly
    // (no `id`), expect no reply — accepting them silently is the whole
    // contract.
    //
    // A client that sends one WITH an `id` has asked a question, though, and
    // JSON-RPC requires an answer: dropping it leaves that client's request
    // pending forever, and inside a batch it returns fewer replies than there
    // were ids. So the `isNotification` guard is applied here exactly as it is
    // in every other case below.
    case "notifications/initialized":
    case "notifications/cancelled":
      return isNotification ? null : rpcResult(id, {});

    case "ping":
      return isNotification ? null : rpcResult(id, {});

    case "tools/list": {
      if (isNotification) return null;
      return rpcResult(id, { tools: toolListing(ctx.tools) });
    }

    case "tools/call": {
      if (isNotification) return null;
      const params = (message.params ?? {}) as CallToolParams;
      if (typeof params.name !== "string") {
        return rpcError(id, JSON_RPC.INVALID_PARAMS, "tools/call requires a string 'name'");
      }
      const tool = ctx.tools.find((candidate) => candidate.name === params.name);
      if (tool === undefined) {
        // Method-not-found rather than an error RESULT: the tool does not
        // exist, so nothing ran. Reserving `isError` results for tools that
        // ran and failed keeps "you called something that isn't there" legible.
        return rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `Unknown tool '${params.name}'`);
      }
      try {
        return rpcResult(id, await tool.handler(params.arguments ?? {}));
      } catch (error) {
        // `tool.handler` maps its own failures to `isError` results, so landing
        // here means the wrapper itself broke. That is ours, not the caller's.
        return rpcError(
          id,
          JSON_RPC.INTERNAL_ERROR,
          error instanceof Error ? error.message : "Tool invocation failed",
        );
      }
    }

    default:
      return isNotification
        ? null
        : rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `Unknown method '${message.method}'`);
  }
}
