/**
 * The one way to send product analytics.
 *
 * ## Why this class exists
 *
 * Export is governed by two independent gates, and until this file they lived
 * in two different places:
 *
 * - The **instance** switch (`STRATUM_TELEMETRY_DISABLED`, or simply no
 *   `POSTHOG_API_KEY`) travelled with the transport, so every call site got it
 *   for free.
 * - The **per-user opt-out** (#257) did not. Each call site had to remember to
 *   consult the acting user's preference itself.
 *
 * That asymmetry is exactly how the queue exporter once shipped without an
 * opt-out at all: it was a second `capture()` call site, and second call sites
 * do not inherit a rule that lives in the first one's body.
 *
 * `AnalyticsTracker` closes that hole structurally rather than by comment.
 * There is no public constructor, and every factory below must produce an
 * `AnalyticsActor` — a value that cannot be built without an opt-out decision
 * already made. A caller therefore cannot reach `capture()` without having
 * resolved the preference, and no future call site can reintroduce the bug by
 * forgetting a rule it never had to know about.
 *
 * ## Failing closed
 *
 * Where the preference must be looked up (queue and cron paths, which have no
 * request and no auth context), an unresolved lookup suppresses the event. A
 * privacy control that exports whenever D1 hiccups is not a privacy control.
 */
import type { Context } from "hono";
import { getAgent } from "../storage/agents";
import type { EventRecord } from "../storage/events";
import { getUser } from "../storage/users";
import type { Env } from "../types";
import { getWaitUntil } from "../utils/execution-ctx";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";
import {
  type ActorKind,
  type AnalyticsProperties,
  type SurfaceEventName,
  type SurfaceEventProperties,
  domainEventName,
  domainEventProperties,
} from "./events";
import { type PostHogClient, createPostHogClient } from "./posthog";

/**
 * Who an event is attributed to, with their telemetry preference already
 * resolved.
 *
 * Constructing one is the act of deciding whether export is permitted, which
 * is why nothing outside this module builds a tracker without one.
 */
export interface AnalyticsActor {
  /**
   * PostHog `distinct_id` — always the **person**, never a credential.
   *
   * An agent is not a person. It is a token a human minted, acting under that
   * human's account: the owner's opt-out already governs it, and their identity
   * is what "who did this" means. Giving each agent its own distinct id would
   * mint a person profile per token, which splits one human's history across
   * several profiles, inflates the billed person count, and makes every user
   * count, funnel, and retention curve wrong by however many agents happen to
   * be running. So an agent's events are attributed to its owner, and
   * `agentId` below preserves the breakdown that would otherwise be lost.
   */
  distinctId: string;
  kind: ActorKind | "system";
  /**
   * The acting agent, when one is acting. Rides every event as `agent_id` so
   * "which agent did this" stays answerable without agents becoming people.
   */
  agentId?: string;
  /** The resolved preference. `true` suppresses every capture on this tracker. */
  optedOut: boolean;
  /**
   * Whether this actor is a real, identified person or agent.
   *
   * Unattributed traffic (`server`, `system`) would otherwise accrete onto one
   * shared person profile that means nothing and inflates billed person count,
   * so those events are captured personless.
   */
  attributed: boolean;
}

/** The sentinel distinct id for an unauthenticated request. */
export const ANONYMOUS_DISTINCT_ID = "server";

/** The sentinel distinct id for an event no person caused. */
export const SYSTEM_DISTINCT_ID = "system";

/** An actor that permits nothing. Returned wherever a preference cannot be established. */
const SUPPRESSED_ACTOR: AnalyticsActor = {
  distinctId: SYSTEM_DISTINCT_ID,
  kind: "system",
  optedOut: true,
  attributed: false,
};

class AnalyticsTracker {
  private constructor(
    private readonly client: PostHogClient,
    private readonly actor: AnalyticsActor,
    /** Instance-wide properties attached to every event; see `instanceProperties`. */
    private readonly instance: AnalyticsProperties,
    /** Schedules background work when the runtime offers it. */
    private readonly waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  ) {}

  /**
   * Send one surface event.
   *
   * Never rejects and never throws: analytics must not be able to fail a
   * request or a queue handler. The returned promise is there for callers that
   * genuinely want to await delivery (the queue consumer, and tests); request
   * paths can ignore it, because when a `waitUntil` is available the tracker
   * has already handed the promise to it.
   */
  capture<K extends SurfaceEventName>(
    name: K,
    properties: SurfaceEventProperties[K],
    /**
     * Person properties to record the first time this person is seen.
     *
     * `$set_once`, never `$set`: these describe how someone arrived, so the
     * first answer is the true one and a later event must not overwrite it.
     * Only ever non-identifying — see `captureAuthCompleted`, the one caller.
     */
    setOnce?: AnalyticsProperties,
  ): Promise<void> {
    return this.send(name, properties as AnalyticsProperties, { ...(setOnce ? { setOnce } : {}) });
  }

