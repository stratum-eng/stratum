import { beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json?raw";
import app from "../src/index";
/**
 * Issue #349: the remote MCP endpoint at `/mcp`.
 *
 * Driven through the whole Worker (`src/index.ts`) against real SQLite, because
 * the point of this endpoint is that a tool call lands on the REAL API route
 * handlers — `stratum_whoami` here actually reaches `GET /api/users/me` and is
 * answered by it. A mocked dispatcher would test the wiring and prove nothing
 * about the thing the wiring exists for.
 *
 * The credential used throughout is a plain user token rather than an OAuth
 * grant. That is the headless path the docs describe, and it keeps these tests
 * about MCP; the OAuth flow has its own suites.
 */
/// <reference types="vite/client" />
import { describeMcpOutcome } from "../src/mcp/outcome";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/protocol";
import { SERVER_VERSION } from "../src/routes/mcp";
import { issueTokens, registerClient } from "../src/storage/oauth";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const ORIGIN = "https://stratum.test";
const USER_TOKEN = "stratum_user_11111111111111111111111111111111";

let env: Env;
let db: D1Database;

interface RpcReply {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(
  body: unknown,
  opts: { token?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  const token = opts.token === undefined ? USER_TOKEN : opts.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(body) }),
    env,
  );
}

async function call(name: string, args: unknown = {}, token?: string): Promise<RpcReply> {
  const response = await rpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    token === undefined ? {} : { token },
  );
  return (await response.json()) as RpcReply;
}

/** The text a tool result carries, whether it succeeded or failed. */
function resultText(reply: RpcReply): string {
  const content = reply.result?.content as Array<{ text: string }> | undefined;
  return content?.map((part) => part.text).join("\n") ?? "";
}

beforeEach(async () => {
  const made = makeSqliteD1();
  db = made.db;
  env = { DB: db, STATE: undefined, ARTIFACTS: undefined } as unknown as Env;
  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind("usr_1", "alice@test", "alice", await hashToken(USER_TOKEN))
    .run();
});

describe("authentication", () => {
  it("answers a credential-less request with the challenge that bootstraps OAuth", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { token: null });
    expect(response.status).toBe(401);

    // This header IS the discovery story (RFC 9728): without `resource_metadata`
    // a client has no way to find the authorization server from a bare 401.
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );
    // RFC 6750 §3: the scopes full use of the endpoint needs, so a client that
    // takes its scope from the challenge asks for write access up front rather
    // than authorizing read-only and failing on its first commit.
    expect(challenge).toContain('scope="mcp:read mcp:write"');

    // And the body is a JSON-RPC error, so a client that hands the body to its
    // RPC layer before checking the status gets something parseable.
    const body = (await response.json()) as RpcReply;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32600);
  });

  it("rejects an unknown token, still carrying the challenge", async () => {
    const response = await rpc(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { token: "stratum_user_99999999999999999999999999999999" },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("accepts an OAuth access token", async () => {
    const client = await registerClient(db, logger, {
      clientName: "Editor",
      redirectUris: ["http://127.0.0.1:9000/cb"],
    });
    if (!client.success) throw new Error("client setup failed");
    const tokens = await issueTokens(db, logger, {
      clientId: client.data.client.id,
      userId: "usr_1",
      scope: "mcp:read mcp:write",
    });
    if (!tokens.success) throw new Error("token setup failed");

    const reply = await call("stratum_whoami", {}, tokens.data.accessToken);
    expect(reply.error).toBeUndefined();
    expect(resultText(reply)).toContain("alice@test");
  });

  it("refuses a read-only OAuth grant on a write tool, before the tool runs", async () => {
    const client = await registerClient(db, logger, {
      clientName: "Reader",
      redirectUris: ["http://127.0.0.1:9000/cb"],
    });
    if (!client.success) throw new Error("client setup failed");
    const tokens = await issueTokens(db, logger, {
      clientId: client.data.client.id,
      userId: "usr_1",
      scope: "mcp:read",
    });
    if (!tokens.success) throw new Error("token setup failed");

    const reply = await call(
      "stratum_create_workspace",
      { project: "@alice/api" },
      tokens.data.accessToken,
    );
    expect(reply.result?.isError).toBe(true);
    expect(resultText(reply)).toContain("read-only");

    // The same grant still reads.
    const read = await call("stratum_whoami", {}, tokens.data.accessToken);
    expect(read.result?.isError).toBeUndefined();
  });
});

describe("handshake", () => {
  it("reports tools capability and identifies the server", async () => {
    const reply = (await (
      await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {} },
      })
    ).json()) as RpcReply;

    expect(reply.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(reply.result?.serverInfo).toMatchObject({ name: "stratum" });
    // Only what we implement: advertising prompts or resources invites calls we
    // would answer with a method-not-found the client cannot distinguish from a
    // bug.
    expect(Object.keys(reply.result?.capabilities as object)).toEqual(["tools"]);
  });

  it("echoes an older revision it knows, and falls back for one it does not", async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const reply = (await (
        await rpc({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: version },
        })
      ).json()) as RpcReply;
      expect(reply.result?.protocolVersion).toBe(version);
    }

    const unknown = (await (
      await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      })
    ).json()) as RpcReply;
    // Answering with our newest is allowed and is how a client older than our
    // list still connects.
    expect(unknown.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("reports the version in package.json, so a release bump cannot leave it stale", async () => {
    // The constant is duplicated rather than imported (importing JSON would
    // ship the whole manifest to the edge for one string), so this is what
    // keeps the two in step — the same guard style as tests/changelog.test.ts
    // and tests/wrangler-migration-chain.test.ts.
    const declared = (JSON.parse(packageJson) as { version: string }).version;
    expect(SERVER_VERSION).toBe(declared);

    const reply = (await (
      await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" })
    ).json()) as RpcReply;
    expect((reply.result?.serverInfo as { version: string }).version).toBe(declared);
  });

  it("answers a notification with 202 and no body", async () => {
    const response = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers ping", async () => {
    const reply = (await (await rpc({ jsonrpc: "2.0", id: 7, method: "ping" })).json()) as RpcReply;
    expect(reply.id).toBe(7);
    expect(reply.result).toEqual({});
  });
});

