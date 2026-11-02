import { describe, expect, it } from "vitest";
import { describeMcpAnalytics } from "../src/mcp/outcome";

const TOOLS = new Set(["stratum_commit", "stratum_list_projects", "stratum_whoami"]);

describe("describeMcpAnalytics", () => {
  it("reports a successful tool call with the tool name", () => {
    const props = describeMcpAnalytics(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stratum_commit" } },
      { jsonrpc: "2.0", id: 1, result: { content: [] } },
      TOOLS,
    );
    expect(props).toEqual({
      mcp_method: "tools/call",
      outcome: "ok",
      tool: "stratum_commit",
    });
  });

  it("distinguishes a tool that ran and failed from one the protocol refused", () => {
    const ranAndFailed = describeMcpAnalytics(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stratum_commit" } },
      { jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } },
      TOOLS,
    );
    expect(ranAndFailed?.outcome).toBe("tool_error");

    const refused = describeMcpAnalytics(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stratum_commit" } },
      { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } },
      TOOLS,
    );
    expect(refused?.outcome).toBe("rejected");
  });

  // A tool name arrives in the request body, so an arbitrary string can be put
  // there. Echoing it would put unbounded caller-supplied text in the export.
  it("reports an unrecognised tool name as `unknown` rather than echoing it", () => {
    const props = describeMcpAnalytics(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "acme_internal_deploy_secret" },
      },
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Unknown tool" } },
      TOOLS,
    );
    expect(props?.tool).toBe("unknown");
    expect(JSON.stringify(props)).not.toContain("acme");
  });

  it("captures the client's self-description from the handshake", () => {
    const props = describeMcpAnalytics(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", clientInfo: { name: "Claude", version: "1.2" } },
      },
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
      TOOLS,
    );
    expect(props).toEqual({
      mcp_method: "initialize",
      outcome: "ok",
      client_name: "Claude",
      client_version: "1.2",
      protocol_version: "2025-03-26",
    });
  });

  it("caps a client name at 64 characters", () => {
    const props = describeMcpAnalytics(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "x".repeat(500) } },
      },
      { jsonrpc: "2.0", id: 1, result: {} },
      TOOLS,
    );
    expect(props?.client_name).toHaveLength(64);
  });

  it("omits client fields the handshake did not provide", () => {
    const props = describeMcpAnalytics(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 1, result: {} },
      TOOLS,
    );
    expect(props).toEqual({ mcp_method: "initialize", outcome: "ok" });
  });

  // Counting these as tool calls would overstate MCP usage with traffic that
  // never reached a tool.
  it("counts nothing for a notification, which runs no tool", () => {
    const props = describeMcpAnalytics(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      null,
      TOOLS,
    );
    expect(props).toBeNull();
  });

  it("counts nothing for a message that is not JSON-RPC", () => {
    expect(describeMcpAnalytics({ hello: "world" }, null, TOOLS)).toBeNull();
    expect(describeMcpAnalytics("not an object", null, TOOLS)).toBeNull();
  });

  // A method name is caller-supplied free text: any authenticated client can
  // POST an arbitrary string and get METHOD_NOT_FOUND back. Exporting it
  // verbatim would put that text in the payload.
  it("collapses an unrecognised method rather than exporting what the caller sent", () => {
    const props = describeMcpAnalytics(
      { jsonrpc: "2.0", id: 1, method: "acme/internal-secret-handshake" },
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
      TOOLS,
    );
    expect(props?.mcp_method).toBe("unknown");
    expect(props?.outcome).toBe("rejected");
    expect(JSON.stringify(props)).not.toContain("acme");
  });

  it("keeps the real name for every method the server implements", () => {
    for (const method of ["initialize", "ping", "tools/list", "tools/call"]) {
      const props = describeMcpAnalytics(
        { jsonrpc: "2.0", id: 1, method },
        { jsonrpc: "2.0", id: 1, result: {} },
        TOOLS,
      );
      expect(props?.mcp_method).toBe(method);
    }
  });

  it("reports a non-tool method without a tool property", () => {
    const props = describeMcpAnalytics(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      TOOLS,
    );
    expect(props).toEqual({ mcp_method: "tools/list", outcome: "ok" });
  });
});
