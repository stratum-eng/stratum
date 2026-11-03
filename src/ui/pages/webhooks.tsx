import type { FC } from "hono/jsx";
import type { Webhook, WebhookDelivery } from "../../storage/webhooks";
import { FieldError, fieldAttrs, fieldErrorId } from "../components/field-error";
import { ProjectHeader } from "../components/project-header";
import { Layout } from "../layout";

interface WebhooksPageProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
    visibility?: string;
  };
  webhooks: Array<{ webhook: Omit<Webhook, "secret">; deliveries: WebhookDelivery[] }>;
  subscribableEvents: string[];
  /** A refused "Add webhook" submission, resolved from its `?error=` code. */
  formError?: WebhookFormError | undefined;
  /** What the refused submission held; absent for a fresh form. */
  formValues?: WebhookFormValues | undefined;
  user?: { id: string; email: string; username: string } | null;
  /** Per-request CSP nonce — required so the regenerate confirm script passes `script-src`. */
  nonce: string;
}

/** The fields of the "Add webhook" form a refusal can be about. */
export type WebhookFormField = "url" | "events";

/** A refused "Add webhook" submission: which field, and why. */
export interface WebhookFormError {
  field: WebhookFormField;
  message: string;
}

const WEBHOOK_FORM_ERRORS: Record<WebhookFormField, string> = {
  url: "Enter a public http:// or https:// URL. Private, loopback and link-local addresses are refused.",
  events: "Choose “All events” or at least one event to deliver.",
};

/**
 * Maps a `?error=` code to its copy. The code is the field name and the copy
 * is ours: the query string can select a message but never supply one.
 */
export function webhookFormError(code: string | undefined): WebhookFormError | undefined {
  if (code !== "url" && code !== "events") return undefined;
  return { field: code, message: WEBHOOK_FORM_ERRORS[code] };
}

/** What a refused "Add webhook" submission held, to refill the form. */
export interface WebhookFormValues {
  url?: string | undefined;
  /** The checked event boxes, `*` for "All events". */
  events?: string[] | undefined;
}

/** Longest URL echoed back into the form; the API's own cap is 2048. */
const MAX_ECHOED_URL_LENGTH = 2048;

/**
 * Where a refused form submission goes: back to the management page with the
 * field as a fixed code and what was entered. Values only ever render as an
 * input value or a checked box, never as copy.
 */
export function webhookFormErrorUrl(
  page: string,
  field: WebhookFormField,
  values: WebhookFormValues,
): string {
  const params = new URLSearchParams({ error: field });
  if (values.url !== undefined && values.url !== "" && values.url.length <= MAX_ECHOED_URL_LENGTH) {
    params.set("url", values.url);
  }
  // At least one `events` entry, even if none were checked, so the page can
  // tell "came back with nothing checked" from "fresh form, default to all".
  const events = values.events ?? [];
  if (events.length === 0) params.append("events", "");
  for (const event of events.slice(0, 64)) params.append("events", event);
  return `${page}?${params.toString()}`;
}

/** Reads `webhookFormErrorUrl`'s values back off the page's query string. */
export function webhookFormValues(
  query: (key: string) => string | undefined,
  queries: (key: string) => string[] | undefined,
): WebhookFormValues {
  const url = query("url");
  const events = queries("events");
  return {
    ...(url !== undefined && url.length <= MAX_ECHOED_URL_LENGTH ? { url } : {}),
    ...(events !== undefined ? { events: events.filter((event) => event !== "") } : {}),
  };
}

const DeliveryRow: FC<{ delivery: WebhookDelivery }> = ({ delivery }) => (
  <li class="webhook-delivery">
    <span class={`badge ${delivery.status === "success" ? "badge-merged" : "badge-rejected"}`}>
      {delivery.status}
    </span>
    <span class="webhook-delivery-type">{delivery.eventType}</span>
    <span class="webhook-delivery-meta">
      {delivery.statusCode !== undefined ? `HTTP ${delivery.statusCode}` : (delivery.error ?? "")}
      {delivery.durationMs !== undefined ? ` · ${delivery.durationMs}ms` : ""}
    </span>
    <span class="webhook-delivery-time">{new Date(delivery.createdAt).toLocaleString()}</span>
  </li>
);

