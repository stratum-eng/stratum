/**
 * The PostHog transport.
 *
 * Deliberately thin, and deliberately not the thing you should be calling.
 * Product code goes through `AnalyticsTracker` (`./tracker`), which is what
 * resolves the acting user's opt-out; this file knows only about the
 * instance-wide switch. Reaching for `createPostHogClient` directly is how the
 * per-user opt-out gets skipped — see the docblock on `AnalyticsTracker`.
 */
import { STRATUM_VERSION } from "../version";

export interface PostHogEvent {
  event: string;
  distinctId: string;
  properties?: Record<string, string | number | boolean>;
  /**
   * When the thing being reported actually happened, ISO-8601.
   *
   * Omit for anything captured inline with a request, where "now" is right.
   * Supply it for anything captured from the queue: an outbox row is exported
   * when a consumer gets to it, which a retry or the five-minute stale sweep
   * can delay well past the minute the change was actually merged. Without
   * this, those events land in the wrong bucket and every time series built on
   * them is quietly skewed toward whenever the queue drained.
   */
  timestamp?: string;
  /**
   * Person properties to set on first sight only (`$set_once`).
   *
   * Not stored on the event itself — PostHog consumes them during ingestion to
   * update the person, so they are queryable as `person.properties.*` and not
   * as event properties.
   */
  setOnce?: Record<string, string | number | boolean>;
}

export class PostHogClient {
  constructor(
    private apiKey: string,
    private host: string,
    private disabled: boolean,
  ) {}

  /** Never rejects: a telemetry failure must not surface in a request or a queue handler. */
  async capture(event: PostHogEvent): Promise<void> {
    if (this.disabled || !this.apiKey) return;
    try {
      await fetch(`${this.host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          event: event.event,
          distinct_id: event.distinctId,
          ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
          properties: {
            $lib: "stratum-server",
            // Lets a metric change be attributed to the release that caused it,
            // which is otherwise guesswork against deploy times.
            $lib_version: STRATUM_VERSION,
            ...event.properties,
            ...(event.setOnce !== undefined ? { $set_once: event.setOnce } : {}),
          },
        }),
      });
    } catch {
      // swallow
    }
  }
}

/**
 * Build a PostHog client for this environment, carrying the **instance** gate:
 * `STRATUM_TELEMETRY_DISABLED`, or the absence of an API key.
 *
 * The **per-user** opt-out (#257) is not here and must not be added here — it
 * needs an actor, and this function has none. `AnalyticsTracker` owns it, and
 * owns it in a way a new call site cannot bypass.
 */
export function createPostHogClient(env: {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  STRATUM_TELEMETRY_DISABLED?: string;
}): PostHogClient {
  const disabled = env.STRATUM_TELEMETRY_DISABLED === "true" || !env.POSTHOG_API_KEY;
  return new PostHogClient(
    env.POSTHOG_API_KEY ?? "",
    env.POSTHOG_HOST ?? "https://app.posthog.com",
    disabled,
  );
}
