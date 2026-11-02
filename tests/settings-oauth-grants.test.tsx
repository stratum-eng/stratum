/**
 * Issue #349: the connected-applications section of the settings page.
 *
 * The property under test is that "no applications connected" and "we could not
 * check" never render the same. One of them is a reassurance, and showing it to
 * someone whose grant listing D1 failed to return would tell them nothing can
 * reach their account when something might.
 *
 * `loadOAuthGrants` returns an empty array in BOTH cases, so the distinction
 * lives entirely in the flag threaded alongside it — which is exactly the kind
 * of thing that regresses silently without a test.
 */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { OAuthGrantSummary } from "../src/storage/oauth";
import { SettingsPage } from "../src/ui/pages/settings";

const user = {
  id: "usr_1",
  email: "alice@example.com",
  username: "alice",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function render(opts: { grants: OAuthGrantSummary[]; unavailable: boolean }): string {
  return renderToString(
    SettingsPage({
      user,
      usernameChange: "blocked",
      agents: [],
      apiTokens: [],
      oauthGrants: opts.grants,
      oauthGrantsUnavailable: opts.unavailable,
      telemetryOptOut: false,
      nonce: "test-nonce",
    }) as Parameters<typeof renderToString>[0],
  );
}

const GRANT: OAuthGrantSummary = {
  id: "mcpt_1",
  clientId: "mcpc_abc",
  clientName: "Some Editor",
  scope: "mcp:read mcp:write",
  createdAt: "2026-08-01T00:00:00.000Z",
  accessExpiresAt: "2030-01-01T00:00:00.000Z",
};

describe("connected applications", () => {
  it("says nothing is connected only when the listing actually came back empty", () => {
    const html = render({ grants: [], unavailable: false });
    expect(html).toContain("No applications connected");
    expect(html).not.toContain("could not be loaded");
  });

  it("says the listing is unavailable when the read failed", () => {
    const html = render({ grants: [], unavailable: true });
    expect(html).toContain("could not be loaded");
    // The reassurance must NOT appear: nothing here establishes that no
    // application is connected.
    expect(html).not.toContain("No applications connected");
    // And it should say what did not happen, so nobody reads it as a disconnect.
    expect(html).toContain("Nothing has been disconnected");
  });

  it("lists a grant with its client id and a disconnect control", () => {
    const html = render({ grants: [GRANT], unavailable: false });
    expect(html).toContain("Some Editor");
    // The client id is shown beside the name because the name is self-asserted
    // at registration and vetted by nobody.
    expect(html).toContain("mcpc_abc");
    expect(html).toContain("Read &amp; write");
    expect(html).toContain("/settings/connections/mcpt_1/revoke");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("No applications connected");
  });

  it("renders a read-only grant as read-only", () => {
    const html = render({
      grants: [{ ...GRANT, scope: "mcp:read" }],
      unavailable: false,
    });
    expect(html).toContain("Read-only");
  });

  it("warns that an application's name is self-asserted", () => {
    const html = render({ grants: [GRANT], unavailable: false });
    expect(html).toContain("chooses its own display name when it registers, and nobody vets it");
  });
});
