import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverEventToWebhooks, signPayload } from "../src/queue/webhook-delivery";
import type { EventRecord } from "../src/storage/events";
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  setWebhookActive,
  webhookMatchesEvent,
} from "../src/storage/webhooks";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { validateWebhookUrl } from "../src/utils/validation";
import { makeWebhooksD1 } from "./helpers/webhooks-d1";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "evt_1",
    type: "change.merged",
    project: "my-project",
    actorType: "user",
    actorId: "user_1",
    payload: { changeId: "chg_1", commit: "abc" },
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("webhook storage", () => {
  it("creates webhooks with a generated signing secret", async () => {
    const { db } = makeWebhooksD1();
    const result = await createWebhook(db, mockLogger, {
      project: "p",
      url: "https://example.com/hook",
      createdBy: "user_1",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.secret).toMatch(/^stm_whsec_[0-9a-f]{32}$/);
    expect(result.data.events).toBe("*");
    expect(result.data.active).toBe(true);
  });

  it("lists, toggles, and deletes webhooks", async () => {
    const { db, deliveries } = makeWebhooksD1();
    const created = await createWebhook(db, mockLogger, {
      project: "p",
      url: "https://example.com/hook",
      createdBy: "user_1",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const id = created.data.id;

    await setWebhookActive(db, mockLogger, id, false);
    const activeOnly = await listWebhooks(db, mockLogger, "p", { activeOnly: true });
    expect(activeOnly.success).toBe(true);
    if (!activeOnly.success) return;
    expect(activeOnly.data).toHaveLength(0);

    const all = await listWebhooks(db, mockLogger, "p");
    expect(all.success).toBe(true);
    if (!all.success) return;
    expect(all.data).toHaveLength(1);
    expect(all.data[0]?.active).toBe(false);

    deliveries.push({
      id: "whd_1",
      webhook_id: id,
      event_id: "evt_1",
      event_type: "change.merged",
      status: "success",
      status_code: 200,
      error: null,
      duration_ms: 12,
      created_at: new Date().toISOString(),
    });
    await deleteWebhook(db, mockLogger, id);
    const afterDelete = await listWebhooks(db, mockLogger, "p");
    expect(afterDelete.success).toBe(true);
    if (!afterDelete.success) return;
    expect(afterDelete.data).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("matches events by exact type or wildcard", () => {
    const base = {
      id: "wh_1",
      project: "p",
      url: "https://example.com",
      secret: "s",
      active: true,
      createdBy: "u",
      createdAt: "",
    };
    expect(webhookMatchesEvent({ ...base, events: "*" }, "change.merged")).toBe(true);
    expect(
      webhookMatchesEvent({ ...base, events: "change.merged, change.rejected" }, "change.merged"),
    ).toBe(true);
    expect(webhookMatchesEvent({ ...base, events: "change.rejected" }, "change.merged")).toBe(
      false,
    );
  });
});

describe("signPayload", () => {
  it("produces a stable HMAC-SHA256 hex signature", async () => {
    const signature = await signPayload("secret", '{"a":1}');
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await signPayload("secret", '{"a":1}')).toBe(signature);
    expect(await signPayload("other", '{"a":1}')).not.toBe(signature);
  });
});

describe("deliverEventToWebhooks", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup(events = "*") {
    const { db, deliveries } = makeWebhooksD1();
    const created = await createWebhook(db, mockLogger, {
      project: "my-project",
      url: "https://example.com/hook",
      events,
      createdBy: "user_1",
    });
    if (!created.success) throw new Error("setup failed");
    return { db, deliveries, webhook: created.data, env: { DB: db } as unknown as Env };
  }

  it("delivers a signed payload and records success", async () => {
    const { env, deliveries, webhook } = await setup();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const event = makeEvent();
    await deliverEventToWebhooks(env, event, mockLogger);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Stratum-Event"]).toBe("change.merged");
    expect(headers["X-Stratum-Signature"]).toBe(
      await signPayload(webhook.secret, init.body as string),
    );
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe("change.merged");
    expect(body.payload).toEqual({ changeId: "chg_1", commit: "abc" });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("success");
    expect(deliveries[0]?.status_code).toBe(200);
  });

  it("records failure on non-2xx responses and network errors without throwing", async () => {
    const { env, deliveries } = await setup();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await deliverEventToWebhooks(env, makeEvent({ id: "evt_a" }), mockLogger);

    fetchMock.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      deliverEventToWebhooks(env, makeEvent({ id: "evt_b" }), mockLogger),
    ).resolves.toBeUndefined();

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]?.status).toBe("failed");
    expect(deliveries[0]?.status_code).toBe(500);
    expect(deliveries[1]?.status).toBe("failed");
    expect(deliveries[1]?.error).toContain("connection refused");
  });

  it("skips webhooks whose event filter does not match", async () => {
    const { env } = await setup("change.rejected");
    await deliverEventToWebhooks(env, makeEvent(), mockLogger);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips inactive webhooks", async () => {
    const { env, db, webhook } = await setup();
    await setWebhookActive(db, mockLogger, webhook.id, false);
    await deliverEventToWebhooks(env, makeEvent(), mockLogger);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates failures so one bad receiver does not block others", async () => {
    const { db, deliveries } = makeWebhooksD1();
    await createWebhook(db, mockLogger, {
      project: "my-project",
      url: "https://bad.example.com/hook",
      createdBy: "u",
    });
    await createWebhook(db, mockLogger, {
      project: "my-project",
      url: "https://good.example.com/hook",
      createdBy: "u",
    });
    const env = { DB: db } as unknown as Env;

    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://bad")) throw new Error("boom");
      return new Response("ok", { status: 200 });
    });

    await deliverEventToWebhooks(env, makeEvent(), mockLogger);

    expect(deliveries).toHaveLength(2);
    const statuses = deliveries.map((d) => d.status).sort();
    expect(statuses).toEqual(["failed", "success"]);
  });

  it("records deliveries via listDeliveries", async () => {
    const { env, db, webhook } = await setup();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await deliverEventToWebhooks(env, makeEvent(), mockLogger);

    const result = await listDeliveries(db, mockLogger, webhook.id);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.eventType).toBe("change.merged");
  });
});

