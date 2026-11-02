import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { ImportStatus } from "../src/types";
import { ImportProgressCard } from "../src/ui/components/import-progress";
import { RepoPage } from "../src/ui/pages/repo";

const baseProject = {
  name: "my-repo",
  namespace: "@alice",
  slug: "my-repo",
  remote: "git@stratum:alice/my-repo.git",
  createdAt: "2024-01-01T00:00:00Z",
};

const baseRepoProps = {
  files: [],
  log: [],
  readme: null,
  user: null,
  importProgress: null,
  syncStatus: null,
  canSync: false,
  nonce: "test-nonce",
};

/**
 * #304: an empty repo showed a live "Sync Now" button next to "Not synced" and
 * an in-progress import badge. Content is the gate that makes those claims
 * consistent — the same one the pull-request card already used.
 */
describe("RepoPage — Sync Now content gate", () => {
  const syncable = {
    ...baseProject,
    sourceUrl: "https://github.com/acme/api",
    sourceProvider: "github" as const,
  };

  it("offers Sync Now when the repo has content", () => {
    const html = renderToString(
      <RepoPage {...baseRepoProps} project={syncable} canSync={true} files={["README.md"]} />,
    );
    expect(html).toContain("Sync Now");
  });

  it("hides Sync Now on an empty repo even when the project is syncable", () => {
    const html = renderToString(
      <RepoPage {...baseRepoProps} project={syncable} canSync={true} files={[]} />,
    );
    expect(html).not.toContain("Sync Now");
  });

  // A failed listing yields no files too, but that is when a user most needs
  // the retry path — it must not be mistaken for an empty repository.
  it("keeps Sync Now when the file listing failed rather than the repo being empty", () => {
    const html = renderToString(
      <RepoPage
        {...baseRepoProps}
        project={syncable}
        canSync={true}
        files={[]}
        filesUnavailable={true}
      />,
    );
    expect(html).toContain("Sync Now");
  });

  it("still hides Sync Now when the user lacks sync permission", () => {
    const html = renderToString(
      <RepoPage {...baseRepoProps} project={syncable} canSync={false} files={["README.md"]} />,
    );
    expect(html).not.toContain("Sync Now");
  });
});

function renderImport(status: ImportStatus): string {
  return renderToString(
    <ImportProgressCard
      namespace="@alice"
      slug="my-repo"
      status={status}
      progress={{ processedFiles: 0 }}
      logs={[]}
      errors={[]}
      sourceUrl="https://github.com/acme/api"
      branch="main"
      nonce="test-nonce"
    />,
  );
}

// Before migration 043 the 'syncing' status could not be stored, so the card
// never had to render it. Now that the consumer's sync-phase write lands, a
// syncing job must read as active — otherwise it shows no spinner, no Cancel,
// and no live refresh, which looks exactly like the wedge this PR fixes.
describe("ImportProgressCard — active statuses", () => {
  for (const status of ["queued", "cloning", "processing", "syncing"] as const) {
    it(`renders '${status}' as an in-progress import`, () => {
      const html = renderImport(status);
      expect(html).toContain("Cancel Import");
      expect(html).toContain("/import/cancel");
    });
  }

  it("shows progress for a syncing job rather than an empty bar", () => {
    expect(renderImport("syncing")).toContain("75%");
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`does not offer Cancel for a '${status}' job`, () => {
      expect(renderImport(status)).not.toContain("Cancel Import");
    });
  }
});

describe("ImportProgressCard — Delete import action", () => {
  for (const status of ["failed", "cancelled"] as const) {
    it(`offers Delete import for a '${status}' job`, () => {
      const html = renderImport(status);
      expect(html).toContain("Delete import");
      expect(html).toContain("/import/delete");
    });
  }

  // Not terminal: the queue consumer may still own the row.
  it("does not offer Delete import while a cancel is still in flight", () => {
    const html = renderImport("cancelling");
    expect(html).not.toContain("Delete import");
    expect(html).toContain("Retry import");
  });

  for (const status of ["queued", "cloning", "processing", "syncing"] as const) {
    it(`does not offer Delete import for an active '${status}' job`, () => {
      const html = renderImport(status);
      expect(html).not.toContain("Delete import");
    });
  }

  it("keeps Retry available alongside Delete", () => {
    const html = renderImport("failed");
    expect(html).toContain("Retry import");
    expect(html).toContain("Delete import");
  });
});
