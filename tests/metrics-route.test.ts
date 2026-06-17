import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/admin", () => ({ isAdminRequest: vi.fn() }));
vi.mock("../src/storage/metrics", () => ({
  getMetricsSummary: vi.fn(),
  getQueueDepth: vi.fn(),
  getCommitMetrics: vi.fn(),
}));

import { metricsRouter } from "../src/routes/metrics";
import { getCommitMetrics, getMetricsSummary, getQueueDepth } from "../src/storage/metrics";
import type { Env } from "../src/types";
import { isAdminRequest } from "../src/utils/admin";

const env = { DB: {} } as unknown as Env;

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/", metricsRouter);
  return a;
}

const summary = {
  totalStarted: 0,
  totalCompleted: 0,
  totalFailed: 0,
  totalCancelled: 0,
  successRate: 0,
  failureRate: 0,
  averageDurationMs: 0,
  last24h: { started: 0, completed: 0, failed: 0, cancelled: 0 },
  last7d: { started: 0, completed: 0, failed: 0, cancelled: 0 },
  last30d: { started: 0, completed: 0, failed: 0, cancelled: 0 },
  errorTypes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMetricsSummary).mockResolvedValue({ success: true, data: summary });
  vi.mocked(getQueueDepth).mockResolvedValue({ success: true, data: 0 });
});

describe("GET /api/admin/metrics commits block", () => {
  it("returns 401 without admin access", async () => {
    vi.mocked(isAdminRequest).mockResolvedValue(false);
    const res = await app().request("/", {}, env);
    expect(res.status).toBe(401);
  });

  it("includes the commits block when commit metrics are available", async () => {
    vi.mocked(isAdminRequest).mockResolvedValue(true);
    vi.mocked(getCommitMetrics).mockResolvedValue({
      success: true,
      data: {
        count: 3,
        outcomes: { fast_forward: 2, cold_fallback: 1, squash: 0 },
        // biome-ignore lint/suspicious/noExplicitAny: stat shape not under test
        total: { avg: 100, p50: 90, p95: 200, count: 3 } as any,
        // biome-ignore lint/suspicious/noExplicitAny: phases shape not under test
        phases: {} as any,
      },
    });
    const res = await app().request("/", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commits?: { count: number } };
    expect(body.commits?.count).toBe(3);
  });

  it("still returns 200 (omitting commits) when commit metrics fail", async () => {
    vi.mocked(isAdminRequest).mockResolvedValue(true);
    vi.mocked(getCommitMetrics).mockResolvedValue({
      success: false,
      // biome-ignore lint/suspicious/noExplicitAny: error shape not under test
      error: { message: "db down" } as any,
    });
    const res = await app().request("/", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commits?: unknown };
    expect(body.commits).toBeUndefined();
  });
});
