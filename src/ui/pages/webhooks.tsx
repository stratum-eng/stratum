import type { FC } from "hono/jsx";
import type { Webhook, WebhookDelivery } from "../../storage/webhooks";
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
  user?: { id: string; email: string; username: string } | null;
  /** Per-request CSP nonce — required so the regenerate confirm script passes `script-src`. */
  nonce: string;
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
  user,
  nonce,
}) => {
  const base = `/api/projects/${project.namespace}/${project.slug}/webhooks`;
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
        <form method="post" action={base} class="webhook-form">
          <label>
            Payload URL
            <input type="url" name="url" placeholder="https://example.com/hooks/stratum" required />
          </label>
          <fieldset class="webhook-events">
            <legend>Events to deliver</legend>
            <label class="checkbox-label">
              <input type="checkbox" name="events" value="*" checked />
              All events
            </label>
            <div class="webhook-events-grid">
              {subscribableEvents.map((event) => (
                <label class="checkbox-label" key={event}>
                  <input type="checkbox" name="events" value={event} />
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
                  if (!confirm('Regenerate this webhook\'s signing secret? The current secret stops working immediately, and receivers must be updated with the new one.')) {
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