describe("tools/list", () => {
  it("publishes all eighteen tools with usable JSON Schema", async () => {
    const reply = (await (
      await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).json()) as RpcReply;
    const tools = reply.result?.tools as Array<{
      name: string;
      description: string;
      inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
    }>;

    expect(tools).toHaveLength(18);
    expect(tools.map((t) => t.name)).toContain("stratum_create_change");

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }

    const commit = tools.find((t) => t.name === "stratum_commit");
    expect(commit?.inputSchema.required?.sort()).toEqual([
      "files",
      "message",
      "project_id",
      "workspace",
    ]);
    expect(commit?.inputSchema.properties.files).toMatchObject({
      type: "object",
      additionalProperties: { type: "string" },
    });

    // An optional field must not be listed as required, or a model will
    // hallucinate a value for it.
    const merge = tools.find((t) => t.name === "stratum_merge_change");
    expect(merge?.inputSchema.required).toEqual(["change_id"]);
    expect(merge?.inputSchema.properties.strategy).toMatchObject({
      enum: ["merge", "squash"],
    });

    // A tool with no arguments publishes no `required` key at all.
    const whoami = tools.find((t) => t.name === "stratum_whoami");
    expect(whoami?.inputSchema.required).toBeUndefined();
  });
});

describe("tools/call", () => {
  it("dispatches to the real API route and returns its JSON", async () => {
    const reply = await call("stratum_whoami");
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).toBeUndefined();
    const body = JSON.parse(resultText(reply)) as { id: string; email: string };
    expect(body).toMatchObject({ id: "usr_1", email: "alice@test" });
  });

  it("surfaces an API refusal as a tool error, not a transport error", async () => {
    // A tool that RAN and was refused must come back as an `isError` result the
    // model can read; a JSON-RPC error would reach the client as a transport
    // fault it cannot reason about.
    const reply = await call("stratum_get_project", { project: "@alice/nope" });
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).toBe(true);
    expect(resultText(reply)).toContain("Stratum API error:");
  });

  it("reports every argument problem at once, labelled as an argument problem", async () => {
    const reply = await call("stratum_commit", {
      workspace: 42,
      message: "hi",
      files: { "a.txt": 5 },
      typo: "x",
    });
    expect(reply.result?.isError).toBe(true);
    const text = resultText(reply);
    // Labelled distinctly from an API failure: a model reading "Stratum API
    // error" for a schema violation retries the same invalid arguments.
    expect(text).toContain("Invalid arguments for stratum_commit");
    expect(text).toContain("'workspace' must be a string");
    expect(text).toContain("missing required argument 'project_id'");
    expect(text).toContain("'files' must map every key to a string");
    expect(text).toContain("unknown argument 'typo'");
  });

  it("labels a malformed project reference as an ARGUMENT error, not an API error", async () => {
    const reply = await call("stratum_get_project", { project: "not-a-ref" });
    expect(reply.result?.isError).toBe(true);
    const text = resultText(reply);
    expect(text).toContain("expected namespace/slug");
    // The schema can only type this field as "a string", so the check lands in
    // the handler — but a model that reads "Stratum API error" here retries the
    // same broken reference instead of fixing it.
    expect(text).toContain("Invalid arguments for stratum_get_project");
    expect(text).not.toContain("Stratum API error");
  });

  it("answers an unknown tool with method-not-found", async () => {
    const reply = await call("stratum_delete_everything");
    // Nothing ran, so this is not an `isError` result: reserving those for
    // tools that ran and failed keeps the distinction legible.
    expect(reply.error?.code).toBe(-32601);
    expect(reply.error?.message).toContain("stratum_delete_everything");
  });

  it("rejects a call with no tool name", async () => {
    const reply = (await (
      await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })
    ).json()) as RpcReply;
    expect(reply.error?.code).toBe(-32602);
  });
});

