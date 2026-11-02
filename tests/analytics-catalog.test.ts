/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// Loaded via Vite's raw import (not node:fs) so this type-checks under the
// Workers tsconfig, matching tests/wrangler-telemetry-config.test.ts.
import FAQ from "../docs/user-guide/faq.md?raw";
import {
  ALL_EVENT_NAMES,
  DOMAIN_EVENT_NAMES,
  SURFACE_EVENT_NAMES,
  WEB_EVENT_NAMES,
  domainEventName,
  domainEventProperties,
  importSourceProvider,
  surfaceForRoute,
} from "../src/analytics/events";
import { bootstrapScript } from "../src/analytics/web-snippet";
import type { EventRecord } from "../src/storage/events";

function makeEvent(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "evt_1",
    type: "change.created",
    project: "acme/web",
    projectId: "prj_abc",
    actorType: "user",
    actorId: "user_1",
    payload: {},
    status: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("analytics catalog", () => {
  it("has no duplicate event names", () => {
    expect(new Set(ALL_EVENT_NAMES).size).toBe(ALL_EVENT_NAMES.length);
  });

  // The FAQ is the promise made to self-hosters about what leaves their
  // instance. A new event name that nobody documented is exactly the drift
  // this suite exists to catch — the code shipping more than the docs admit.
  it("documents every surface event in the public FAQ", () => {
    for (const name of SURFACE_EVENT_NAMES) {
      expect(FAQ, `\`${name}\` is missing from docs/user-guide/faq.md`).toContain(`\`${name}\``);
    }
  });

  // Browser events reach PostHog without passing through any code in `src/`,
  // so nothing else in this suite would notice them going undocumented. The
  // FAQ says the list is exhaustive; this is what makes that true rather than
  // aspirational.
  it("documents every browser event in the public FAQ", () => {
    for (const name of WEB_EVENT_NAMES) {
      expect(FAQ, `\`${name}\` is missing from docs/user-guide/faq.md`).toContain(`\`${name}\``);
    }
  });

  // The other direction. WEB_EVENT_NAMES ⊆ FAQ says the docs cover the catalog;
  // this says the catalog covers what the snippet actually lets through, so an
  // event cannot be permitted at runtime while going undocumented.
  it("documents every event the browser snippet permits", () => {
    const allowlist = /var ALLOWED_EVENTS = \{([^}]*)\}/.exec(
      bootstrapScript({
        token: "phc_x",
        apiHost: "/_ph",
        uiHost: "https://us.posthog.com",
        environment: "test",
        route: "/",
        distinctId: null,
      }),
    )?.[1];
    expect(allowlist, "could not find ALLOWED_EVENTS in the emitted snippet").toBeTruthy();
    // Not `\$`-anchored: `ui_click` is this repo's own browser event, and an
    // allowlist entry the regex cannot see is an entry this test cannot hold to
    // the FAQ.
    const permitted = [...(allowlist as string).matchAll(/([$A-Za-z_][A-Za-z_]*):\s*1/g)].map(
      (m) => m[1],
    );
    expect(permitted.length).toBeGreaterThan(0);
    for (const name of permitted) {
      expect(
        WEB_EVENT_NAMES,
        `\`${name}\` is permitted by the snippet but not in the catalog`,
      ).toContain(name);
    }
  });

  it("documents the domain event family in the public FAQ", () => {
    expect(FAQ).toContain("`stratum.<event type>`");
  });

  // Domain events whose payload contributes extra properties must say which,
  // because "an opaque project id and the actor type" is no longer the whole
  // answer for them.
  it("documents every domain event that contributes extra properties", () => {
    for (const type of [
      "change.evaluated",
      "change.reviewed",
      "project.imported",
      "issue.closed",
    ]) {
      const props = domainEventProperties(makeEvent({ type, payload: {} }));
      // These types contribute properties for at least some payloads, so the
      // FAQ must name them; the assertion below is what pins that.
      expect(FAQ, `\`${domainEventName(type)}\` is missing from the FAQ`).toContain(
        `\`${domainEventName(type)}\``,
      );
      expect(props).toBeDefined();
    }
    expect(FAQ).toContain("`stratum.deployment.*`");
  });

  it("names every outbox event type in DOMAIN_EVENT_NAMES", () => {
    // The `DomainEventName` annotation on the constant makes the compiler
    // enforce the reverse direction (no name here that is not an event type).
    // This pins the count so a new StratumEvent member cannot be added to the
    // union and silently left out of the runtime list.
    expect(DOMAIN_EVENT_NAMES).toHaveLength(17);
    for (const name of DOMAIN_EVENT_NAMES) expect(name.startsWith("stratum.")).toBe(true);
  });
});

