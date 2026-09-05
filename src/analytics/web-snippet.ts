/**
 * The browser bootstrap: SDK options, and the redaction that makes them safe.
 *
 * ## The rule this file exists to enforce
 *
 * `docs/user-guide/faq.md` promises self-hosters that "Names, paths, URLs,
 * titles, refs, diffs, file contents, and request payloads are never sent."
 * The server keeps that promise easily, because `analyticsMiddleware` chooses
 * all six fields it emits. The browser does not work that way: the SDK
 * produces an open-ended, versioned property set, and this app's URLs and
 * titles are made of exactly the things the promise forbids —
 * `/@alice/private-repo/blob/src/secret.ts`, `#42 Auth is broken — private-repo`.
 *
 * So `before_send` is an **allowlist**: a property is kept only if this file
 * names it, rewrites it, or matches it by a safe prefix. Anything else is
 * dropped. A denylist would have been shorter and is what the first draft of
 * this work used, but it silently leaks whatever the next SDK release adds,
 * and it inverts the discipline `src/analytics/events.ts` is built on.
 */
import type { WebAnalyticsConfig } from "./web";

/**
 * Serialize config for embedding in an inline `<script>`.
 *
 * `<` is escaped because the HTML parser ends a script block at the literal
 * `</script` sequence wherever it occurs, inside a JSON string included.
 * U+2028 and U+2029 are escaped because they are legal unescaped in JSON but
 * are line terminators in JavaScript.
 */
