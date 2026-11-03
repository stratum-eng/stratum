import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { ChangeDetailPage } from "../src/ui/pages/change-detail";

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
