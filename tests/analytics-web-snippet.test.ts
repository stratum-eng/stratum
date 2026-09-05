import { describe, expect, it } from "vitest";
import type { WebAnalyticsConfig } from "../src/analytics/web";
import { bootstrapScript, serializeConfig } from "../src/analytics/web-snippet";

const ORIGIN = "https://app.usestratum.dev";

const CONFIG: WebAnalyticsConfig = {
  token: "phc_abc123",
  apiHost: "/_ph",
  uiHost: "https://us.posthog.com",
  environment: "production",
  route: "/:namespace/:slug/blob/*",
  distinctId: "user_1",
};

interface InitOptions {
  before_send: (event: Record<string, unknown> | null) => Record<string, unknown> | null;
  loaded: (ph: FakePostHog) => void;
  [key: string]: unknown;
}

interface FakePostHog {
  identify: (id: string) => void;
  reset: () => void;
  register: (props: Record<string, unknown>) => void;
  identified: string[];
  resets: number;
  registered: Record<string, unknown>[];
}

/**
 * Execute the generated bootstrap against a stub SDK and hand back the options
 * it passed to `init`. Testing the emitted source rather than a parallel
 * TypeScript copy of the logic is the point: the string is what ships.
 */
function runBootstrap(config: WebAnalyticsConfig = CONFIG): {
  options: InitOptions;
  ph: FakePostHog;
  initCalledBeforeDomReady: boolean;
} {
  let options: InitOptions | undefined;
  const posthog = {
    init: (_token: string, opts: InitOptions) => {
      options = opts;
    },
  };
  const win = { location: { origin: ORIGIN, href: `${ORIGIN}/@alice/private-repo` } };

  // Models the real execution order. The SDK tag is deferred, so `posthog`
  // does not exist while the parser is running the inline bootstrap; deferred
  // scripts run before DOMContentLoaded, so the bundle is present by the time
  // the listener fires. A bootstrap that calls init immediately would see
  // `posthog === undefined`, return, and send nothing forever.
  const listeners: Array<() => void> = [];
  const doc = {
    readyState: "loading",
    addEventListener: (event: string, handler: () => void) => {
      if (event === "DOMContentLoaded") listeners.push(handler);
    },
  };

  // `posthog` is resolved as a GLOBAL, not passed in — that is what lets it be
  // absent while the bootstrap is parsed and present once the deferred bundle
  // has run. Passing it as a parameter would pin it to one value and hide the
  // ordering bug this models.
  const globals = globalThis as { posthog?: unknown };
  globals.posthog = undefined;
  let initCalledBeforeDomReady = false;

  // Executing the emitted source is the point: a parallel TypeScript copy of
  // the redaction would test itself rather than the string that ships.
  try {
    new Function("window", "document", bootstrapScript(config))(win, doc);
    initCalledBeforeDomReady = options !== undefined;

    // The deferred bundle has now executed and defined the global.
    globals.posthog = posthog;
    for (const fire of listeners) fire();
  } finally {
    globals.posthog = undefined;
  }
  if (!options) throw new Error("bootstrap did not call posthog.init after DOMContentLoaded");

  const ph: FakePostHog = {
    identified: [],
    resets: 0,
    registered: [],
    identify(id) {
      this.identified.push(id);
    },
    reset() {
      this.resets += 1;
    },
    register(props) {
      this.registered.push(props);
    },
  };
  options.loaded(ph);
  return { options, ph, initCalledBeforeDomReady };
}

/** Every property this app could plausibly leak, plus the safe ones that must survive. */
function stuffedEvent(): Record<string, unknown> {
  return {
    event: "$pageview",
    properties: {
      // Must be rewritten — these hold the concrete repo and file path.
      $current_url: `${ORIGIN}/@alice/private-repo/blob/src/secret.ts?ref=main#L42`,
      $initial_current_url: `${ORIGIN}/@alice/private-repo`,
      $session_entry_url: `${ORIGIN}/@alice/private-repo/issues/42`,
      $pathname: "/@alice/private-repo/blob/src/secret.ts",
      $initial_pathname: "/@alice/private-repo",
      $session_entry_pathname: "/@alice/private-repo",
      $prev_pageview_pathname: "/@alice/private-repo/changes",
      // Must be dropped — no correct masked value exists.
      $referrer: `${ORIGIN}/@alice/private-repo/settings`,
      $initial_referrer: `${ORIGIN}/@bob/other-repo`,
      $session_entry_referrer: `${ORIGIN}/@alice/private-repo`,
      title: "#42 Auth is broken — private-repo — Stratum",
      // Must survive — non-identifying and the reason to have analytics.
      $browser: "Chrome",
      $os: "macOS",
      $device_type: "Desktop",
      $screen_width: 1920,
      $referring_domain: "google.com",
      $session_id: "sess_1",
      $lib: "web",
      environment: "production",
      // Prefix families that cannot be enumerated.
      $web_vitals_LCP_value: 812,
      "$feature/new-ui": true,
      // The failure the allowlist exists for: a property this file has never
      // seen, added by some future SDK release, carrying a concrete path.
      $some_future_url_property: `${ORIGIN}/@alice/private-repo/blob/src/secret.ts`,
    },
    $set: { $initial_current_url: `${ORIGIN}/@alice/private-repo` },
    $set_once: { $initial_pathname: "/@alice/private-repo", title: "private-repo" },
  };
}

