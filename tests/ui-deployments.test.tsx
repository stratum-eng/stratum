/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { Deployment, DeploymentStatus } from "../src/storage/deployments";
import type { ProjectSecretSummary } from "../src/storage/project-secrets";
import {
  DeploymentDetailPage,
  DeploymentsPage,
  deploymentStatusClass,
  formatDuration,
} from "../src/ui/pages/deployments";
import { ProjectSettingsPage } from "../src/ui/pages/project-settings";

// Task 8 of the post-merge deployments feature. Three properties this suite
// exists to hold: a secret value can never reach the HTML, the Approve button
// is the approval gate's visible half (so it must not render for someone who
// cannot pass it), and a provider `reason` is attacker-influenced text.

const project = { name: "my-repo", namespace: "@alice", slug: "my-repo" };
const user = { id: "u1", email: "alice@example.com", username: "alice" };

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep_1",
    projectId: "prj_1",
    project: "my-repo",
    commitSha: "abcdef1234567890abcdef1234567890abcdef12",
    name: "production",
    target: "vercel",
    attempt: 1,
    status: "succeeded",
    requestedByType: "system",
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderList(deployments: Deployment[], canWrite: boolean): string {
  return renderToString(
    <DeploymentsPage project={project} deployments={deployments} canWrite={canWrite} user={user} />,
  );
}

describe("formatDuration", () => {
  it("renders an em dash when the deployment has not finished", () => {
    expect(formatDuration(undefined)).toBe("—");
  });

  it("scales from milliseconds to minutes", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(95_000)).toBe("1m 35s");
  });
});

describe("deploymentStatusClass", () => {
  // "skipped" means nothing was configured to deploy, which is the normal state
  // of most projects — it must not borrow the failure palette.
  it("does not style skipped or superseded as failures", () => {
    expect(deploymentStatusClass("skipped")).toBe("badge-skipped");
    expect(deploymentStatusClass("superseded")).toBe("badge-superseded");
    expect(deploymentStatusClass("failed")).toBe("badge-failed");
    expect(deploymentStatusClass("skipped")).not.toBe(deploymentStatusClass("failed"));
  });

  it("gives every status its own visual treatment class", () => {
    const statuses: DeploymentStatus[] = [
      "pending_approval",
      "queued",
      "running",
      "succeeded",
      "failed",
      "superseded",
      "skipped",
    ];
    for (const status of statuses) {
      expect(deploymentStatusClass(status)).toMatch(/^badge-/);
    }
  });
});

describe("DeploymentsPage — empty state", () => {
  const html = renderList([], true);

  it("explains how to configure a deployment instead of rendering a blank table", () => {
    expect(html).not.toContain("<table");
    expect(html).toContain("No deployments yet");
    expect(html).toContain(".stratum/policy.yaml");
    expect(html).toContain("deploys:");
  });
});

describe("DeploymentsPage — actions", () => {
  it("offers Approve only on a pending_approval row", () => {
    const pending = renderList([makeDeployment({ status: "pending_approval" })], true);
    expect(pending).toContain(">Approve<");
    expect(pending).toContain('action="/api/deployments/dep_1/approve"');

    for (const status of ["queued", "running", "succeeded", "failed", "skipped"] as const) {
      expect(renderList([makeDeployment({ status })], true)).not.toContain(">Approve<");
    }
  });

  it("hides Approve from a reader who could not pass the gate", () => {
    const html = renderList([makeDeployment({ status: "pending_approval" })], false);
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain("/approve");
  });

  it("offers Retry only on a terminal row", () => {
    for (const status of ["succeeded", "failed", "superseded", "skipped"] as const) {
      const html = renderList([makeDeployment({ status })], true);
      expect(html, status).toContain(">Retry<");
      expect(html, status).toContain('action="/api/deployments/dep_1/retry"');
    }
    // A queued, running or pending row still has a future; retrying one would
    // publish the same commit twice or route around the approval gate.
    for (const status of ["queued", "running", "pending_approval"] as const) {
      expect(renderList([makeDeployment({ status })], true), status).not.toContain(">Retry<");
    }
  });

  it("hides Retry from a non-writer", () => {
    expect(renderList([makeDeployment({ status: "failed" })], false)).not.toContain(">Retry<");
  });
});

describe("DeploymentsPage — rows", () => {
  const html = renderList(
    [makeDeployment({ status: "failed", durationMs: 2500, attempt: 2 })],
    true,
  );

  it("shows status, name, target, short commit and duration", () => {
    expect(html).toContain("badge-failed");
    expect(html).toContain("production");
    expect(html).toContain("vercel");
    expect(html).toContain("abcdef1");
    expect(html).toContain("2.5s");
    expect(html).toContain("attempt 2");
  });

  it("links each row to its detail view", () => {
    expect(html).toContain('href="/@alice/my-repo/deployments/dep_1"');
  });
});