describe("validateWebhookUrl", () => {
  it("accepts public http(s) URLs", () => {
    expect(validateWebhookUrl("https://example.com/hook").success).toBe(true);
    expect(validateWebhookUrl("http://ci.example.io/path?x=1").success).toBe(true);
  });

  it("rejects non-http schemes and malformed URLs", () => {
    expect(validateWebhookUrl("ftp://example.com").success).toBe(false);
    expect(validateWebhookUrl("javascript:alert(1)").success).toBe(false);
    expect(validateWebhookUrl("not a url").success).toBe(false);
    expect(validateWebhookUrl(42).success).toBe(false);
  });

  it("rejects private and loopback hosts", () => {
    expect(validateWebhookUrl("http://localhost/hook").success).toBe(false);
    expect(validateWebhookUrl("http://127.0.0.1/hook").success).toBe(false);
    expect(validateWebhookUrl("http://10.1.2.3/hook").success).toBe(false);
    expect(validateWebhookUrl("http://192.168.1.1/hook").success).toBe(false);
    expect(validateWebhookUrl("http://172.16.0.1/hook").success).toBe(false);
    expect(validateWebhookUrl("http://169.254.169.254/latest/meta-data").success).toBe(false);
    expect(validateWebhookUrl("http://[::1]/hook").success).toBe(false);
    expect(validateWebhookUrl("http://[fd00::1]/hook").success).toBe(false);
    expect(validateWebhookUrl("http://internal-service/hook").success).toBe(false);
    expect(validateWebhookUrl("http://api.corp.internal/hook").success).toBe(false);
  });

  it("does not reject public hosts that resemble IPv6 prefixes", () => {
    expect(validateWebhookUrl("https://fcc.gov/hook").success).toBe(true);
    expect(validateWebhookUrl("https://fe80.example.com/hook").success).toBe(true);
  });
});