export const WebhooksPage: FC<WebhooksPageProps> = ({
  project,
  webhooks,
  subscribableEvents,
  formError,
  formValues,
  user,
  nonce,
}) => {
  const base = `/api/projects/${project.namespace}/${project.slug}/webhooks`;
  // A fresh form defaults to "All events"; a refilled one shows what was checked.
  const checkedEvents = formValues?.events;
  const isChecked = (event: string) =>
    checkedEvents === undefined ? event === "*" : checkedEvents.includes(event);
  const urlError = formError?.field === "url" ? formError.message : undefined;
  const eventsError = formError?.field === "events" ? formError.message : undefined;
  return (
    <Layout title={`Webhooks — ${project.name}`} user={user}>
      <ProjectHeader project={project} active="settings" canWrite={true} />
      <div class="page-header">
        <h1>Webhooks</h1>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Add webhook</h3>
        <p class="webhook-help">
          Stratum will POST a JSON payload to this URL for each subscribed event, signed with an
          HMAC-SHA256 <code>X-Stratum-Signature</code> header.
        </p>
        {/* `novalidate`: the create route checks the URL (including what only
            the server can, such as a private host) and sends the form back
            here with the reason under the field. */}
        <form method="post" action={base} class="webhook-form" novalidate>
          <label>
            Payload URL
            <input
              {...fieldAttrs("webhook-url", urlError)}
              type="url"
              name="url"
              value={formValues?.url}
              placeholder="https://example.com/hooks/stratum"
              required
            />
          </label>
          <FieldError for="webhook-url" message={urlError} />
          <fieldset
            class="webhook-events"
            {...(eventsError !== undefined
              ? { "aria-describedby": fieldErrorId("webhook-events") }
              : {})}
          >
            <legend>Events to deliver</legend>
            <FieldError for="webhook-events" message={eventsError} />
            <label class="checkbox-label">
              <input type="checkbox" name="events" value="*" checked={isChecked("*")} />
              All events
            </label>
            <div class="webhook-events-grid">
              {subscribableEvents.map((event) => (
                <label class="checkbox-label" key={event}>
                  <input type="checkbox" name="events" value={event} checked={isChecked(event)} />
                  {event}
                </label>
              ))}
            </div>
            <p class="webhook-help">
              "All events" wins when checked; otherwise only the selected events are delivered.
            </p>
          </fieldset>
          <button type="submit" class="btn btn-primary">
            Add webhook
          </button>
        </form>
      </div>

      {webhooks.length === 0 ? (
        <div class="empty-state">
          <p>No webhooks configured.</p>
        </div>
      ) : (
        webhooks.map(({ webhook, deliveries }) => (
          <div class="card webhook-card" key={webhook.id}>
            <div class="webhook-card-header">
              <div>
                <code class="webhook-url">{webhook.url}</code>
                <span class={`badge ${webhook.active ? "badge-merged" : "badge-rejected"}`}>
                  {webhook.active ? "active" : "disabled"}
                </span>
              </div>
              <div class="webhook-actions">
                <form method="post" action={`${base}/${webhook.id}/toggle`}>
                  <button type="submit" class="btn btn-small">
                    {webhook.active ? "Disable" : "Enable"}
                  </button>
                </form>
                <form
                  method="post"
                  action={`${base}/${webhook.id}/regenerate-secret`}
                  class="webhook-regenerate-form"
                >
                  <button type="submit" class="btn btn-small">
                    Regenerate secret
                  </button>
                </form>
                <form method="post" action={`${base}/${webhook.id}/delete`}>
                  <button type="submit" class="btn btn-small btn-danger">
                    Delete
                  </button>
                </form>
              </div>
            </div>
            <p class="webhook-meta">
              Events: <code>{webhook.events}</code> · Secret:{" "}
              <code>shown once on creation or regeneration</code>
            </p>
            {deliveries.length > 0 && (
              <details class="webhook-deliveries">
                <summary>Recent deliveries ({deliveries.length})</summary>
                <ul>
                  {deliveries.map((delivery) => (
                    <DeliveryRow delivery={delivery} key={delivery.id} />
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))
      )}
      {webhooks.length > 0 && (
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
            // Progressive enhancement only: regenerating invalidates the current
            // secret immediately, so every receiver verifying with it starts
            // rejecting deliveries. Without JS the form still posts.
            (function () {
              var forms = document.querySelectorAll('.webhook-regenerate-form');
              for (var i = 0; i < forms.length; i++) {
                forms[i].addEventListener('submit', function (event) {
                  if (!confirm("Regenerate this webhook's signing secret? The current secret stops working immediately, and receivers must be updated with the new one.")) {
                    event.preventDefault();
                  }
                });
              }
            })();
          `,
          }}
        />
      )}
    </Layout>
  );
};
