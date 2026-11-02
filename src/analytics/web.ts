/**
 * Browser-side analytics: the gates, and the origins the proxy forwards to.
 *
 * ## Why this is separate from `./posthog` and `./tracker`
 *
 * `AnalyticsTracker` governs what the *server* exports, and it does so
 * structurally: its constructor is private and every factory must produce an
 * `AnalyticsActor`, so no call site can capture without first resolving the
 * acting user's opt-out. It cannot govern the browser, because the browser's
 * events are produced by PostHog's own SDK inside the user's tab — there is no
 * `capture()` call site here to route through an actor.
 *
 * So the equivalent guarantee is rebuilt on a different mechanism: this module
 * decides whether a page receives the SDK **at all**. `webAnalyticsConfig`
 * returns `null` and the caller injects nothing. An opted-out user's page has
 * no SDK in it to opt out of later, and no window in which a race could
 * capture something before a client-side check ran.
 *
 * ## Why browser analytics has its own key
 *
 * `POSTHOG_API_KEY` is a Wrangler *secret* that today means one thing to a
 * self-hoster: "export server-side route patterns." Reusing it here would
 * silently redefine it to also mean "load third-party JavaScript in your
 * users' browsers and send their IP addresses to PostHog" — for operators who
 * set it months ago and took no action since. This project is self-hostable;
 * that is not a change we get to make on their behalf.
 *
 * `POSTHOG_PUBLIC_KEY` is therefore a separate, deliberate opt-in, and a
 * `[vars]` entry rather than a secret because a value embedded in every page
 * of public HTML is not a secret and pretending otherwise invites the mistake
 * below.
 */

import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "WebAnalytics" });

/** PostHog project tokens are public by design and always carry this prefix. */
const PROJECT_TOKEN_PATTERN = /^phc_[A-Za-z0-9]+$/;

/**
 * The same-origin path prefix the browser talks to instead of PostHog.
 *
 * Deliberately unremarkable: blocklists match on path, and PostHog's own
 * documented default (`/ingest`) is itself widely blocked now. This is a
 * reliability measure, not a covert one — `docs/user-guide/faq.md` says
 * plainly what it is, which is the only version of this that belongs in an
 * open-source project.
 */
export const PROXY_PREFIX = "/_ph";

/** Where the proxied SDK bundle is served from, version-pinned; see `SDK_VERSION`. */
export const SDK_VERSION = "1.427.2";

/**
 * `array.js`, not `array.full.js`: session replay is deliberately not shipped.
 *
 * The full bundle exists to carry the session recorder, and it costs 191 KB
 * gzipped against this one's 91 KB — more than double, for a feature this
 * project decided against. Replay on a source-code viewer also forced a
 * `worker-src 'self' blob:` CSP change (the SDK builds a blob worker, and
 * `worker-src` falls back through `child-src` to a nonce-only `script-src`),
 * which dropping it avoids entirely.
 *
 * Pinned rather than tracking PostHog's floating path, for two reasons that
 * are both about weight. An unpinned bundle can grow in a release nobody here
 * chose, which is the "bogged down by JS" failure `AGENTS.md` guards against.
 * And a version in the path makes the response safely immutable, so the SDK is
 * fetched once and cache-hit for every subsequent navigation — worth far more
 * here than in a single-page app, because every navigation is a full page load.
 */
export const SDK_PATH = `${PROXY_PREFIX}/static/${SDK_VERSION}/array.js`;

/** PostHog's regional host trio. `POSTHOG_HOST` names only the app. */
export interface PostHogRegion {
  /** Where events are POSTed. */
  ingest: string;
  /** Where the SDK bundle is fetched from. */
  assets: string;
  /** Where "open this in PostHog" links point. Never an ingestion target. */
  ui: string;
}

const US_REGION: PostHogRegion = {
  ingest: "https://us.i.posthog.com",
  assets: "https://us-assets.i.posthog.com",
  ui: "https://us.posthog.com",
};

const EU_REGION: PostHogRegion = {
  ingest: "https://eu.i.posthog.com",
  assets: "https://eu-assets.i.posthog.com",
  ui: "https://eu.posthog.com",
};

/**
 * Resolve the origins the proxy forwards to from the app host the operator set.
 *
 * `POSTHOG_HOST` is the *app* host — it defaults to `https://app.posthog.com`,
 * which is where neither the bundle nor the events go. Deriving the rest from
 * it beats adding two more vars every self-hoster has to get right. A
 * self-hosted PostHog serves app, bundle and ingestion from one origin, which
 * is why an unrecognised host is returned unchanged for all three.
 */
