/**
 * The catalog of every event Stratum can export to PostHog, and the exact
 * properties each one carries.
 *
 * This file exists because Stratum is open source and self-hosted. "What
 * leaves my instance?" has to be answerable by reading ONE file, not by
 * grepping for `capture(` and trusting that nobody added a sixth call site
 * with a project name in it. `tests/analytics-catalog.test.ts` asserts that
 * the public FAQ documents exactly the names declared here, so the answer a
 * self-hoster reads cannot drift from the code that sends.
 *
 * The privacy rule every entry obeys: **a property is either a source-code
 * literal or a bounded enum**. Never a name, path, URL, title, ref, or
 * free-text message. Opaque ids (project UUIDs, the actor id used as
 * `distinctId`) are the sole exception — they group events without describing
 * anything, and the FAQ says so. When adding a property, ask what a stranger
 * holding only the PostHog project could learn; if the answer names a private
 * repository, it does not go in.
 */
import type { StratumEvent } from "../queue/events";
import type { EventRecord } from "../storage/events";

/** A property bag PostHog accepts. Deliberately scalar-only — see the file docblock. */
export type AnalyticsProperties = Record<string, string | number | boolean>;

/**
 * Which surface served a request.
 *
 * Cheap to derive from the matched route pattern and the single most useful
 * split in the whole dataset: "is Stratum being driven by humans in the UI, by
 * scripts against the REST API, by git itself, or by a model over MCP" is the
 * product question, and `route` alone answers it only if you already know
 * every prefix by heart.
 */
export type RequestSurface = "api" | "ui" | "git" | "mcp" | "auth" | "admin" | "internal";

/** How a caller was identified, for segmenting human vs agent vs public traffic. */
export type ActorKind = "user" | "agent" | "anonymous";

/** The outcome of one MCP exchange, mirroring `describeMcpOutcome`'s classification. */
export type McpOutcomeKind = "ok" | "tool_error" | "rejected";

/** Whether an authentication attempt created an account or resumed one. */
export type AuthKind = "signup" | "signin";

/** Identity providers Stratum can authenticate against. */
export type AuthProvider = "github" | "google" | "email";

/** Terminal state of a background job, for reliability dashboards. */
export type JobOutcome = "succeeded" | "failed" | "abandoned";

/**
 * Events that describe a *surface* — something a caller did to the instance,
 * as opposed to something that happened to a repository.
 *
 * Keys are the literal event names sent to PostHog.
 */
export interface SurfaceEventProperties {
  /** One per served request that matched a route. See `analyticsMiddleware`. */
  api_request: {
    method: string;
    /** The matched route PATTERN (`/:namespace/:slug/files`), never the concrete path. */
    route: string;
    status: number;
    latency_ms: number;
    surface: RequestSurface;
    actor_type: ActorKind;
  };
  /** One per JSON-RPC message handled by the remote MCP endpoint. */
  mcp_request: {
    /** JSON-RPC method: `initialize`, `tools/call`, `tools/list`, … */
    mcp_method: string;
    outcome: McpOutcomeKind;
    /** Tool name for `tools/call`. A source-code literal from `buildTools`. */
    tool?: string;
    /** Self-reported client identity from the `initialize` handshake. */
    client_name?: string;
    client_version?: string;
    protocol_version?: string;
  };
  /** One per completed sign-up or sign-in, for the acquisition funnel. */
  auth_completed: {
    kind: AuthKind;
    provider: AuthProvider;
  };
  /** One per unhandled exception reaching the error boundary. */
  error_occurred: {
    /** Matched route pattern, or `"*"` when the failure preceded routing. */
    route: string;
    method: string;
    /** Constructor name only (`TypeError`), never the message — messages quote input. */
    error_type: string;
  };
  /** One per background job reaching a terminal state, for reliability dashboards. */
  background_job_completed: {
    /** Stable job name, a source-code literal (`event-consumer`, `webhook-delivery`). */
    job: string;
    outcome: JobOutcome;
    /** Attempts made before this terminal state, where the job tracks them. */
    attempts?: number;
  };
}

export type SurfaceEventName = keyof SurfaceEventProperties;

