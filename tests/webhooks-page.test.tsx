import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { WebhooksPage } from "../src/ui/pages/webhooks";

const project = { name: "api", namespace: "@alice", slug: "api" };

const render = (withWebhook: boolean): string =>
  renderToString(
    <WebhooksPage
      project={project}
      webhooks={
        withWebhook
          ? [
              {
                webhook: {
                  id: "wh_1",
                  project: "api",
                  projectId: "proj_alice",
                  url: "https://alice.example.com/hook",
                  events: "*",
                  active: true,
                  createdBy: "user_test",
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
                deliveries: [],
              },
            ]
          : []
      }
      subscribableEvents={["change.created"]}
      user={{ id: "user_test", email: "t@x.io", username: "test" }}
      nonce="test-nonce"
    />,
  );

describe("webhooks management page — regenerate secret", () => {
  it("offers a per-webhook regenerate action guarded by a nonce'd confirm", () => {
    const html = render(true);
    expect(html).toContain('action="/api/projects/@alice/api/webhooks/wh_1/regenerate-secret"');
    expect(html).toContain("Regenerate secret");
    // The confirm is wired by a CSP-nonce'd script, not an inline handler.
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain("webhook-regenerate-form");
    expect(html).not.toMatch(/onsubmit=/i);
  });

  it("renders no confirm script when there are no webhooks", () => {
    expect(render(false)).not.toContain("webhook-regenerate-form");
  });
});
