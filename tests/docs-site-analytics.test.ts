/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import appWeb from "../src/analytics/web.ts?raw";
// @ts-expect-error plain ESM helper shared by the docs build and its Worker
import { readPostHogProjectKey } from "../website/analytics-key.mjs";
import analyticsKey from "../website/analytics-key.mjs?raw";
// Raw imports rather than node:fs, matching tests/wrangler-telemetry-config.test.ts.
// The docs site has no test runner of its own, so its two analytics-bearing
// files are asserted from here — otherwise they would ship with no coverage at
// all on a site that has no CSP.
import astroConfig from "../website/astro.config.mjs?raw";
import docsWorker from "../website/worker/index.js?raw";

describe("docs site analytics gating", () => {
  it("validates the key the same way in the build and in the Worker", () => {
    // They diverged once: `startsWith("phc_")` in the build against a full
    // pattern in the Worker, so `phc_bad-key` produced a site that loaded the
    // SDK and then had every request refused by its own proxy.
    expect(astroConfig).toContain("readPostHogProjectKey");
    expect(docsWorker).toContain("readPostHogProjectKey");
    expect(astroConfig).not.toContain('startsWith("phc_")');
    expect(analyticsKey).toContain("/^phc_[A-Za-z0-9]+$/");
  });

  it("ships nothing unless a PostHog project key is supplied at build time", () => {
    // A fork, a PR preview, or anyone running `npm run build` must produce a
    // site that sends nothing. The build must never depend on the variable.
    expect(astroConfig).toContain("readPostHogProjectKey(process.env.POSTHOG_PUBLIC_KEY)");
    // The value embedded in the HTML must be the one the reader returned, not
    // the raw variable: a reader that normalises and a caller that embeds the
    // original is how `" phc_abc "` shipped padded and was rejected upstream.
    expect(astroConfig).toContain("JSON.stringify(POSTHOG_KEY)");
  });

  it("refuses a personal API key, which would be a credential in public HTML", () => {
    // PostHog's two key types differ by one letter and the value is embedded in
    // every page, so this check is the only thing standing between a paste
    // error and a disclosure.
    expect(readPostHogProjectKey("phc_abc123")).toBe("phc_abc123");
    for (const bad of ["phx_secret", "sk_live", "phc_", "PHC_abc", "phc_bad-key", "", undefined]) {
      expect(readPostHogProjectKey(bad), String(bad)).toBe("");
    }
  });

  it("normalises the key it validates, so the build cannot embed a padded one", () => {
    // A secret pasted into a CI variable arrives with a trailing newline more
    // often than not. Trimming inside the check and returning a boolean let
    // `" phc_abc123 "` pass while the caller embedded the padded string, which
    // PostHog refuses — a site that looks instrumented and sends nothing.
    expect(readPostHogProjectKey(" phc_abc123 ")).toBe("phc_abc123");
    expect(readPostHogProjectKey("phc_abc123\n")).toBe("phc_abc123");
    expect(readPostHogProjectKey("\tphc_abc123")).toBe("phc_abc123");
    expect(readPostHogProjectKey(" phc_bad-key ")).toBe("");
  });

  it("pins the SDK version rather than tracking a floating bundle", () => {
    expect(astroConfig).toMatch(/SDK_VERSION = "\d+\.\d+\.\d+"/);
    expect(astroConfig).toContain("/_ph/static/${SDK_VERSION}/array.js");
  });

  it("does not load session replay", () => {
    expect(astroConfig).toContain("disable_session_recording: true");
    expect(astroConfig).toContain("disable_external_dependency_loading: true");
  });

  it("respects Do Not Track, the only control an anonymous docs visitor has", () => {
    // In posthog-js 1.427.2 this also honours navigator.globalPrivacyControl,
    // which is what makes it a real control rather than a legacy header check.
    expect(astroConfig).toContain("respect_dnt: true");
  });

  it("waits for the deferred bundle instead of calling init while it is undefined", () => {
    // `defer` is ignored on an inline script, and these tags are in <head>, so
    // without this the inline block throws ReferenceError on every docs page.
    expect(astroConfig).toContain("DOMContentLoaded");
    expect(astroConfig).toContain('typeof posthog === "undefined"');
  });
});

describe("SDK version pinning", () => {
  it("pins the same version in all three places that hardcode it", () => {
    // The app, the docs build, and the docs Worker each carry the literal.
    // Nothing links them, so bumping one silently leaves the others serving a
    // different bundle from the same-looking path.
    const versions = [
      /SDK_VERSION = "(\d+\.\d+\.\d+)"/.exec(appWeb)?.[1],
      /SDK_VERSION = "(\d+\.\d+\.\d+)"/.exec(astroConfig)?.[1],
      /SDK_VERSION = "(\d+\.\d+\.\d+)"/.exec(docsWorker)?.[1],
    ];
    expect(versions.every(Boolean)).toBe(true);
    expect(new Set(versions).size).toBe(1);
  });
});

describe("docs site proxy", () => {
  it("handles the analytics prefix before Markdown negotiation and the assets binding", () => {
    // The Markdown branch would rewrite `/_ph/e` to `/_ph/e.md`, and the assets
    // binding would 404 it, so ordering here is load-bearing rather than
    // stylistic.
    const proxyAt = docsWorker.indexOf("return handleAnalyticsProxy(");
    const markdownAt = docsWorker.indexOf("wantsMarkdown(request.headers.get");
    const assetsAt = docsWorker.indexOf("env.ASSETS.fetch(request)");
    expect(proxyAt).toBeGreaterThan(-1);
    expect(proxyAt).toBeLessThan(markdownAt);
    expect(proxyAt).toBeLessThan(assetsAt);
  });

  it("relays nothing when the deployment has no key", () => {
    // Mirrors the app proxy's gate. A fork, or any build without the variable,
    // must not run a PostHog relay — the FAQ promises exactly that, so without
    // this the docs half made the documentation false.
    expect(docsWorker).toContain("env.POSTHOG_PUBLIC_KEY");
    expect(docsWorker).toContain("readPostHogProjectKey(env.POSTHOG_PUBLIC_KEY)");
  });

  it("forwards only PostHog ingestion paths", () => {
    expect(docsWorker).toContain(
      'INGEST_PREFIXES = ["/e", "/i/v0/e", "/decide", "/flags", "/batch"]',
    );
  });

  it("strips credentials before forwarding and refuses to loop", () => {
    expect(docsWorker).toContain('headers.delete("cookie")');
    expect(docsWorker).toContain('headers.delete("authorization")');
    expect(docsWorker).toContain('request.headers.get("X-Stratum-Proxy")');
  });

  it("never lets the upstream set cookies on this origin", () => {
    expect(docsWorker).toContain('responseHeaders.delete("set-cookie")');
  });

  it("accepts only a plain semver in the SDK path", () => {
    // The version is interpolated into a CDN URL.
    expect(docsWorker).toContain("/^\\/static\\/(\\d+\\.\\d+\\.\\d+)\\/array\\.js$/");
  });
});