/** Every domain event name, derived from the outbox registry so the two cannot drift. */
export type DomainEventName = `stratum.${StratumEvent["type"]}`;

/** The analytics name for an outbox event type. */
export function domainEventName(type: string): string {
  return `stratum.${type}`;
}

/**
 * Every domain event name this instance can send, as an exhaustive map.
 *
 * The names are spelled out because a type cannot be enumerated at runtime and
 * the docs-drift test needs the list. `satisfies Record<DomainEventName, true>`
 * is what keeps the list honest, and it has to be a Record rather than an
 * array: an array annotated `DomainEventName[]` only checks that each entry is
 * *a* valid name, so a new member of `StratumEvent` could be added, exported by
 * `captureDomainEvent` (which derives the name from `event.type` at runtime),
 * and never appear here or in the public FAQ. A Record demands every key.
 *
 * So: add a member to `StratumEvent` without adding it here, and this file
 * stops compiling — which is the only reason the catalog can be trusted as the
 * answer to "what leaves my instance".
 */
const DOMAIN_EVENTS = {
  "stratum.change.created": true,
  "stratum.change.evaluated": true,
  "stratum.change.merged": true,
  "stratum.change.rejected": true,
  "stratum.change.reverted": true,
  "stratum.change.commented": true,
  "stratum.change.reviewed": true,
  "stratum.project.created": true,
  "stratum.project.imported": true,
  "stratum.workspace.created": true,
  "stratum.sync.completed": true,
  "stratum.issue.opened": true,
  "stratum.issue.commented": true,
  "stratum.issue.closed": true,
  "stratum.deployment.requested": true,
  "stratum.deployment.succeeded": true,
  "stratum.deployment.failed": true,
} as const satisfies Record<DomainEventName, true>;

export const DOMAIN_EVENT_NAMES: readonly DomainEventName[] = Object.keys(
  DOMAIN_EVENTS,
) as DomainEventName[];

export const SURFACE_EVENT_NAMES: readonly SurfaceEventName[] = [
  "api_request",
  "mcp_request",
  "auth_completed",
  "error_occurred",
  "background_job_completed",
];

/**
 * Events produced by PostHog's SDK in the browser, not by this codebase.
 *
 * They are listed here for one reason: `docs/user-guide/faq.md` tells
 * self-hosters the event list is exhaustive, and a test holds that claim to
 * account. Nothing in `src/` emits these — the SDK does, once
 * `POSTHOG_PUBLIC_KEY` is set — so the list has to be maintained by hand
 * against what `src/analytics/web-snippet.ts` enables. Turning on another SDK
 * capture feature means adding its event here, or the FAQ becomes a false
 * statement about what leaves the instance.
 */
export const WEB_EVENT_NAMES: readonly string[] = [
  "$pageview",
  "$pageleave",
  "$autocapture",
  "$rageclick",
  "$identify",
  // Emitted by identify() when it links an anonymous session to a person, and
  // when it sets person properties. Not dropped, because dropping $create_alias
  // would break the anonymous-to-identified stitching identify() exists for.
  "$set",
  "$create_alias",
];

/** Every event name, for the docs-drift test and for operator reference. */
export const ALL_EVENT_NAMES: readonly string[] = [
  ...SURFACE_EVENT_NAMES,
  ...DOMAIN_EVENT_NAMES,
  ...WEB_EVENT_NAMES,
];

/** Git hosts Stratum imports from. Anything else is reported as `other`. */
const KNOWN_SOURCE_HOSTS: ReadonlyMap<string, string> = new Map([
  ["github.com", "github"],
  ["www.github.com", "github"],
  ["gitlab.com", "gitlab"],
  ["www.gitlab.com", "gitlab"],
  ["bitbucket.org", "bitbucket"],
  ["www.bitbucket.org", "bitbucket"],
]);

/**
 * Which hosted provider an import came from.
 *
 * The URL itself never ships: it names a repository, and often a private one.
 * The provider does ship, because "are imports mostly GitHub" is a real
 * roadmap question. A self-hosted GitLab collapses to `other` rather than
 * reporting its hostname, which would identify the company running it.
 */