describe("bootstrap redaction", () => {
  const { options } = runBootstrap();
  const sent = options.before_send(stuffedEvent()) as Record<string, unknown>;
  const props = sent.properties as Record<string, unknown>;

  it("rewrites every absolute app URL to the route pattern", () => {
    const masked = `${ORIGIN}/:namespace/:slug/blob/*`;
    expect(props.$current_url).toBe(masked);
    expect(props.$initial_current_url).toBe(masked);
    expect(props.$session_entry_url).toBe(masked);
  });

  it("rewrites path-only forms to the bare route pattern", () => {
    for (const key of [
      "$pathname",
      "$initial_pathname",
      "$session_entry_pathname",
      "$prev_pageview_pathname",
    ]) {
      expect(props[key], key).toBe("/:namespace/:slug/blob/*");
    }
  });

  it("drops referrers rather than rewriting them to the wrong page", () => {
    // The route pattern describes THIS request; using it for the PREVIOUS page
    // would be silently wrong data, which is worse than absent data.
    for (const key of ["$referrer", "$initial_referrer", "$session_entry_referrer"]) {
      expect(props, key).not.toHaveProperty(key);
    }
  });

  it("drops the page title, which carries repo, file and issue names", () => {
    expect(props).not.toHaveProperty("title");
  });

  it("drops any property it has never seen, including a future URL-bearing one", () => {
    expect(props).not.toHaveProperty("$some_future_url_property");
  });

  it("keeps non-identifying device, browser and session properties", () => {
    expect(props.$browser).toBe("Chrome");
    expect(props.$os).toBe("macOS");
    expect(props.$device_type).toBe("Desktop");
    expect(props.$screen_width).toBe(1920);
    expect(props.$session_id).toBe("sess_1");
    expect(props.environment).toBe("production");
  });

  it("keeps the referring DOMAIN, which has no path", () => {
    expect(props.$referring_domain).toBe("google.com");
  });

  it("keeps prefix-matched families that cannot be enumerated", () => {
    expect(props.$web_vitals_LCP_value).toBe(812);
    expect(props["$feature/new-ui"]).toBe(true);
  });

  it("applies the same redaction to $set and $set_once person properties", () => {
    // Person properties ride on the person, not the event: masking the event
    // alone would leave the repo name on the profile permanently.
    expect((sent.$set as Record<string, unknown>).$initial_current_url).toBe(
      `${ORIGIN}/:namespace/:slug/blob/*`,
    );
    expect(sent.$set_once as Record<string, unknown>).not.toHaveProperty("title");
  });

  it("leaves no concrete repo, file, ref or query value anywhere in the payload", () => {
    const serialized = JSON.stringify(sent);
    for (const secret of ["alice", "private-repo", "secret.ts", "ref=main", "L42", "bob"]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it("survives a null or property-less event without throwing", () => {
    expect(options.before_send(null)).toBeNull();
    expect(() => options.before_send({ event: "$pageview" })).not.toThrow();
  });
});

describe("autocapture element scrubbing", () => {
  it("strips element text and attributes as defence in depth", () => {
    // mask_all_text / mask_all_element_attributes already mask these at capture
    // time; this survives someone turning one of them off.
    const { options } = runBootstrap();
    const sent = options.before_send({
      event: "$autocapture",
      properties: {
        $elements: [
          { tag_name: "a", text: "private-repo", attr__href: "/@alice/private-repo", nth_child: 2 },
        ],
      },
    }) as Record<string, unknown>;
    const elements = (sent.properties as Record<string, unknown>).$elements as Record<
      string,
      unknown
    >[];
    expect(elements[0]).not.toHaveProperty("text");
    expect(elements[0]).not.toHaveProperty("attr__href");
    expect(elements[0]?.tag_name).toBe("a");
  });

  it("keeps only structural element keys, dropping shapes a denylist would miss", () => {
    // The earlier version deleted `text` and `attr__*` only, so an element
    // carrying `href`, `attributes` or `attr_id` passed through with the repo
    // slug intact — a denylist inside the file whose thesis is that denylists
    // leak.
    const { options } = runBootstrap();
    const sent = options.before_send({
      event: "$autocapture",
      properties: {
        $elements: [
          {
            tag_name: "a",
            nth_child: 2,
            href: "/@alice/private-repo",
            attr_id: "repo-alice-private",
            attributes: { "attr__data-slug": "private-repo" },
          },
        ],
      },
    }) as Record<string, unknown>;
    const el = (
      (sent.properties as Record<string, unknown>).$elements as Record<string, unknown>[]
    )[0];
    expect(el).toEqual({ tag_name: "a", nth_child: 2 });
    expect(JSON.stringify(sent)).not.toContain("private-repo");
  });

  it("drops $elements_chain, which cannot be scrubbed once serialized", () => {
    const { options } = runBootstrap();
    const sent = options.before_send({
      event: "$autocapture",
      properties: { $elements_chain: 'a:href="/@alice/private-repo"nth_child="2"' },
    }) as Record<string, unknown>;
    expect(sent.properties).not.toHaveProperty("$elements_chain");
  });

  it("drops any event the FAQ does not document, whatever its properties", () => {
    // Several posthog-js captures are gated on the PROJECT's remote config, not
    // on anything in this repo — $copy_autocapture can carry selected page text
    // — so an operator flipping a switch in PostHog could otherwise ship an
    // event the docs never mentioned. This is what makes the FAQ's
    // exhaustiveness claim self-enforcing rather than hand-maintained.
    const { options } = runBootstrap();
    expect(
      options.before_send({
        event: "$copy_autocapture",
        properties: { $copy_autocapture_value: "secret source code the user selected" },
      }),
    ).toBeNull();
    expect(options.before_send({ event: "$some_future_event", properties: {} })).toBeNull();
  });

  it("still sends every event the FAQ does document", () => {
    const { options } = runBootstrap();
    for (const name of ["$pageview", "$pageleave", "$autocapture", "$rageclick", "$identify"]) {
      expect(options.before_send({ event: name, properties: {} }), name).not.toBeNull();
    }
  });
});

describe("script execution order", () => {
  it("waits for the deferred SDK instead of running while it is still undefined", () => {
    // `defer` is ignored on an inline script, so the bootstrap is parsed and
    // run before the deferred bundle defines `posthog`. Calling init at that
    // moment hits the undefined guard and returns — the page downloads the SDK
    // and sends nothing, with no console error and no CSP report.
    const { initCalledBeforeDomReady } = runBootstrap();
    expect(initCalledBeforeDomReady).toBe(false);
  });

  it("registers its listener rather than assuming the SDK is present", () => {
    expect(bootstrapScript(CONFIG)).toContain("DOMContentLoaded");
  });
});

describe("identity", () => {
  it("identifies a signed-in user with the id the server uses", () => {
    const { ph } = runBootstrap();
    expect(ph.identified).toEqual(["user_1"]);
    expect(ph.resets).toBe(0);
  });

  it("resets when nobody is signed in, so a logout does not bleed into the next person", () => {
    const { ph } = runBootstrap({ ...CONFIG, distinctId: null });
    expect(ph.identified).toEqual([]);
    expect(ph.resets).toBe(1);
  });

  it("registers the environment so autocaptured events segment too", () => {
    const { ph } = runBootstrap({ ...CONFIG, environment: "staging" });
    expect(ph.registered).toEqual([{ environment: "staging" }]);
  });
});

describe("SDK options", () => {
  const { options } = runBootstrap();

  it("does not ship session replay, and says so to the SDK explicitly", () => {
    // The project's own PostHog settings can enable recording server-side; this
    // bundle has no recorder and the CSP has no nonce for one it would fetch.
    expect(options.disable_session_recording).toBe(true);
    expect(options.disable_external_dependency_loading).toBe(true);
  });

  it("masks autocapture text and attributes at capture time", () => {
    expect(options.mask_all_text).toBe(true);
    expect(options.mask_all_element_attributes).toBe(true);
    expect(options.disable_capture_url_hashes).toBe(true);
  });

  it("honours Do Not Track, the only opt-out an anonymous visitor has", () => {
    expect(options.respect_dnt).toBe(true);
  });

  it("keeps anonymous visitors personless", () => {
    expect(options.person_profiles).toBe("identified_only");
  });

  it("posts to the same-origin proxy, not to PostHog directly", () => {
    expect(options.api_host).toBe("/_ph");
    expect(options.ui_host).toBe("https://us.posthog.com");
  });
});

describe("serializeConfig", () => {
  it("escapes < so a crafted value cannot end the script block", () => {
    const serialized = serializeConfig({ ...CONFIG, route: "</script><script>alert(1)" });
    expect(serialized).not.toContain("</script");
    expect(serialized).toContain("\\u003c");
  });

  it("escapes the JS line terminators that are legal in JSON", () => {
    const serialized = serializeConfig({ ...CONFIG, route: "/a b c" });
    expect(serialized).toContain("\\u2028");
    expect(serialized).toContain("\\u2029");
  });
});
