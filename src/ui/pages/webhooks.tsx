import type { FC } from "hono/jsx";
import type { Webhook, WebhookDelivery } from "../../storage/webhooks";
import { Layout } from "../layout";

interface WebhooksPageProps {
  project: {
    name: string;
    namespace: string;
    slug: string;
  };
  webhooks: Array<{ webhook: Webhook; deliveries: WebhookDelivery[] }>;
  subscribableEvents: string[];
  user?: { id: string; email: string; username: string } | null;
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
}) => {
  const base = `/api/projects/${project.namespace}/${project.slug}/webhooks`;
  return (
    <Layout title={`Webhooks — ${project.name}`} user={user}>
      <div class="page-header">
        <h1>Webhooks</h1>
        <a class="btn" href={`/${project.namespace}/${project.slug}`}>
          Back to repo
        </a>
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
          <label>
            Events (comma-separated, or * for all)
            <input type="text" name="events" placeholder="*" />
          </label>
          <p class="webhook-help">Available: {subscribableEvents.join(", ")}</p>
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
                <form method="post" action={`${base}/${webhook.id}/delete`}>
                  <button type="submit" class="btn btn-small btn-danger">
                    Delete
                  </button>
                </form>
              </div>
            </div>
            <p class="webhook-meta">
              Events: <code>{webhook.events}</code> · Secret: <code>{webhook.secret}</code>
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
    </Layout>
  );
};