export function importSourceProvider(sourceUrl: unknown): string {
  if (typeof sourceUrl !== "string" || sourceUrl === "") return "other";
  try {
    return KNOWN_SOURCE_HOSTS.get(new URL(sourceUrl).hostname.toLowerCase()) ?? "other";
  } catch {
    return "other";
  }
}

/** Reads a boolean out of an untyped outbox payload, or nothing if it is absent/wrong-typed. */
function boolProp(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Reads a finite number out of an untyped outbox payload. */
function numberProp(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads a payload field that is a closed set of source-code literals.
 *
 * The `allowed` list is the privacy control, not a validation nicety: it is
 * what guarantees a field can only ever emit a value this repository already
 * contains. A row written by an older deploy, or corrupted, contributes
 * nothing rather than contributing its contents.
 */
function enumProp(
  payload: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

const REVIEW_VERDICTS = ["approve", "request_changes", "comment"] as const;
const DEPLOY_TARGETS = ["cloudflare", "vercel"] as const;

/**
 * Project the safe, useful part of an outbox event's payload into analytics
 * properties.
 *
 * This function is the whole reason domain events are worth exporting. Before
 * it, every `stratum.*` event carried only its type and actor, so the data
 * could count merges but could not answer the questions the events exist to
 * answer: what fraction of changes pass evaluation, what reviewers decide,
 * which deploy targets fail, whether issues close through linked changes.
 *
 * Everything not named here is dropped by construction — workspace names,
 * commit shas, issue titles, import URLs and failure text all stay home. The
 * default is exclusion: an event type with no case below contributes no
 * payload properties at all.
 */
export function domainEventProperties(event: EventRecord): AnalyticsProperties {
  const payload = event.payload ?? {};
  const props: AnalyticsProperties = {};

  switch (event.type) {
    case "change.evaluated": {
      const score = numberProp(payload, "score");
      const passed = boolProp(payload, "passed");
      if (score !== undefined) props.score = score;
      if (passed !== undefined) props.passed = passed;
      break;
    }
    case "change.reviewed": {
      const verdict = enumProp(payload, "verdict", REVIEW_VERDICTS);
      if (verdict !== undefined) props.verdict = verdict;
      break;
    }
    case "project.imported": {
      props.source_provider = importSourceProvider(payload.sourceUrl);
      break;
    }
    case "issue.closed": {
      // Whether the close came from a linked change is the interesting bit —
      // it measures whether the auto-close path is actually used. The change
      // id itself is not sent.
      props.linked_change = typeof payload.changeId === "string";
      break;
    }
    case "deployment.requested":
    case "deployment.succeeded":
    case "deployment.failed": {
      const target = enumProp(payload, "target", DEPLOY_TARGETS);
      if (target !== undefined) props.target = target;
      props.linked_change = typeof payload.changeId === "string";
      break;
    }
    default:
      break;
  }

  return props;
}

/** Route prefixes that identify a surface, longest-match first. */
const SURFACE_PREFIXES: ReadonlyArray<readonly [string, RequestSurface]> = [
  ["/api/admin", "admin"],
  ["/api", "api"],
  ["/auth", "auth"],
  ["/mcp", "mcp"],
  ["/oauth", "auth"],
  ["/.well-known", "auth"],
];

/**
 * Classify a matched route pattern into a surface.
 *
 * Operates on the PATTERN, never the concrete path, so it inherits the
 * middleware's privacy guarantee for free. Git's smart-HTTP routes are matched
 * by their suffixes because they live at the root alongside the UI's
 * `/:namespace/:slug` pages and share its prefix exactly.
 */
export function surfaceForRoute(route: string): RequestSurface {
  if (
    route.includes("/info/refs") ||
    route.includes("/git-upload-pack") ||
    route.includes("/git-receive-pack")
  ) {
    return "git";
  }
  for (const [prefix, surface] of SURFACE_PREFIXES) {
    if (route === prefix || route.startsWith(`${prefix}/`)) return surface;
  }
  // `/health`, `/csp-report`, and the unmatched-route sentinel are not product
  // traffic; keeping them out of `ui` stops them inflating the page-view story.
  if (route === "*" || route === "/health" || route === "/csp-report") return "internal";
  return "ui";
}