  /**
   * Send the analytics twin of a durable outbox event.
   *
   * Property selection lives in `domainEventProperties`, which whitelists the
   * safe and useful fields per event type; everything else in the payload is
   * dropped by construction.
   */
  captureDomainEvent(event: EventRecord): Promise<void> {
    return this.send(
      domainEventName(event.type),
      {
        // The concrete project name is never sent: it identifies private source
        // as surely as a repo slug in a URL does, which the request path already
        // redacts. The opaque id groups just as well — except on rows written
        // before dual-write, which have no projectId and group under nothing.
        ...(event.projectId !== undefined ? { project_id: event.projectId } : {}),
        actor_type: event.actorType,
        ...domainEventProperties(event),
        // `createdAt`, not "now": see PostHogEvent.timestamp. A retry or the
        // stale sweep can export this minutes to hours after the fact.
      },
      { timestamp: event.createdAt },
    );
  }

  private send(
    name: string,
    properties: AnalyticsProperties,
    options: { timestamp?: string; setOnce?: AnalyticsProperties } = {},
  ): Promise<void> {
    if (this.actor.optedOut) return Promise.resolve();

    const capture = this.client.capture({
      event: name,
      distinctId: this.actor.distinctId,
      ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
      ...(options.setOnce !== undefined ? { setOnce: options.setOnce } : {}),
      properties: {
        ...this.instance,
        ...(this.actor.agentId !== undefined ? { agent_id: this.actor.agentId } : {}),
        ...properties,
        ...(this.actor.attributed ? {} : { $process_person_profile: false }),
      },
    });

    // `getWaitUntil` already returns undefined outside Workers, so this is the
    // only branch: schedule it, or leave the caller holding a promise that
    // cannot reject.
    this.waitUntil?.(capture);
    return capture;
  }

  /**
   * The single construction seam, deliberately not reachable from outside this
   * module: the class value is not exported (only its type is), so every
   * tracker in the codebase comes from one of the preference-resolving
   * factories below. A `static create` taking a caller-built actor would have
   * let any module pass `optedOut: false` and skip the resolution this class
   * exists to make unskippable — which is the comment-not-code version of the
   * guarantee, and the exact failure this design replaced.
   */
  static build(
    env: Env,
    actor: AnalyticsActor,
    waitUntil?: (promise: Promise<unknown>) => void,
  ): AnalyticsTracker {
    return new AnalyticsTracker(
      createPostHogClient(env),
      actor,
      instanceProperties(env),
      waitUntil,
    );
  }
}

/** The type is public — `webhook-delivery` and the MCP route pass trackers around. */
export type { AnalyticsTracker };

/** Module-private construction. See `AnalyticsTracker.build`. */
function createTracker(
  env: Env,
  actor: AnalyticsActor,
  waitUntil?: (promise: Promise<unknown>) => void,
): AnalyticsTracker {
  return AnalyticsTracker.build(env, actor, waitUntil);
}

/**
 * Properties describing the instance, attached to every event.
 *
 * `environment` is the one that earns its place operationally: without it a
 * staging deploy's traffic is indistinguishable from production's in the same
 * PostHog project, and every funnel is quietly wrong. It is a plain var an
 * operator sets, defaulting to `unknown` rather than guessing.
 */
function instanceProperties(env: Env): AnalyticsProperties {
  // `$lib` is not here: it identifies the transport, and the transport sets it.
  return { environment: env.STRATUM_ENVIRONMENT ?? "unknown" };
}

/**
 * A tracker for the current request.
 *
 * The preference is already in the request context: every path that
 * authenticates a caller publishes it alongside the identity — `authMiddleware`
 * for the API and UI, and git-http's own `authenticate` for the smart-HTTP
 * surface it owns. The latter sets the preference WITHOUT a userId, so
 * suppression must not be gated on attribution.
 *
 * An unauthenticated caller has no preference to honor and is captured
 * personless under the `server` sentinel.
 */
export function trackerForRequest(c: Context<{ Bindings: Env }>): AnalyticsTracker {
  const userId = c.get("userId") as string | undefined;
  const agentId = c.get("agentId") as string | undefined;
  // `authMiddleware` resolves the owner to read their opt-out, and publishes it
  // — so the person behind an agent request is already in hand here.
  const agentOwnerId = c.get("agentOwnerId") as string | undefined;
  const optedOut = c.get("telemetryOptOut") === true;

  const distinctId = userId ?? agentOwnerId ?? ANONYMOUS_DISTINCT_ID;
  const kind: ActorKind = userId ? "user" : agentId ? "agent" : "anonymous";
  // An agent whose owner could not be resolved has no person to attribute to.
  // It is captured personless rather than minting a profile for a credential.
  const attributed = distinctId !== ANONYMOUS_DISTINCT_ID;

  return createTracker(
    c.env,
    {
      distinctId,
      kind,
      optedOut,
      attributed,
      ...(agentId !== undefined ? { agentId } : {}),
    },
    getWaitUntil(c),
  );
}

