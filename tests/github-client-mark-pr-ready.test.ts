import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, resetCircuitBreakersForTests } from "../src/github/client";
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const pr = (over: Record<string, unknown> = {}) => ({
  number: 7,
  state: "open",
  draft: true,
  node_id: "PR_node",
  html_url: "https://github.com/acme/api/pull/7",
  ...over,
});

beforeEach(() => resetCircuitBreakersForTests());
afterEach(() => vi.unstubAllGlobals());

describe("GitHubClient.markPRReady", () => {
  it("takes a draft out of draft through the GraphQL mutation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(pr()))
      .mockResolvedValueOnce(
        json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GitHubClient("tok", logger).markPRReady("acme", "api", 7);

    expect(result).toEqual({ success: true, alreadyReady: false });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body)) as { query: string; variables: { id: string } };
    expect(sent.query).toContain("markPullRequestReadyForReview");
    // The id travels as a variable, never spliced into the query text.
    expect(sent.variables).toEqual({ id: "PR_node" });
    expect(sent.query).not.toContain("PR_node");
  });

  it("does nothing to a pull request that is already ready", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(pr({ draft: false })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GitHubClient("tok", logger).markPRReady("acme", "api", 7);

    expect(result).toEqual({ success: true, alreadyReady: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a closed pull request without calling the mutation", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(pr({ state: "closed" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GitHubClient("tok", logger).markPRReady("acme", "api", 7);

    expect(result).toEqual({
      success: false,
      error: "The pull request is closed",
      closed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a mutation GitHub refused inside a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(pr()))
        .mockResolvedValueOnce(json({ errors: [{ message: "Resource not accessible" }] })),
    );

    const result = await new GitHubClient("tok", logger).markPRReady("acme", "api", 7);

    expect(result).toEqual({ success: false, error: "Resource not accessible" });
  });

  it("does not report success when GitHub does not confirm the new state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(pr()))
        .mockResolvedValueOnce(json({ data: {} })),
    );

    const result = await new GitHubClient("tok", logger).markPRReady("acme", "api", 7);

    expect(result.success).toBe(false);
  });

  it("passes on a failure to read the pull request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ message: "Not Found" }, 404)));

    const result = await new GitHubClient("tok", logger).markPRReady("acme", "api", 7);

    expect(result.success).toBe(false);
  });
});
