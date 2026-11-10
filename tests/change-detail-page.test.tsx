import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { ChangeDetailPage, splitEvalRounds } from "../src/ui/pages/change-detail";

const baseChange = {
  id: "chg_test123",
  project: "my-project",
  workspace: "fix-bug",
  createdAt: "2026-01-01T02:00:00.000Z",
};

function render(status: string, canReview = true): string {
  return renderToString(
    <ChangeDetailPage
      change={{ ...baseChange, status }}
      evalRuns={[]}
      provenance={null}
      canReview={canReview}
      user={null}
    />,
  );
}

describe("ChangeDetailPage provenance and merge metadata", () => {
  it("renders the provenance card when provenance is provided", () => {
    const html = renderToString(
      <ChangeDetailPage
        change={{ ...baseChange, status: "merged", mergedAt: "2026-01-03T10:00:00.000Z" }}
        evalRuns={[]}
        provenance={{
          commitSha: "deadbeefcafe1234",
          workspace: "fix-bug",
          agentId: "agent_gpt",
          evalScore: 0.92,
          mergedAt: "2026-01-03T10:00:00.000Z",
        }}
        user={null}
      />,
    );
    expect(html).toContain("Provenance");
    expect(html).toContain("deadbeefcafe1234");
    expect(html).toContain("agent_gpt");
    expect(html).toContain("<dt>Merged</dt>");
    expect(html).toContain(new Date("2026-01-03T10:00:00.000Z").toLocaleString());
  });

  it("omits the provenance card and merged row when absent", () => {
    const html = render("open");
    expect(html).not.toContain("Provenance");
    expect(html).not.toContain("<dt>Merged</dt>");
  });

  it("renders the Open GitHub PR action from githubPrUrl", () => {
    const html = renderToString(
      <ChangeDetailPage
        change={{
          ...baseChange,
          status: "promoted",
          githubPrUrl: "https://github.com/acme/api/pull/42",
        }}
        evalRuns={[]}
        provenance={null}
        user={null}
      />,
    );
    expect(html).toContain("Open GitHub PR");
    expect(html).toContain("https://github.com/acme/api/pull/42");
  });

  it("renders evaluator issues inside the evidence table", () => {
    const html = renderToString(
      <ChangeDetailPage
        change={{ ...baseChange, status: "needs_changes" }}
        evalRuns={[
          {
            id: "evl_001",
            evaluatorType: "secret_scan",
            score: 0,
            passed: false,
            reason: "Secrets detected",
            issues: ["AWS key found in config.ts"],
            ranAt: "2026-01-02T01:00:00.000Z",
          },
        ]}
        provenance={null}
        user={null}
      />,
    );
    expect(html).toContain("secret_scan");
    expect(html).toContain("AWS key found in config.ts");
    expect(html).toContain("issue-list");
  });
});

describe("ChangeDetailPage actions", () => {
  it("offers reject and re-evaluation on an open change", () => {
    const html = render("open");
    expect(html).toContain("Reject change");
    expect(html).toContain("Run evaluations again");
    expect(html).not.toContain("Merge change");
  });

  it("offers merge to reviewers on an approved change", () => {
    const html = render("approved");
    expect(html).toContain("Merge change");
    expect(html).toContain("Reject change");
  });

  it("hides merge from non-reviewers", () => {
    const html = render("approved", false);
    expect(html).not.toContain("Merge change");
  });

  it("offers no actions on a merged change", () => {
    const html = render("merged");
    expect(html).not.toContain("Reject change");
    expect(html).not.toContain("Merge change");
    expect(html).not.toContain("<h2>Actions</h2>");
  });

  it("offers no actions on a rejected change", () => {
    const html = render("rejected");
    expect(html).not.toContain("Reject change");
    expect(html).not.toContain("<h2>Actions</h2>");
  });
});

describe("ChangeDetailPage while evaluation is pending (#412)", () => {
  const signedIn = { id: "user_test", email: "t@x.io", username: "test" };

  function renderAs(status: string, user: typeof signedIn | null): string {
    return renderToString(
      <ChangeDetailPage
        change={{ ...baseChange, status }}
        evalRuns={[]}
        provenance={null}
        canReview={user !== null}
        user={user}
      />,
    );
  }

  it("does not offer Approve while evaluating, but keeps request-changes and comment", () => {
    const html = renderAs("evaluating", signedIn);
    expect(html).not.toContain('value="approve"');
    expect(html).toContain('value="request_changes"');
    expect(html).toContain('value="comment"');
    expect(html).toContain("Approval opens once evaluation has finished");
  });

  it("offers Approve once the verdict is in", () => {
    expect(renderAs("accepted", signedIn)).toContain('value="approve"');
  });

  it("never auto-refreshes a page a signed-in viewer can type into, and links a refresh instead", () => {
    for (const status of ["evaluating", "open"]) {
      const html = renderAs(status, signedIn);
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).toContain(`href="/changes/${baseChange.id}">Refresh</a>`);
    }
  });

  it("auto-refreshes for a signed-out viewer, who has no form to lose", () => {
    const html = renderAs("evaluating", null);
    expect(html).toContain('http-equiv="refresh"');
    expect(html).not.toContain(">Refresh</a>");
  });

  it("neither refreshes nor links a refresh once the verdict is in", () => {
    const html = renderAs("accepted", signedIn);
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain(">Refresh</a>");
  });
});

