import { describe, expect, it } from "vitest";
import {
  PROXY_PREFIX,
  SDK_PATH,
  type WebAnalyticsInput,
  isSelfReferential,
  resolvePostHogRegion,
  webAnalyticsConfig,
} from "../src/analytics/web";
import { isPostHogProxyPath, isPostHogSdkPath } from "../src/routes/posthog-proxy";

/** A configuration where every gate is open, so each test closes exactly one. */
function allowed(overrides: Partial<WebAnalyticsInput> = {}): WebAnalyticsInput {
  return {
    publicKey: "phc_abc123",
    host: "https://app.posthog.com",
    telemetryDisabled: undefined,
    environment: "production",
    route: "/:namespace/:slug",
    userId: "user_1",
    optedOut: false,
    ...overrides,
  };
}

describe("resolvePostHogRegion", () => {
  it("maps every PostHog Cloud spelling to the US trio", () => {
    for (const host of [
      "https://app.posthog.com",
      "https://us.posthog.com",
      "https://us.i.posthog.com",
      "https://posthog.com",
      "https://app.posthog.com/",
    ]) {
      expect(resolvePostHogRegion(host).ingest, host).toBe("https://us.i.posthog.com");
      expect(resolvePostHogRegion(host).assets, host).toBe("https://us-assets.i.posthog.com");
    }
  });

  it("maps the EU app hosts to the EU trio", () => {
    for (const host of ["https://eu.posthog.com", "https://eu.i.posthog.com"]) {
      expect(resolvePostHogRegion(host).ingest, host).toBe("https://eu.i.posthog.com");
      expect(resolvePostHogRegion(host).ui, host).toBe("https://eu.posthog.com");
    }
  });

  it("serves app, bundle and ingestion from one origin when self-hosted", () => {
    const region = resolvePostHogRegion("https://posthog.internal.example");
    expect(region.ingest).toBe("https://posthog.internal.example");
    expect(region.assets).toBe("https://posthog.internal.example");
    expect(region.ui).toBe("https://posthog.internal.example");
  });

  it("falls back to US cloud for an unset or unparseable host rather than guessing", () => {
    // POSTHOG_HOST is validated nowhere else, so a typo must not produce an
    // origin the proxy would then forward real events to.
    for (const host of [undefined, "", "   ", "not a url", "://broken"]) {
      expect(resolvePostHogRegion(host).ingest).toBe("https://us.i.posthog.com");
    }
  });

  it("strips trailing slashes so a self-hosted origin never doubles them", () => {
    expect(resolvePostHogRegion("https://ph.example.com///").ingest).toBe("https://ph.example.com");
  });
});

describe("isSelfReferential", () => {
  it("catches a target equal to the instance's own origin", () => {
    expect(isSelfReferential("https://app.usestratum.dev", "https://app.usestratum.dev/x")).toBe(
      true,
    );
  });

  it("allows a genuinely different origin", () => {
    expect(isSelfReferential("https://us.i.posthog.com", "https://app.usestratum.dev/x")).toBe(
      false,
    );
  });

  it("does not throw on malformed input", () => {
    expect(isSelfReferential("nonsense", "https://app.usestratum.dev")).toBe(false);
  });
});

describe("webAnalyticsConfig gates", () => {
  it("returns a config when every gate is open", () => {
    const config = webAnalyticsConfig(allowed());
    expect(config).not.toBeNull();
    expect(config?.token).toBe("phc_abc123");
    expect(config?.apiHost).toBe(PROXY_PREFIX);
    expect(config?.uiHost).toBe("https://us.posthog.com");
    expect(config?.distinctId).toBe("user_1");
  });

  it("suppresses on the instance kill switch", () => {
    expect(webAnalyticsConfig(allowed({ telemetryDisabled: "true" }))).toBeNull();
  });

  it("suppresses when no public key is configured", () => {
    // Browser analytics is opt-in on its OWN var: reusing POSTHOG_API_KEY would
    // silently redefine what an existing self-hoster's config means.
    for (const key of [undefined, "", "   "]) {
      expect(webAnalyticsConfig(allowed({ publicKey: key }))).toBeNull();
    }
  });

  it("refuses any key that is not a PostHog project token", () => {
    // A personal key (phx_) grants full account access and differs by one
    // letter. Publishing one in every page would be credential disclosure.
    for (const key of ["phx_secret", "sk_live_abc", "phc", "phc_", "PHC_abc", "phc_a b"]) {
      expect(webAnalyticsConfig(allowed({ publicKey: key })), key).toBeNull();
    }
  });

  it("tolerates whitespace around an otherwise valid key", () => {
    // Operators paste these out of the PostHog UI; surrounding whitespace is a
    // transcription artefact, not a different key.
    expect(webAnalyticsConfig(allowed({ publicKey: "  phc_abc123  " }))?.token).toBe("phc_abc123");
  });

  it("suppresses for a user who opted out", () => {
    expect(webAnalyticsConfig(allowed({ optedOut: true }))).toBeNull();
  });

  it("captures an anonymous visitor personless rather than suppressing", () => {
    const config = webAnalyticsConfig(allowed({ userId: undefined }));
    expect(config).not.toBeNull();
    expect(config?.distinctId).toBeNull();
  });

  it("keeps the opt-out authoritative even for an anonymous request", () => {
    // git-http publishes the preference WITHOUT a userId, so suppression must
    // not be gated on having an identity.
    expect(webAnalyticsConfig(allowed({ userId: undefined, optedOut: true }))).toBeNull();
  });

  it("reports the environment, defaulting to unknown like the server does", () => {
    expect(webAnalyticsConfig(allowed({ environment: undefined }))?.environment).toBe("unknown");
    expect(webAnalyticsConfig(allowed({ environment: "staging" }))?.environment).toBe("staging");
  });

  it("carries the route pattern through untouched", () => {
    const config = webAnalyticsConfig(allowed({ route: "/:namespace/:slug/blob/*" }));
    expect(config?.route).toBe("/:namespace/:slug/blob/*");
  });
});

describe("rate-limit exemption scope", () => {
  it("exempts ingestion but not the SDK bundle route", () => {
    // The bundle route accepts any semver and does not cache a miss, so an
    // exempt route would be an unauthenticated outbound-fetch amplifier billed
    // to whoever deployed it. Ingestion must stay exempt so a busy session
    // cannot rate-limit itself out of the app.
    expect(isPostHogProxyPath("/_ph/e")).toBe(true);
    expect(isPostHogSdkPath("/_ph/e")).toBe(false);
    expect(isPostHogSdkPath("/_ph/static/1.427.2/array.js")).toBe(true);
  });
});

describe("SDK path", () => {
  it("is version-pinned so the response can be cached immutably", () => {
    expect(SDK_PATH).toMatch(/^\/_ph\/static\/\d+\.\d+\.\d+\/array\.js$/);
  });

  it("uses a prefix no blocklist pattern matches", () => {
    for (const token of ["posthog", "analytics", "track", "ingest", "telemetry"]) {
      expect(PROXY_PREFIX).not.toContain(token);
    }
  });
});