export function serializeConfig(config: WebAnalyticsConfig): string {
  return JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Build the bootstrap source for one request.
 *
 * Written as readable JavaScript rather than PostHog's minified install
 * snippet: that snippet's job is to stub the API and lazy-load the bundle from
 * a CDN, and we do neither — the bundle is a nonce'd, same-origin, version-
 * pinned `<script>` that has already executed by the time this runs.
 */
export function bootstrapScript(config: WebAnalyticsConfig): string {
  return `(function () {
  var cfg = ${serializeConfig(config)};

  // The SDK tag is \`defer\`red, but \`defer\` is ignored on an INLINE script —
  // per the HTML spec it applies only to classic scripts with \`src\`. So this
  // block runs the moment the parser reaches it, which is before the deferred
  // bundle has executed and defined \`posthog\`. Calling init here would hit the
  // undefined guard and return, and the whole feature would ship downloading a
  // bundle it never uses, with no console error and no CSP report — the silent
  // no-op this change exists to eliminate.
  //
  // Deferred scripts are guaranteed to run before DOMContentLoaded, so waiting
  // for it orders us after the bundle while keeping the bundle non-blocking.
  function start() {
    if (typeof posthog === "undefined") return;
    init();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  function init() {

  // Mirrors WEB_EVENT_NAMES in ../analytics/events.ts, which is what the FAQ
  // is tested against.
  var ALLOWED_EVENTS = {
    $pageview: 1, $pageleave: 1, $autocapture: 1, $rageclick: 1, $identify: 1,
    $set: 1, $create_alias: 1,
  };

  // The only path string this page may report: built from the route PATTERN the
  // server matched, so it contains no namespace, repo slug, change id, file
  // path, ref or query string by construction. Same guarantee and same source
  // as the server's api_request event, so the two surfaces cannot drift.
  var maskedUrl = window.location.origin + cfg.route;

  // Kept verbatim. Device, browser and session shape: non-identifying, and the
  // reason browser analytics is worth having at all.
  var KEEP = {
    $browser: 1, $browser_version: 1, $browser_language: 1, $browser_language_prefix: 1,
    $os: 1, $os_version: 1, $device_type: 1, $timezone: 1, $timezone_offset: 1,
    $screen_height: 1, $screen_width: 1, $viewport_height: 1, $viewport_width: 1,
    $lib: 1, $lib_version: 1, $host: 1, $time: 1, $sent_at: 1, $insert_id: 1,
    $session_id: 1, $window_id: 1, $pageview_id: 1, $device_id: 1,
    $anon_distinct_id: 1, $user_id: 1, $is_identified: 1, $process_person_profile: 1,
    $configured_session_timeout_ms: 1, $console_log_recording_enabled_server_side: 1,
    // A bare hostname carries no path, so acquisition analysis survives
    // redaction. The full $referrer does not — see DROP.
    $referring_domain: 1, $initial_referring_domain: 1, $session_entry_referring_domain: 1,
    // Autocapture's element descriptors. Masked at capture time by
    // mask_all_text / mask_all_element_attributes, and scrubbed again below.
    //
    // $elements_chain is deliberately NOT kept: it is the same element data
    // pre-serialized into a string, which cannot be scrubbed the way the array
    // form can, so keeping it would mean trusting the capture-time masks alone.
    // The SDK sends the array form here (elementsChainAsString is false), so
    // dropping it costs nothing.
    $elements: 1, $event_type: 1, $ce_version: 1,
    // Set by this bootstrap.
    environment: 1,
  };

  // Prefix-matched families whose members are named per-metric and cannot be
  // enumerated: $web_vitals_LCP_value, $feature/foo, $survey_response_2, ...
  // $copy_autocapture is deliberately absent: it is the one family that can
  // carry selected or copied page text rather than metadata, and this app's
  // pages are private source. An allowlist is only as strong as its
  // least-justified entry.
  var KEEP_PREFIXES = ["$web_vitals_", "$feature/", "$feature_flag"];

  // Rewritten to the masked URL: absolute locations of a page in this app.
  var TO_URL = ["$current_url", "$initial_current_url", "$session_entry_url"];

  // Rewritten to the bare route pattern: path-only forms of the same thing.
  var TO_ROUTE = [
    "$pathname", "$initial_pathname", "$session_entry_pathname", "$prev_pageview_pathname",
  ];

  // Dropped outright, because there is no correct masked value.
  //
  // $referrer and friends hold the PREVIOUS page's full URL. The route pattern
  // the server supplied describes THIS request, so rewriting them to it would
  // be worse than dropping them: silently wrong data rather than absent data.
  //
  // title holds the repo, file or issue name — src/ui/layout.tsx renders
  // "{title} — Stratum" and pages set titles like "#42 Auth is broken —
  // private-repo".
  var DROP = {
    $referrer: 1, $initial_referrer: 1, $session_entry_referrer: 1,
    title: 1, $prev_pageview_last_content: 1, $prev_pageview_last_content_percentage: 1,
  };

  function keepsByPrefix(key) {
    for (var i = 0; i < KEEP_PREFIXES.length; i++) {
      if (key.indexOf(KEEP_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  // Defence in depth. mask_all_text and mask_all_element_attributes already
  // mask these at capture time, before before_send runs; this survives someone
  // later turning one of those off without reading this file.
  // An allowlist, for the same reason the property filter is one. Deleting
  // "text" and "attr__*" would have been a denylist inside a file whose whole
  // argument is that denylists leak: an element carrying "href", "attributes"
  // or "attr_id" would have passed straight through with the repo slug in it.
  var ELEMENT_KEEP = { tag_name: 1, nth_child: 1, nth_of_type: 1, order: 1 };

  function scrubElements(elements) {
    if (!Array.isArray(elements)) return elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el || typeof el !== "object") continue;
      for (var key in el) {
        if (Object.prototype.hasOwnProperty.call(el, key) && ELEMENT_KEEP[key] !== 1) {
          delete el[key];
        }
      }
    }
    return elements;
  }

  function redact(properties) {
    if (!properties || typeof properties !== "object") return properties;
    for (var key in properties) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (DROP[key] === 1) {
        delete properties[key];
      } else if (TO_URL.indexOf(key) !== -1) {
        properties[key] = maskedUrl;
      } else if (TO_ROUTE.indexOf(key) !== -1) {
        properties[key] = cfg.route;
      } else if (key === "$elements") {
        properties[key] = scrubElements(properties[key]);
      } else if (KEEP[key] !== 1 && !keepsByPrefix(key)) {
        // The allowlist's whole point: an unrecognised property is dropped, so
        // a future SDK release cannot introduce a leak this file never saw.
        delete properties[key];
      }
    }
    return properties;
  }

  posthog.init(cfg.token, {
    api_host: cfg.apiHost,
    ui_host: cfg.uiHost,

    // Anonymous visitors stay personless, matching the server's
    // $process_person_profile: false for unattributed traffic. Note this is not
    // the same mechanism: the server decides per event, while this is a
    // client-side mode that flips permanently once identify() is called and
    // associates the pre-signin anonymous session with the person.
    person_profiles: "identified_only",

    // Session replay is deliberately not shipped: this app renders private
    // source, and the slim bundle is half the weight. Disabled explicitly
    // because the project's own settings can otherwise turn it on server-side,
    // at which point the SDK would try to fetch a recorder this bundle does not
    // contain and the page CSP has no nonce for.
    disable_session_recording: true,
    disable_external_dependency_loading: true,

    // The only opt-out an anonymous visitor has. Settings -> Privacy needs a
    // session, and this ships to every self-hoster's users, not just ours.
    respect_dnt: true,

    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,

    // Autocapture records clicked-element text and attributes by default. In
    // this app that is repo names as link text and /:namespace/:slug as href —
    // a vector the URL rewriting above does not touch, because it never reaches
    // a URL property. These two mask it at capture time.
    mask_all_text: true,
    mask_all_element_attributes: true,
    disable_capture_url_hashes: true,

    before_send: function (event) {
      if (!event) return event;

      // The event-name allowlist. docs/user-guide/faq.md tells self-hosters the
      // list of events is exhaustive, and until now that was true only because
      // a constant in events.ts was maintained by hand. Several posthog-js
      // captures are gated on the PROJECT's remote configuration rather than on
      // anything in this repo — $copy_autocapture is the live example, and it
      // can carry selected page text — so an operator flipping a switch in
      // PostHog could start shipping an event the docs never mentioned.
      // Dropping the unknown ones makes the promise self-enforcing.
      if (ALLOWED_EVENTS[event.event] !== 1) return null;
      event.properties = redact(event.properties);
      event.$set = redact(event.$set);
      event.$set_once = redact(event.$set_once);
      return event;
    },

    loaded: function (ph) {
      // The same distinct_id the server uses (the user id), so a person's UI,
      // API and MCP activity resolve to one profile instead of two halves that
      // never join.
      if (cfg.distinctId) {
        ph.identify(cfg.distinctId);
      } else {
        // Logout is a plain form POST with no client JS, so this is the only
        // point at which a previous session's identity can be cleared. Without
        // it the id persists in first-party storage, posthog-js refuses to
        // re-identify to a different id, and on a shared machine the next
        // person's browsing is attributed to whoever logged in last.
        ph.reset();
      }
      // Segments staging from production exactly as the server's
      // instanceProperties() does. Registered rather than passed per event so
      // autocaptured events carry it too.
      ph.register({ environment: cfg.environment });
    },
  });
  }
})();`;
}