/**
 * A tracker for a specific user, for flows that establish an identity rather
 * than arrive with one.
 *
 * Sign-up and sign-in run before any middleware has an authenticated context
 * to publish, so the preference is read directly. A brand-new account has
 * never expressed one, which is the opt-in default — the same default the
 * settings page starts from.
 */
export async function trackerForUser(
  env: Env,
  userId: string,
  logger: Logger,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<AnalyticsTracker> {
  const user = await getUser(env.DB, userId, logger);
  if (!user.success) {
    logger.warn("User lookup failed for telemetry preference; suppressing event", { userId });
    return createTracker(env, SUPPRESSED_ACTOR, waitUntil);
  }
  return createTracker(
    env,
    {
      distinctId: userId,
      kind: "user",
      optedOut: user.data.telemetryOptOut === true,
      attributed: true,
    },
    waitUntil,
  );
}

/**
 * A tracker for the actor recorded on a durable outbox event.
 *
 * Unlike the request path — where the flag rides the `users` row the auth
 * middleware already loaded — a queue consumer has no request and no auth
 * context, so it must look the actor up. That costs one read for a
 * user-authored event and two for an agent-authored one, against the 4+ D1
 * operations the consumer already performs per message.
 *
 * An agent acts under its owner's account, so the owner's choice governs it.
 * A system-authored event has no person behind it: there is no preference to
 * honor and nothing person-identifying to suppress, so it is captured
 * personless under the `system` sentinel.
 */
export async function trackerForEventActor(
  env: Env,
  event: EventRecord,
  logger: Logger,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<AnalyticsTracker> {
  if (event.actorType === "system") {
    return createTracker(
      env,
      {
        distinctId: SYSTEM_DISTINCT_ID,
        kind: "system",
        optedOut: false,
        attributed: false,
      },
      waitUntil,
    );
  }

  // A user- or agent-authored row with no actor id: `change-flow.ts` builds
  // `{ type: "user" }` with the id omitted when it has none. Treating that as
  // system-authored would export a real person's activity under the `system`
  // sentinel with no preference consulted — the opt-out defeated by a missing
  // field. There is an actor and no way to reach their choice, so fail closed,
  // exactly as an unresolvable lookup does below.
  if (!event.actorId) {
    logger.warn("Event actor has no id; suppressing analytics export", {
      eventId: event.id,
      actorType: event.actorType,
    });
    return createTracker(env, SUPPRESSED_ACTOR, waitUntil);
  }

  let ownerId = event.actorId;
  if (event.actorType === "agent") {
    const agent = await getAgent(env.DB, event.actorId, logger);
    if (!agent.success) {
      logger.warn("Agent lookup failed for telemetry preference; suppressing event", {
        eventId: event.id,
        actorId: event.actorId,
      });
      return createTracker(env, SUPPRESSED_ACTOR, waitUntil);
    }
    ownerId = agent.data.ownerId;
  }

  const owner = await getUser(env.DB, ownerId, logger);
  if (!owner.success) {
    logger.warn("User lookup failed for telemetry preference; suppressing event", {
      eventId: event.id,
      ownerId,
    });
    return createTracker(env, SUPPRESSED_ACTOR, waitUntil);
  }

  return createTracker(
    env,
    {
      // The owner, not the acting agent — see `AnalyticsActor.distinctId`. For
      // a user-authored event `ownerId` is the actor itself, so this is the
      // same id either way.
      distinctId: ownerId,
      kind: event.actorType,
      optedOut: owner.data.telemetryOptOut === true,
      attributed: true,
      ...(event.actorType === "agent" ? { agentId: event.actorId } : {}),
    },
    waitUntil,
  );
}

/**
 * A tracker for work no person initiated — cron sweeps, queue consumers
 * reporting on themselves.
 *
 * There is no actor and therefore no preference to consult, so this is the one
 * factory that needs no lookup. Everything it sends is personless and must
 * describe the instance's own behaviour, never a user's.
 */
export function trackerForSystem(
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
): AnalyticsTracker {
  return createTracker(
    env,
    { distinctId: SYSTEM_DISTINCT_ID, kind: "system", optedOut: false, attributed: false },
    waitUntil,
  );
}

/** A logger for analytics call sites that have none of their own. */
export const analyticsLogger = createLogger({ component: "Analytics" });
