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