describe("ChangeDetailPage: what the change is", () => {
  const run = (id: string, type: string, passed: boolean, ranAt: string, roundId: string) => ({
    id,
    evaluatorType: type,
    score: passed ? 1 : 0,
    passed,
    reason: `${type} ${passed ? "ok" : "broke"}`,
    ranAt,
    roundId,
  });
  const first = "2026-11-10T01:33:59.008Z";
  const second = "2026-11-10T02:46:24.166Z";
  const twoRounds = [
    run("e1", "secret_scan", true, first, "r1"),
    run("e2", "llm", false, first, "r1"),
    run("e3", "secret_scan", true, second, "r2"),
    run("e4", "llm", true, second, "r2"),
  ];
  const diff = [
    { path: "docs/log.md", additions: 34, deletions: 0, lines: [] },
    { path: "README.md", additions: 2, deletions: 1, lines: [] },
  ];
  const commits = [
    { oid: "b".repeat(40), subject: "Fix a typo", authorName: "Ada", authoredAt: second },
    {
      oid: "a".repeat(40),
      subject: "Start the friction log",
      authorName: "Ada",
      authoredAt: first,
    },
  ];

  function page(props: Partial<Parameters<typeof ChangeDetailPage>[0]> = {}): string {
    return renderToString(
      <ChangeDetailPage
        change={{ ...baseChange, status: "accepted" }}
        evalRuns={[]}
        provenance={null}
        user={null}
        {...props}
      />,
    );
  }

  it("heads the page with the change's first commit, and keeps the id beneath it", () => {
    const html = page({
      diff,
      diffContext: { commits, behindBy: 0, forkPoint: "f".repeat(40), branch: "main" },
    });
    expect(html).toMatch(/<h1>Start the friction log /);
    expect(html).toContain("chg_test123");
  });

  it("falls back to naming the workspace when the commits are not known", () => {
    expect(page()).toMatch(/<h1>Change from workspace fix-bug /);
  });

  it("says who opened the change and which agent wrote it", () => {
    const html = page({
      change: {
        ...baseChange,
        status: "accepted",
        openedBy: "ada",
        agentId: "agt_1",
        agentModel: "claude-fable-5-2",
      },
    });
    expect(html).toContain("opened by ada");
    expect(html).toContain("agt_1");
    expect(html).toContain("claude-fable-5-2");
  });

  it("totals the diff and lists the commits", () => {
    const html = page({
      diff,
      diffContext: { commits, behindBy: 0, forkPoint: "f".repeat(40), branch: "main" },
    });
    expect(html).toContain("2 files changed, +36 −1, in 2 commits");
    expect(html).toContain("Fix a typo");
    expect(html).toContain("aaaaaaaaaaaa");
    expect(html).not.toContain("behind main");
  });

  it("says when the workspace is behind and what the diff is taken from", () => {
    const html = page({
      diff,
      diffContext: {
        commits,
        behindBy: 3,
        forkPoint: "5604f6456e6f".padEnd(40, "0"),
        branch: "main",
      },
    });
    expect(html).toContain("The workspace is 3 commits behind main");
    expect(html).toContain("5604f6456e6f");
  });

  it("shows the latest evaluation on its own and folds earlier ones away", () => {
    const html = page({
      change: { ...baseChange, status: "accepted", evaluatedSha: "afc6556feaf2c8b8673e" },
      evalRuns: twoRounds,
    });
    const [latest, earlier] = html.split("earlier-runs");
    expect(latest).toContain("llm ok");
    expect(latest).not.toContain("llm broke");
    expect(latest).toContain("of revision");
    expect(latest).toContain("afc6556feaf2");
    expect(earlier).toContain("1 earlier evaluation, replaced by the one above");
    expect(earlier).toContain("llm broke");
  });

  it("has no earlier-evaluations fold for a change evaluated once", () => {
    expect(page({ evalRuns: twoRounds.slice(2) })).not.toContain("earlier-runs");
  });

  it("groups rows without a round id by when they ran", () => {
    const legacy = twoRounds.map(({ roundId: _roundId, ...rest }) => rest);
    const { latest, earlier } = splitEvalRounds(legacy);
    expect(latest.map((r) => r.id)).toEqual(["e3", "e4"]);
    expect(earlier.map((round) => round.map((r) => r.id))).toEqual([["e1", "e2"]]);
  });

  it("tells a reader of a promoted change where review and merging happen", () => {
    const html = page({
      change: {
        ...baseChange,
        status: "promoted",
        githubPrUrl: "https://github.com/acme/api/pull/42",
        githubPrNumber: 42,
      },
    });
    expect(html).toContain("promoted to GitHub");
    expect(html).toContain("pull request #");
    expect(html).toContain("Review and merging happen there");
  });

  it("offers one merge button, and only to someone who can merge", () => {
    expect(page({ canReview: false })).not.toContain("/merge");
    expect(page({ canReview: true }).split("/merge").length - 1).toBe(1);
  });

  it("offers no merge into Stratum once the change has a pull request", () => {
    const html = page({
      canReview: true,
      change: {
        ...baseChange,
        status: "promoted",
        githubPrUrl: "https://github.com/acme/api/pull/42",
        githubPrNumber: 42,
      },
    });
    expect(html).not.toContain("/merge");
  });

  it("takes the latest round by round id when two rounds ran in the same millisecond", () => {
    const ranAt = "2026-01-01T03:00:00.000Z";
    const run = (id: string, roundId: string) => ({
      id,
      roundId,
      ranAt,
      evaluatorType: "llm",
      passed: true,
      score: 1,
      reason: id,
    });
    const { latest, earlier } = splitEvalRounds([
      run("second", `${ranAt}#evr_b`),
      run("first", `${ranAt}#evr_a`),
    ]);
    expect(latest.map((r) => r.id)).toEqual(["second"]);
    expect(earlier.map((round) => round.map((r) => r.id))).toEqual([["first"]]);
    const reversed = splitEvalRounds([
      run("first", `${ranAt}#evr_a`),
      run("second", `${ranAt}#evr_b`),
    ]);
    expect(reversed.latest.map((r) => r.id)).toEqual(["second"]);
  });
});
