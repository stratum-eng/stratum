/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { EventRecord } from "../src/storage/events";
import { ActivityPage, describeEvent, relativeTime } from "../src/ui/pages/activity";

function makeEvent(overrides: Partial<EventRecord>): EventRecord {
  return {
    id: "evt_1",
    type: "change.created",
    project: "my-project",
    actorType: "user",
    payload: {},
    status: "processed",
    attempts: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const project = { name: "my-project", namespace: "@user", slug: "my-project" };

describe("describeEvent", () => {
  it("describes change lifecycle events", () => {
    expect(
      describeEvent(
        makeEvent({ type: "change.created", payload: { changeId: "chg_1", workspace: "ws-1" } }),
      ),
    ).toBe("Change chg_1 opened from ws-1");
    expect(
      describeEvent(
        makeEvent({
          type: "change.evaluated",
          payload: { changeId: "chg_1", score: 0.91, passed: true },
        }),
      ),
    ).toBe("Change chg_1 evaluated → 0.91 passed");
    expect(
      describeEvent(
        makeEvent({
          type: "change.merged",
          payload: { changeId: "chg_1", commit: "abcdef1234567" },
        }),
      ),
    ).toBe("Change chg_1 merged → abcdef1");
    expect(
      describeEvent(makeEvent({ type: "change.rejected", payload: { changeId: "chg_1" } })),
    ).toBe("Change chg_1 rejected");
  });

  it("describes project and workspace events", () => {
    expect(describeEvent(makeEvent({ type: "project.created" }))).toBe("Project created");
    expect(
      describeEvent(
        makeEvent({ type: "project.imported", payload: { sourceUrl: "https://github.com/a/b" } }),
      ),
    ).toBe("Imported from github.com/a/b");
    expect(
      describeEvent(makeEvent({ type: "workspace.created", payload: { workspace: "ws-1" } })),
    ).toBe("Workspace ws-1 created");
    expect(
      describeEvent(makeEvent({ type: "sync.completed", payload: { commit: "abcdef1234567" } })),
    ).toBe("Synced from upstream → abcdef1");
  });

  it("falls back to the raw type for unknown events", () => {
    expect(describeEvent(makeEvent({ type: "something.else" }))).toBe("something.else");
  });

  it("tolerates missing payload fields", () => {
    expect(describeEvent(makeEvent({ type: "change.merged", payload: {} }))).toBe(
      "Change ? merged",
    );
    expect(describeEvent(makeEvent({ type: "sync.completed", payload: {} }))).toBe(
      "Synced from upstream",
    );
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-06-11T12:00:00Z");

  it("renders coarse relative times", () => {
    expect(relativeTime("2026-06-11T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-06-11T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-06-11T07:00:00Z", now)).toBe("5h ago");
    expect(relativeTime("2026-06-08T12:00:00Z", now)).toBe("3d ago");
  });

  it("falls back to a date for old or invalid timestamps", () => {
    expect(relativeTime("2025-01-01T00:00:00Z", now)).toBe(
      new Date("2025-01-01T00:00:00Z").toLocaleDateString(),
    );
    expect(relativeTime("not-a-date", now)).toBe(new Date("not-a-date").toLocaleDateString());
  });
});

describe("ActivityPage", () => {
  it("renders an empty state when there are no events", () => {
    const html = renderToString(<ActivityPage project={project} events={[]} user={null} />);
    expect(html).toContain("No activity yet");
  });

  it("renders event lines with actor badges and links changes", () => {
    const events = [
      makeEvent({
        id: "evt_1",
        type: "change.merged",
        actorType: "user",
        payload: { changeId: "chg_42", commit: "abcdef1234" },
      }),
      makeEvent({
        id: "evt_2",
        type: "workspace.created",
        actorType: "agent",
        payload: { workspace: "ws-9" },
      }),
    ];
    const html = renderToString(<ActivityPage project={project} events={events} user={null} />);

    expect(html).toContain("activity-actor-user");
    expect(html).toContain("activity-actor-agent");
    expect(html).toContain("Change chg_42 merged → abcdef1");
    expect(html).toContain('href="/changes/chg_42"');
    expect(html).toContain("Workspace ws-9 created");
  });

  it("escapes untrusted payload content", () => {
    const events = [
      makeEvent({
        type: "workspace.created",
        payload: { workspace: '<script>alert("xss")</script>' },
      }),
    ];
    const html = renderToString(<ActivityPage project={project} events={events} user={null} />);
    expect(html).not.toContain("<script>alert");
  });
});
