import {
  TELEMETRY_CONSENT_DESCRIPTION,
  TELEMETRY_CONSENT_FIELD,
  TELEMETRY_CONSENT_LABEL,
  TELEMETRY_FAQ_URL,
} from "../../analytics/consent";

/**
 * The telemetry consent box for a signup form (#257). Render it only when
 * `telemetryConsentAtSignup(env)` is true.
 *
 * Never `checked`, and never restored from a previous submission: consent is
 * something a person does on the form in front of them, so a form re-shown
 * after a validation error starts unticked again rather than remembering.
 *
 * The missing `value` is load-bearing, as on the settings page: a ticked
 * valueless box submits `"on"`, the only value `telemetryConsentGiven` accepts.
 */
export function TelemetryConsentField() {
  return (
    <div class="consent-group">
      <div class="checkbox-group">
        <input
          type="checkbox"
          id={TELEMETRY_CONSENT_FIELD}
          name={TELEMETRY_CONSENT_FIELD}
          class="checkbox-input"
          aria-describedby="telemetryConsentHint"
        />
        <label class="checkbox-label" for={TELEMETRY_CONSENT_FIELD}>
          {TELEMETRY_CONSENT_LABEL}
        </label>
      </div>
      <div class="input-hint" id="telemetryConsentHint">
        {TELEMETRY_CONSENT_DESCRIPTION} <a href={TELEMETRY_FAQ_URL}>What is sent</a>. You can change
        this later in Settings.
      </div>
    </div>
  );
}

/**
 * The same box for the hand-written HTML of the agent-signup approval page,
 * which is a template string rather than JSX. Every interpolated value is a
 * module constant, so there is nothing here to escape.
 */
export const TELEMETRY_CONSENT_HTML_INLINE = `<p style="text-align:left;margin:0 0 1rem">
<label for="${TELEMETRY_CONSENT_FIELD}"><input type="checkbox" id="${TELEMETRY_CONSENT_FIELD}" name="${TELEMETRY_CONSENT_FIELD}" aria-describedby="telemetryConsentHint"> ${TELEMETRY_CONSENT_LABEL}</label>
<br><small id="telemetryConsentHint" style="color:#555">${TELEMETRY_CONSENT_DESCRIPTION} <a href="${TELEMETRY_FAQ_URL}">What is sent</a>. You can change this later in Settings.</small>
</p>`;
