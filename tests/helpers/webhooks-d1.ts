export interface WebhookTableRow {
  id: string;
  project: string;
  project_id: string | null;
  url: string;
  secret: string;
  events: string;
  active: number;
  created_by: string;
  created_at: string;
}

export interface DeliveryTableRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  status: string;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

/** Minimal stateful D1 stub understanding the queries webhook storage issues. */
export function makeWebhooksD1(): {
  db: D1Database;
  webhooks: WebhookTableRow[];
  deliveries: DeliveryTableRow[];
} {
  const webhooks: WebhookTableRow[] = [];
  const deliveries: DeliveryTableRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (upper.startsWith("INSERT INTO WEBHOOKS")) {
          webhooks.push({
            id: bindings[0] as string,
            project: bindings[1] as string,
            project_id: bindings[2] as string | null,
            url: bindings[3] as string,
            secret: bindings[4] as string,
            events: bindings[5] as string,
            active: 1,
            created_by: bindings[6] as string,
            created_at: bindings[7] as string,
          });
        } else if (upper.startsWith("INSERT INTO WEBHOOK_DELIVERIES")) {
          deliveries.push({
            id: bindings[0] as string,
            webhook_id: bindings[1] as string,
            event_id: bindings[2] as string,
            event_type: bindings[3] as string,
            status: bindings[4] as string,
            status_code: bindings[5] as number | null,
            error: bindings[6] as string | null,
            duration_ms: bindings[7] as number | null,
            created_at: bindings[8] as string,
          });
        } else if (upper.startsWith("UPDATE WEBHOOKS SET ACTIVE")) {
          const row = webhooks.find((w) => w.id === bindings[1]);
          if (row) row.active = bindings[0] as number;
        } else if (upper.startsWith("DELETE FROM WEBHOOK_DELIVERIES")) {
          for (let i = deliveries.length - 1; i >= 0; i--) {
            if (deliveries[i]?.webhook_id === bindings[0]) deliveries.splice(i, 1);
          }
        } else if (upper.startsWith("DELETE FROM WEBHOOKS")) {
          const index = webhooks.findIndex((w) => w.id === bindings[0]);
          if (index >= 0) webhooks.splice(index, 1);
        }
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        return (webhooks.find((w) => w.id === bindings[0]) ?? null) as T | null;
      },
      all: async <T>() => {
        let results: unknown[];
        if (upper.includes("FROM WEBHOOK_DELIVERIES")) {
          results = deliveries
            .filter((d) => d.webhook_id === bindings[0])
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, bindings[1] as number);
        } else if (upper.includes("AND ACTIVE = 1")) {
          results = webhooks.filter((w) => w.project === bindings[0] && w.active === 1);
        } else {
          results = webhooks.filter((w) => w.project === bindings[0]);
        }
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
  return { db, webhooks, deliveries };
}