describe("protocol framing", () => {
  it("reports a parse error for a body that is not JSON", async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_TOKEN}` },
        body: "{not json",
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as RpcReply).error?.code).toBe(-32700);
  });

  it("caps an oversized body, and answers in JSON-RPC", async () => {
    // Enforced during the read, so an absent or understated Content-Length
    // cannot get past it — a lying header must not buy an unbounded buffer.
    const huge = "x".repeat(12 * 1024 * 1024);
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${USER_TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { huge } }),
      }),
      env,
    );
    expect(response.status).toBe(413);
    // A `{error, code}` body is unparseable to an MCP client; this one is not.
    const body = (await response.json()) as RpcReply;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.message).toContain("too large");
  });

  it("rejects a message that is not a JSON-RPC 2.0 request", async () => {
    const reply = (await (await rpc({ hello: "world" })).json()) as RpcReply;
    expect(reply.error?.code).toBe(-32600);
  });

  it("answers an unknown method with method-not-found", async () => {
    const reply = (await (
      await rpc({ jsonrpc: "2.0", id: 3, method: "resources/list" })
    ).json()) as RpcReply;
    expect(reply.error?.code).toBe(-32601);
  });

  it("handles a batch, omitting replies for its notifications", async () => {
    const response = await rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const replies = (await response.json()) as RpcReply[];
    expect(replies).toHaveLength(2);
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
  });

  it("answers a notification method that arrives WITH an id", async () => {
    // A client that sends one of these with an `id` has asked a question.
    // Dropping the reply leaves its request pending forever.
    const reply = (await (
      await rpc({ jsonrpc: "2.0", id: 9, method: "notifications/initialized" })
    ).json()) as RpcReply;
    expect(reply.id).toBe(9);
    expect(reply.result).toEqual({});
  });

  it("returns one reply per id in a batch, even for notification methods", async () => {
    // Inside a batch the dropped reply is worse: the array comes back shorter
    // than the ids that were sent, and the client cannot tell which is missing.
    const response = await rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
    ]);
    const replies = (await response.json()) as RpcReply[];
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
  });

  it("answers a batch of only notifications with 202, not an empty array", async () => {
    const response = await rpc([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(response.status).toBe(202);
  });

  it("rejects an empty batch", async () => {
    const response = await rpc([]);
    expect(response.status).toBe(400);
  });

  it("refuses a batch from a client that declared 2025-06-18, which removed batching", async () => {
    const response = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }], {
      headers: { "Mcp-Protocol-Version": "2025-06-18" },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as RpcReply).error?.message).toContain("batching");
  });

  it("still accepts a batch on an older revision, and when none is declared", async () => {
    // The rule keys on the client's own declaration, not on our preference. An
    // absent header says nothing, and both older revisions do batch — refusing
    // there would break every client that never sends the header at all.
    const cases: Record<string, string>[] = [{ "Mcp-Protocol-Version": "2025-03-26" }, {}];
    for (const headers of cases) {
      const response = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }], { headers });
      expect(response.status, JSON.stringify(headers)).toBe(200);
    }
  });

  it("refuses an explicit null id rather than answering it", async () => {
    // MCP forbids a null request id. Answering one produces a reply that is
    // indistinguishable from the error responses that carry `id: null` because
    // no id could be determined — so a client correlating by id matches the
    // answer to the wrong request.
    const response = await rpc({ jsonrpc: "2.0", id: null, method: "tools/list" });
    const reply = (await response.json()) as RpcReply;
    expect(reply.error?.code).toBe(-32600);
    expect(reply.result).toBeUndefined();
  });

  it("rejects a protocol version it does not speak, but tolerates none at all", async () => {
    const bad = await rpc(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { "Mcp-Protocol-Version": "1999-01-01" } },
    );
    expect(bad.status).toBe(400);

    // Absent is fine — the older revision has no such header, and treating its
    // absence as a violation would break every client that follows it.
    const absent = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(absent.status).toBe(200);
  });

  it("never lets a response be cached", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("other methods on /mcp", () => {
  it("returns 405 for GET, without requiring a credential to learn it", async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/mcp`), env);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });

  it("acknowledges DELETE, since there is no session state to discard", async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${USER_TOKEN}` },
      }),
      env,
    );
    expect(response.status).toBe(204);
  });
});

describe("describeMcpOutcome (#355)", () => {
  it("logs the handshake at info with the client's self-description", () => {
    const outcome = describeMcpOutcome(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", clientInfo: { name: "Claude", version: "1.2" } },
      },
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
    );
    expect(outcome.level).toBe("info");
    expect(outcome.message).toBe("MCP client initialized");
    expect(outcome.meta).toEqual({
      clientName: "Claude",
      clientVersion: "1.2",
      requestedProtocolVersion: "2025-03-26",
      protocolVersion: "2025-03-26",
    });
  });

  it("logs a tool that ran and failed at warn, with the error the model saw", () => {
    const outcome = describeMcpOutcome(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stratum_commit" } },
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          isError: true,
          content: [{ type: "text", text: "Stratum API error: 403 read-only" }],
        },
      },
    );
    expect(outcome.level).toBe("warn");
    expect(outcome.message).toBe("MCP tool call failed");
    expect(outcome.meta).toEqual({
      tool: "stratum_commit",
      detail: "Stratum API error: 403 read-only",
    });
  });

  it("logs a rejected call at warn and a successful one at debug", () => {
    const rejected = describeMcpOutcome(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Unknown tool 'nope'" } },
    );
    expect(rejected.level).toBe("warn");
    expect(rejected.meta).toEqual({ tool: "nope", code: -32601, error: "Unknown tool 'nope'" });

    const ok = describeMcpOutcome(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stratum_whoami" } },
      { jsonrpc: "2.0", id: 4, result: { content: [] } },
    );
    expect(ok.level).toBe("debug");
  });

  it("never reports a notification as a tool run or a handshake", () => {
    // `handleMessage` returns null for a `tools/call` or `initialize` that
    // arrives without an id, and runs nothing. The classifier must not turn
    // that into "MCP tool call succeeded" or "MCP client initialized".
    const tool = describeMcpOutcome(
      { jsonrpc: "2.0", method: "tools/call", params: { name: "stratum_commit" } },
      null,
    );
    expect(tool).toEqual({
      level: "debug",
      message: "MCP notification handled",
      meta: { method: "tools/call" },
    });
    const handshake = describeMcpOutcome(
      { jsonrpc: "2.0", method: "initialize", params: { clientInfo: { name: "Claude" } } },
      null,
    );
    expect(handshake).toEqual({
      level: "debug",
      message: "MCP notification handled",
      meta: { method: "initialize" },
    });
  });

  it("keeps notifications and routine requests at debug, and malformed input at warn", () => {
    expect(
      describeMcpOutcome({ jsonrpc: "2.0", method: "notifications/initialized" }, null).level,
    ).toBe("debug");
    expect(
      describeMcpOutcome(
        { jsonrpc: "2.0", id: 5, method: "tools/list" },
        { jsonrpc: "2.0", id: 5, result: { tools: [] } },
      ).level,
    ).toBe("debug");
    expect(describeMcpOutcome("garbage", null).level).toBe("warn");
  });
});