describe("DeploymentDetailPage", () => {
  function renderDetail(deployment: Deployment, canWrite = true): string {
    return renderToString(
      <DeploymentDetailPage
        project={project}
        deployment={deployment}
        canWrite={canWrite}
        user={user}
      />,
    );
  }

  it("escapes a reason containing HTML rather than injecting it", () => {
    const html = renderDetail(
      makeDeployment({ status: "failed", reason: '<script>alert("xss")</script>' }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a log tail containing HTML", () => {
    const html = renderDetail(
      makeDeployment({ status: "failed", logTail: "<img src=x onerror=boom>" }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("renders the log tail only when the caller was served one", () => {
    // The route strips `logTail` for non-writers, so the page must render
    // correctly with the field simply absent.
    const withoutTail = renderDetail(makeDeployment({ status: "failed" }), false);
    expect(withoutTail).not.toContain("Log tail");
    expect(withoutTail).not.toContain("deploy-log");

    const withTail = renderDetail(makeDeployment({ status: "failed", logTail: "boom" }));
    expect(withTail).toContain("Log tail");
    expect(withTail).toContain("boom");
  });

  it("shows the deployment URL and the full commit", () => {
    const html = renderDetail(makeDeployment({ url: "https://example.vercel.app" }));
    expect(html).toContain("https://example.vercel.app");
    expect(html).toContain("abcdef1234567890abcdef1234567890abcdef12");
  });

  it("offers Approve on a pending row and Retry on a terminal one", () => {
    expect(renderDetail(makeDeployment({ status: "pending_approval" }))).toContain(">Approve<");
    expect(renderDetail(makeDeployment({ status: "failed" }))).toContain(">Retry<");
    expect(renderDetail(makeDeployment({ status: "running" }))).not.toContain(">Retry<");
  });
});

describe("ProjectSettingsPage — deploy secrets", () => {
  const secrets: ProjectSecretSummary[] = [
    {
      name: "VERCEL_TOKEN",
      createdBy: "u1",
      updatedBy: "u1",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-02T10:00:00.000Z",
    },
  ];
  const settingsProject = { ...project, createdAt: "2026-01-01T00:00:00.000Z" };

  function renderSettings(canManageSecrets: boolean): string {
    return renderToString(
      <ProjectSettingsPage
        project={settingsProject}
        isOwner={true}
        secrets={secrets}
        canManageSecrets={canManageSecrets}
        user={user}
      />,
    );
  }

  it("lists names and metadata but never a value", () => {
    const html = renderSettings(true);
    expect(html).toContain("VERCEL_TOKEN");
    expect(html).toContain("2026-09-02T10:00:00.000Z");
    // The add form's value field is write-only: no `value=` attribute anywhere
    // on it, because nothing in the codebase can read a stored secret back.
    expect(html).toContain('type="password"');
    expect(html).not.toMatch(/name="value"[^>]*\svalue=/);
  });

  it("offers add and delete, and nothing that could reveal a value", () => {
    const html = renderSettings(true);
    expect(html).toContain('action="/api/projects/@alice/my-repo/secrets"');
    expect(html).toContain('action="/api/projects/@alice/my-repo/secrets/VERCEL_TOKEN/delete"');
    expect(html).not.toContain("Reveal");
    expect(html).not.toContain("Show value");
  });

  it("hides the whole section from someone who may not manage secrets", () => {
    const html = renderSettings(false);
    expect(html).not.toContain("Deploy secrets");
    expect(html).not.toContain("VERCEL_TOKEN");
  });

  it("links to the deployments page", () => {
    expect(renderSettings(true)).toContain('href="/@alice/my-repo/deployments"');
  });

  it("surfaces a failed add without echoing anything the caller supplied", () => {
    const html = renderToString(
      <ProjectSettingsPage
        project={settingsProject}
        isOwner={true}
        secrets={[]}
        canManageSecrets={true}
        secretError="A secret value is required."
        user={user}
      />,
    );
    expect(html).toContain("A secret value is required.");
  });

  // A failed listing rendered as "no secrets" reads as "you have none" when the
  // truth is "we could not tell" — an admin acting on it would re-paste
  // credentials that are already stored.
  it("distinguishes a failed secret listing from an empty one", () => {
    const html = renderToString(
      <ProjectSettingsPage
        project={settingsProject}
        isOwner={true}
        secrets={[]}
        secretsUnavailable={true}
        canManageSecrets={true}
        user={user}
      />,
    );

    expect(html).not.toContain("No deploy secrets stored for this project.");
    expect(html).toContain("Could not load this project");
    expect(html).toContain("settings-help-error");
  });

  it("still says 'none stored' when the listing succeeded and was empty", () => {
    const html = renderToString(
      <ProjectSettingsPage
        project={settingsProject}
        isOwner={true}
        secrets={[]}
        canManageSecrets={true}
        user={user}
      />,
    );

    expect(html).toContain("No deploy secrets stored for this project.");
    expect(html).not.toContain("Could not load this project");
  });

  it("prefers the stored names over the error state when the listing worked", () => {
    const html = renderToString(
      <ProjectSettingsPage
        project={settingsProject}
        isOwner={true}
        secrets={secrets}
        secretsUnavailable={false}
        canManageSecrets={true}
        user={user}
      />,
    );

    expect(html).toContain("VERCEL_TOKEN");
    expect(html).not.toContain("Could not load this project");
  });
});