export function resolvePostHogRegion(host: string | undefined): PostHogRegion {
  const raw = (host ?? "").trim().replace(/\/+$/, "");
  if (raw === "") return US_REGION;

  let hostname: string;
  try {
    hostname = new URL(raw).hostname.toLowerCase();
  } catch {
    // A malformed host is an operator error we cannot resolve, and guessing an
    // origin to forward to would be worse than falling back to the documented
    // default. `POSTHOG_HOST` is validated nowhere else, so this warning is the
    // only signal the operator gets that their events are not going where they
    // think they are.
    logger.warn("POSTHOG_HOST is not a valid URL; falling back to US cloud", { host: raw });
    return US_REGION;
  }

  // PostHog Cloud in every spelling it has shipped: app.posthog.com (the
  // original, and still this repo's default), us/eu.posthog.com (the current
  // app hosts), and the i./-assets hosts if an operator set one of those here.
  if (hostname === "posthog.com" || hostname.endsWith(".posthog.com")) {
    return hostname.startsWith("eu") ? EU_REGION : US_REGION;
  }

  return { ingest: raw, assets: raw, ui: raw };
}

/**
 * True when forwarding to this target would make the proxy call itself.
 *
 * The obvious case is `POSTHOG_HOST` set to the instance's own origin. The
 * less obvious one — a distinct hostname that CNAMEs back to the same Worker
 * route, which is a normal reverse-proxy arrangement — cannot be detected
 * here; `src/routes/posthog-proxy.ts` carries a hop header for that.
 */
export function isSelfReferential(target: string, requestOrigin: string): boolean {
  try {
    return new URL(target).origin === new URL(requestOrigin).origin;
  } catch {
    // Fails open, so it must not fail quietly: this is a loop guard, and the
    // proxy's hop header is the only thing left catching the case if it does.
    logger.warn("Could not compare proxy target to request origin", { target, requestOrigin });
    return false;
  }
}

/**
 * Does this instance do browser analytics at all?
 *
 * The instance half of `webAnalyticsConfig`, split out because the proxy needs
 * it without having an actor. An instance that never serves the SDK has no
 * reason to relay a beacon, and relaying anyway would leave every self-hoster
 * who left browser analytics off running a PostHog relay on their own origin
 * and their own subrequest budget.
 */
export function browserAnalyticsEnabled(env: {
  POSTHOG_PUBLIC_KEY?: string;
  STRATUM_TELEMETRY_DISABLED?: string;
}): boolean {
  if (env.STRATUM_TELEMETRY_DISABLED === "true") return false;
  const token = env.POSTHOG_PUBLIC_KEY?.trim();
  return token !== undefined && token !== "" && PROJECT_TOKEN_PATTERN.test(token);
}

/** Everything the browser bootstrap needs. Serialized into the page as JSON. */
export interface WebAnalyticsConfig {
  /** The PostHog project token. Public by design; validated as `phc_…` before it gets here. */
  token: string;
  /** Same-origin proxy prefix the SDK posts to. */
  apiHost: string;
  /** The region's app origin, so in-PostHog links resolve past the proxy. */
  uiHost: string;
  /** Matches the server's `environment` property so both surfaces segment identically. */
  environment: string;
  /**
   * The Hono route pattern matched for THIS request (e.g. `/:namespace/:slug`).
   * The only path string the browser is permitted to report — see the snippet.
   */
  route: string;
  /** The signed-in user's id, or `null` for an anonymous visitor. */
  distinctId: string | null;
}

/** What `webAnalyticsConfig` needs in order to decide. */
export interface WebAnalyticsInput {
  publicKey: string | undefined;
  host: string | undefined;
  telemetryDisabled: string | undefined;
  environment: string | undefined;
  route: string;
  userId: string | undefined;
  optedOut: boolean;
}

/**
 * Build the browser config for this request, or `null` when nothing may be sent.
 *
 * `null` is the enforcement point. Every gate resolves here, so the caller's
 * only job is "config or no config" and there is no partially-enabled state a
 * future edit could widen.
 */
export function webAnalyticsConfig(input: WebAnalyticsInput): WebAnalyticsConfig | null {
  // The instance kill switch, same spelling as `createPostHogClient`.
  if (input.telemetryDisabled === "true") return null;

  const token = input.publicKey?.trim();
  if (!token) return null;

  // A personal API key (`phx_…`) grants full account access, and PostHog's two
  // key types differ by one letter. Nothing validates `POSTHOG_API_KEY`
  // today — `createPostHogClient` takes any non-empty string and `capture()`
  // swallows the rejection — so an operator who pasted the wrong one has never
  // had a signal. Publishing that value in every page would turn a silent
  // misconfiguration into credential disclosure, so a non-project token is
  // refused rather than shipped.
  if (!PROJECT_TOKEN_PATTERN.test(token)) {
    // The one refusal worth a log. An unset key and an opted-out user are
    // ordinary states that would spam a line per request; a key that is present
    // but the wrong shape is a misconfiguration the operator cannot otherwise
    // diagnose — which is exactly the silence criticised above. The value is
    // never logged: it may be the personal key this check exists to catch.
    logger.warn("POSTHOG_PUBLIC_KEY is not a PostHog project token (phc_...); analytics disabled");
    return null;
  }

  // The per-user opt-out (#257). An opted-out user's page gets no SDK at all.
  if (input.optedOut) return null;

  const region = resolvePostHogRegion(input.host);
  return {
    token,
    apiHost: PROXY_PREFIX,
    uiHost: region.ui,
    environment: input.environment ?? "unknown",
    route: input.route,
    distinctId: input.userId ?? null,
  };
}