describe("domainEventProperties", () => {
  it("exports the evaluation score and verdict — the reason the events are worth sending", () => {
    const props = domainEventProperties(
      makeEvent({ type: "change.evaluated", payload: { score: 0.82, passed: true } }),
    );
    expect(props).toEqual({ score: 0.82, passed: true });
  });

  it("exports a review verdict", () => {
    const props = domainEventProperties(
      makeEvent({ type: "change.reviewed", payload: { verdict: "request_changes" } }),
    );
    expect(props).toEqual({ verdict: "request_changes" });
  });

  it("drops a verdict that is not one of the known literals", () => {
    const props = domainEventProperties(
      makeEvent({ type: "change.reviewed", payload: { verdict: "acme-internal-policy" } }),
    );
    expect(props).toEqual({});
  });

  it("never exports a commit sha, workspace name, or issue title", () => {
    const cases: EventRecord[] = [
      makeEvent({ type: "change.merged", payload: { commit: "9f2c1ab", changeId: "ch_1" } }),
      makeEvent({ type: "change.created", payload: { workspace: "secret-refactor" } }),
      makeEvent({
        type: "issue.opened",
        payload: { title: "Prod outage at Acme", issueNumber: 7 },
      }),
    ];
    for (const event of cases) {
      expect(JSON.stringify(domainEventProperties(event))).not.toMatch(
        /9f2c1ab|secret-refactor|Acme|ch_1/,
      );
    }
  });

  it("reports whether an issue closed through a linked change, not which one", () => {
    const linked = domainEventProperties(
      makeEvent({ type: "issue.closed", payload: { changeId: "ch_42", title: "Fix login" } }),
    );
    expect(linked).toEqual({ linked_change: true });

    const manual = domainEventProperties(
      makeEvent({ type: "issue.closed", payload: { title: "Fix login" } }),
    );
    expect(manual).toEqual({ linked_change: false });
  });

  it("reports the deploy target and whether a change drove it", () => {
    const props = domainEventProperties(
      makeEvent({
        type: "deployment.failed",
        payload: {
          target: "vercel",
          changeId: "ch_9",
          commit: "abc123",
          reason: "Build failed: /home/acme/app/src/secret.ts not found",
        },
      }),
    );
    expect(props).toEqual({ target: "vercel", linked_change: true });
    // The failure reason is redacted against secrets by the runner, but it is
    // still free text naming real paths. It must not leave the instance.
    expect(JSON.stringify(props)).not.toContain("secret.ts");
  });

  it("contributes nothing for an event type with no whitelist entry", () => {
    expect(
      domainEventProperties(makeEvent({ type: "sync.completed", payload: { commit: "a" } })),
    ).toEqual({});
    expect(domainEventProperties(makeEvent({ type: "project.created", payload: {} }))).toEqual({});
  });

  it("ignores wrong-typed payload fields rather than exporting them", () => {
    const props = domainEventProperties(
      makeEvent({ type: "change.evaluated", payload: { score: "high", passed: "yes" } }),
    );
    expect(props).toEqual({});
  });

  it("drops a non-finite score", () => {
    const props = domainEventProperties(
      makeEvent({ type: "change.evaluated", payload: { score: Number.NaN, passed: false } }),
    );
    expect(props).toEqual({ passed: false });
  });
});

describe("importSourceProvider", () => {
  it("classifies the hosted providers", () => {
    expect(importSourceProvider("https://github.com/acme/web.git")).toBe("github");
    expect(importSourceProvider("https://gitlab.com/acme/web.git")).toBe("gitlab");
    expect(importSourceProvider("https://bitbucket.org/acme/web.git")).toBe("bitbucket");
  });

  it("collapses a self-hosted host to `other` rather than reporting its name", () => {
    // A self-hosted GitLab's hostname identifies the company running it.
    expect(importSourceProvider("https://git.acme-internal.example/web.git")).toBe("other");
  });

  it("never returns anything derived from the URL", () => {
    for (const url of ["not a url", "", "ssh://git@acme.example/web.git", null, 42]) {
      expect(["github", "gitlab", "bitbucket", "other"]).toContain(importSourceProvider(url));
    }
  });
});

describe("surfaceForRoute", () => {
  it("splits the product surfaces", () => {
    expect(surfaceForRoute("/api/changes/:id")).toBe("api");
    expect(surfaceForRoute("/api/admin/audit")).toBe("admin");
    expect(surfaceForRoute("/auth/github/callback")).toBe("auth");
    expect(surfaceForRoute("/mcp")).toBe("mcp");
    expect(surfaceForRoute("/oauth/authorize")).toBe("auth");
    expect(surfaceForRoute("/:namespace/:slug/changes")).toBe("ui");
  });

  it("recognises git smart-HTTP, which shares the UI's root prefix", () => {
    expect(surfaceForRoute("/:namespace/:slug/info/refs")).toBe("git");
    expect(surfaceForRoute("/:namespace/:slug/git-upload-pack")).toBe("git");
    expect(surfaceForRoute("/:namespace/:slug/workspaces/:workspace/git-receive-pack")).toBe("git");
  });

  it("keeps non-product traffic out of the page-view story", () => {
    expect(surfaceForRoute("*")).toBe("internal");
    expect(surfaceForRoute("/health")).toBe("internal");
    expect(surfaceForRoute("/csp-report")).toBe("internal");
  });

  it("does not let /api-adjacent literals fall into the api surface", () => {
    expect(surfaceForRoute("/apifoo")).toBe("ui");
  });
});
