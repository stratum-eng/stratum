import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../src/github/client";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHubClient.updateComment", () => {
  it("PATCHes the issue comment endpoint with the new body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 555 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.updateComment({
      owner: "acme",
      repo: "api",
      comment_id: 555,
      body: "updated verdict",
    });

    expect(result).toEqual({ success: true, id: 555 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/api/issues/comments/555",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ body: "updated verdict" }),
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("returns the API error on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient("tok", logger);
    const result = await client.updateComment({
      owner: "acme",
      repo: "api",
      comment_id: 404404,
      body: "x",
    });

    expect(result.success).toBe(false);
    expect(!result.success && result.error).toContain("404");
  });
});
