import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StratumClient, parseProjectRef } from "../src/client.js";

const fetchMock = vi.fn();

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

describe("parseProjectRef", () => {
  it("parses namespace/slug with and without @", () => {
    expect(parseProjectRef("@user/repo")).toEqual({ namespace: "@user", slug: "repo" });
    expect(parseProjectRef("user/repo")).toEqual({ namespace: "@user", slug: "repo" });
  });

  it("rejects malformed references", () => {
    expect(() => parseProjectRef("just-a-name")).toThrow(/namespace\/slug/);
  });
});

describe("StratumClient", () => {
  let client: StratumClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    client = new StratumClient("https://stratum.example.com/", "stratum_user_key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the bearer token and strips trailing slash from host", async () => {
    await client.listProjects();
    const { url, init } = lastCall();
    expect(url).toBe("https://stratum.example.com/api/projects");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer stratum_user_key");
  });

  it("hits the namespaced workspace endpoints", async () => {
    const ref = parseProjectRef("@user/repo");
    await client.createWorkspace(ref, "ws-1");
    expect(lastCall().url).toBe(
      "https://stratum.example.com/api/workspaces/%40user/repo/workspaces",
    );
    expect(lastCall().init.method).toBe("POST");

    await client.listWorkspaces(ref);
    expect(lastCall().url).toBe(
      "https://stratum.example.com/api/workspaces/%40user/repo/workspaces",
    );

    await client.deleteWorkspace("ws-1", "proj_123");
    expect(lastCall().url).toBe(
      "https://stratum.example.com/api/workspaces/ws-1?projectId=proj_123",
    );
    expect(lastCall().init.method).toBe("DELETE");
  });

  it("commits with projectId in the body", async () => {
    await client.commitToWorkspace("ws-1", "proj_123", { "a.ts": "x" }, "msg");
    const { url, init } = lastCall();
    expect(url).toBe("https://stratum.example.com/api/workspaces/ws-1/commit");
    expect(JSON.parse(init.body as string)).toEqual({
      files: { "a.ts": "x" },
      message: "msg",
      projectId: "proj_123",
    });
  });

  it("creates and merges changes via the real endpoints", async () => {
    await client.createChange("@user/repo", "ws-1");
    expect(lastCall().url).toBe("https://stratum.example.com/api/projects/%40user%2Frepo/changes");

    await client.mergeChange("chg_1", { force: true, strategy: "squash" });
    expect(lastCall().url).toBe(
      "https://stratum.example.com/api/changes/chg_1/merge?force=true&strategy=squash",
    );

    await client.mergeChange("chg_1");
    expect(lastCall().url).toBe("https://stratum.example.com/api/changes/chg_1/merge");
  });

  it("submits review verdicts", async () => {
    await client.reviewChange("chg_1", "approve", "lgtm");
    const { url, init } = lastCall();
    expect(url).toBe("https://stratum.example.com/api/changes/chg_1/reviews");
    expect(JSON.parse(init.body as string)).toEqual({ verdict: "approve", comment: "lgtm" });
  });

  it("manages issues through the namespaced endpoints", async () => {
    const ref = parseProjectRef("@user/repo");
    await client.createIssue(ref, "Bug", "details", "chg_1");
    expect(lastCall().url).toBe("https://stratum.example.com/api/projects/%40user/repo/issues");
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      title: "Bug",
      body: "details",
      linkedChangeId: "chg_1",
    });

    await client.listIssues(ref, "closed");
    expect(lastCall().url).toBe(
      "https://stratum.example.com/api/projects/%40user/repo/issues?status=closed",
    );

    await client.updateIssue(ref, 4, { status: "closed" });
    expect(lastCall().url).toBe("https://stratum.example.com/api/projects/%40user/repo/issues/4");
    expect(lastCall().init.method).toBe("PATCH");
  });

  it("surfaces API error messages including protection reasons", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Merge blocked by branch protection",
          reasons: ["Requires 1 approval, has 0"],
        }),
        { status: 403 },
      ),
    );
    await expect(client.mergeChange("chg_1")).rejects.toThrow(
      /Merge blocked by branch protection[\s\S]*Requires 1 approval/,
    );
  });
});
