import type { FC } from "hono/jsx";
import type { EventRecord } from "../../storage/events";
import { Layout } from "../layout";

interface ActivityProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
  };
  events: EventRecord[];
  user?: { id: string; email: string; username: string } | null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Outcome-oriented one-liner for an event, e.g. "Change chg_1 evaluated → 0.91 passed". */
export function describeEvent(event: EventRecord): string {
  const { payload } = event;
  const changeId = asString(payload.changeId);
  const workspace = asString(payload.workspace);
  const commit = asString(payload.commit);

  switch (event.type) {
    case "project.created":
      return "Project created";
    case "project.imported": {
      const source = asString(payload.sourceUrl);
      return source ? `Imported from ${source.replace(/^https?:\/\//, "")}` : "Project imported";
    }
    case "workspace.created":
      return workspace ? `Workspace ${workspace} created` : "Workspace created";
    case "change.created":
      return `Change ${changeId ?? "?"} opened${workspace ? ` from ${workspace}` : ""}`;
    case "change.evaluated": {
      const score = typeof payload.score === "number" ? payload.score.toFixed(2) : "?";
      const verdict = payload.passed === true ? "passed" : "failed";
      return `Change ${changeId ?? "?"} evaluated → ${score} ${verdict}`;
    }
    case "change.merged":
      return `Change ${changeId ?? "?"} merged${commit ? ` → ${commit.slice(0, 7)}` : ""}`;
    case "change.rejected":
      return `Change ${changeId ?? "?"} rejected`;
    case "sync.completed":
      return `Synced from upstream${commit ? ` → ${commit.slice(0, 7)}` : ""}`;
    default:
      return event.type;
  }
}

/** Coarse relative timestamp ("3h ago"); falls back to the date for older events. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return then.toLocaleDateString();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return then.toLocaleDateString();
}

function changeLink(event: EventRecord): string | undefined {
  const changeId = asString(event.payload.changeId);
  return changeId ? `/changes/${changeId}` : undefined;
}

export const ActivityPage: FC<ActivityProps> = ({ project, events, user }) => {
  return (
    <Layout title={`Activity — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>Activity</h1>
        <a class="btn" href={`/${project.namespace}/${project.slug}`}>
          Back to repo
        </a>
      </div>

      {events.length === 0 ? (
        <div class="empty-state">
          <p>No activity yet. Create a workspace or open a change to get started.</p>
        </div>
      ) : (
        <ul class="activity-list">
          {events.map((event) => {
            const link = changeLink(event);
            const description = describeEvent(event);
            return (
              <li key={event.id} class="activity-item">
                <span class={`activity-actor activity-actor-${event.actorType}`}>
                  {event.actorType}
                </span>
                <span class="activity-description">
                  {link ? <a href={link}>{description}</a> : description}
                </span>
                <span class="activity-time">{relativeTime(event.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Layout>
  );
};
