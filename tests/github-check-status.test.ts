import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckRun, CheckStatus } from "../src/storage/checks";
import type { Change, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/github/client", () => ({
  GitHubClient: vi.fn(),
}));

// Credential resolution has its own suites; here every repository has a token.
vi.mock("../src/github/app-auth", () => ({
  resolveGitHubToken: vi.fn(async () => ({ success: true, data: { token: "tok" } })),
}));

import {
  CHECK_STATUS_CONTEXT_PREFIX,
  latestChecksOn,
  reportChecksToGitHub,
} from "../src/github/check-status";
import { GitHubClient } from "../src/github/client";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const project: ProjectEntry = {
  id: "proj_1",
  name: "api",
  slug: "api",
  namespace: "@acme",
  ownerId: "user_1",
  ownerType: "user",
  remote: "https://artifacts.example.com/repos/api",
  createdAt: "2026-01-01T00:00:00.000Z",
  sourceUrl: "https://github.com/acme/api",
  sourceProvider: "github",
};

const change: Change = {
  id: "chg_1",
  project: "@acme/api",
  projectId: "proj_1",
  workspace: "feat-x",
  status: "promoted",
  createdAt: "2026-01-01T01:00:00.000Z",
  githubOwner: "acme",
  githubRepo: "api",
  githubPrNumber: 12,
  githubHeadSha: "rev-1",
  evaluatedSha: "rev-1",
};

function check(name: string, status: CheckStatus, fields: Partial<CheckRun> = {}): CheckRun {
  return {
    id: `chk_${name}_${fields.attempt ?? 1}`,
    changeId: "chg_1",
    projectId: "proj_1",
    revision: "rev-1",
    name,
    attempt: 1,
    status,
    secretRef: "RUNNER",
    lastSequence: 0,
    createdAt: "2026-01-01T02:00:00.000Z",
    updatedAt: "2026-01-01T02:00:00.000Z",
    deadlineAt: "2026-01-01T03:00:00.000Z",
    ...fields,
  };
}

const env = { DB: {} as D1Database, STATE: {} as KVNamespace, GITHUB_TOKEN: "tok" };

let setStatus: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  setStatus = vi.fn().mockResolvedValue({ success: true });
  vi.mocked(GitHubClient).mockImplementation(
    () => ({ setStatus }) as unknown as InstanceType<typeof GitHubClient>,
  );
});

describe("reportChecksToGitHub", () => {
  it("posts one status per check, mapping each check state to GitHub's", async () => {
    await reportChecksToGitHub(env, logger, {
      change,
      project,
      checks: [
        check("queued", "queued"),
        check("running", "running"),
        check("passed", "passed", { summary: "All 12 tests passed" }),
        check("failed", "failed", { detailsUrl: "https://ci.example.com/run/7" }),
        check("errored", "errored"),
      ],
    });

    const posted = Object.fromEntries(
      setStatus.mock.calls.map(([opts]) => [opts.context, opts]),
    ) as Record<string, { state: string; description: string; sha: string; target_url?: string }>;
    expect(Object.keys(posted).sort()).toEqual(
      ["errored", "failed", "passed", "queued", "running"].map(
        (name) => `${CHECK_STATUS_CONTEXT_PREFIX}${name}`,
      ),
    );
    expect(posted["stratum/check/queued"]?.state).toBe("pending");
    expect(posted["stratum/check/running"]?.state).toBe("pending");
    expect(posted["stratum/check/passed"]).toMatchObject({
      state: "success",
      description: "All 12 tests passed",
      sha: "rev-1",
    });
    expect(posted["stratum/check/failed"]).toMatchObject({
      state: "failure",
      description: "Failed",
      target_url: "https://ci.example.com/run/7",
    });
    expect(posted["stratum/check/errored"]?.state).toBe("error");
  });

  it("keeps a description within GitHub's 140 characters", async () => {
    await reportChecksToGitHub(env, logger, {
      change,
      project,
      checks: [check("review", "failed", { summary: "x".repeat(500) })],
    });
    const description = setStatus.mock.calls[0]?.[0].description as string;
    expect(description).toHaveLength(140);
    expect(description.endsWith("…")).toBe(true);
  });

  it("does nothing for a change with no pull request", async () => {
    await reportChecksToGitHub(env, logger, {
      change: { ...change, githubPrNumber: undefined },
      project,
      checks: [check("lint", "passed")],
    });
    expect(GitHubClient).not.toHaveBeenCalled();
  });

  it("does nothing when the pull request's head is not the evaluated revision", async () => {
    // Re-evaluated after promotion: the PR still shows the old commit, which
    // these checks did not run against.
    await reportChecksToGitHub(env, logger, {
      change: { ...change, evaluatedSha: "rev-2" },
      project,
      checks: [check("lint", "passed", { revision: "rev-2" })],
    });
    expect(GitHubClient).not.toHaveBeenCalled();
  });

  it("posts only the newest attempt of a re-run check", async () => {
    await reportChecksToGitHub(env, logger, {
      change,
      project,
      checks: [check("test", "failed"), check("test", "passed", { attempt: 2 })],
    });
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus.mock.calls[0]?.[0].state).toBe("success");
  });

  it("logs and carries on when GitHub refuses one status", async () => {
    setStatus.mockResolvedValueOnce({ success: false, error: "HTTP 500" });
    await reportChecksToGitHub(env, logger, {
      change,
      project,
      checks: [check("a", "passed"), check("b", "passed")],
    });
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to set a check status on GitHub",
      expect.objectContaining({ check: "a" }),
    );
  });
});

describe("latestChecksOn", () => {
  it("drops runs on other revisions", () => {
    expect(
      latestChecksOn(
        [check("lint", "passed"), check("lint", "failed", { revision: "old" })],
        "rev-1",
      ),
    ).toEqual([check("lint", "passed")]);
  });
});
