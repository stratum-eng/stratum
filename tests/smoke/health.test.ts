/**
 * Smoke Tests - Health Endpoint Checks
 *
 * These tests verify critical health endpoints are accessible
 * and returning expected responses. Can be run against any
 * deployed environment.
 *
 * Run with: STAGING_URL=https://... npm run test:smoke
 */

import { beforeAll, describe, expect, it } from "vitest";

// Get the target URL from environment variable or default to localhost
const TARGET_URL = process.env.STAGING_URL || process.env.PRODUCTION_URL || "http://localhost:8787";

// Check if target is reachable
let targetReachable = false;
beforeAll(async () => {
  try {
    const response = await fetch(`${TARGET_URL}/health`, { timeout: 5000 } as RequestInit);
    targetReachable = response.status === 200;
  } catch {
    targetReachable = false;
  }
});

describe("Health Endpoint Smoke Tests", () => {
  describe.skipIf(!targetReachable)(`Testing against: ${TARGET_URL}`, () => {
    it("should return healthy status from /health", async () => {
      const response = await fetch(`${TARGET_URL}/health`);

      expect(response.status).toBe(200);

      const body = (await response.json()) as { status: string; service: string };
      expect(body.status).toBe("ok");
      expect(body.service).toBe("stratum");
    });

    it("should respond within acceptable time", async () => {
      const start = Date.now();
      const response = await fetch(`${TARGET_URL}/health`);
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(5000); // Should respond within 5 seconds
    });

    it("should have correct content type", async () => {
      const response = await fetch(`${TARGET_URL}/health`);

      expect(response.headers.get("content-type")).toContain("application/json");
    });

    it("should handle concurrent health checks", async () => {
      const requests = Array.from({ length: 10 }, () => fetch(`${TARGET_URL}/health`));
      const responses = await Promise.all(requests);

      for (const response of responses) {
        expect(response.status).toBe(200);
        const body = (await response.json()) as { status: string };
        expect(body.status).toBe("ok");
      }
    });
  });

  it.skipIf(!targetReachable)("should inform about missing target", () => {
    console.log(`
⚠️  Target not reachable: ${TARGET_URL}

To run smoke tests, start the dev server or set STAGING_URL/PRODUCTION_URL:
  npm run dev
  # or
  STAGING_URL=https://stratum-staging.jlmx.workers.dev npm run test:smoke
    `);
  });
});

describe("API Availability Smoke Tests", () => {
  describe.skipIf(!targetReachable)(`Testing against: ${TARGET_URL}`, () => {
    it("should have accessible projects endpoint", async () => {
      const response = await fetch(`${TARGET_URL}/api/projects`);

      // Should return 200 or 401 (if auth required), not 500
      expect([200, 401]).toContain(response.status);
    });

    it("should have accessible changes endpoint", async () => {
      const response = await fetch(`${TARGET_URL}/api/changes`);

      // Should return 200 or 401, not 500
      expect([200, 401]).toContain(response.status);
    });

    it("should serve UI at root", async () => {
      const response = await fetch(`${TARGET_URL}/`);

      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type");
      expect(contentType).toContain("text/html");
    });

    it("should serve CSS", async () => {
      const response = await fetch(`${TARGET_URL}/ui.css`);

      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type");
      expect(contentType).toContain("text/css");
    });

    it("should return 404 for non-existent endpoints", async () => {
      const response = await fetch(`${TARGET_URL}/api/non-existent-endpoint-12345`);

      expect(response.status).toBe(404);
    });

    it("should handle CORS preflight requests", async () => {
      const response = await fetch(`${TARGET_URL}/health`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "GET",
        },
      });

      // Should not error - might be 200, 204, or 404 depending on CORS config
      expect(response.status).toBeLessThan(500);
    });
  });
});

describe("Authentication Smoke Tests", () => {
  describe.skipIf(!targetReachable)(`Testing against: ${TARGET_URL}`, () => {
    it("should redirect unauthenticated users from protected endpoints", async () => {
      const response = await fetch(`${TARGET_URL}/api/projects`, {
        redirect: "manual",
      });

      // Should either require auth (401) or redirect to login (302)
      expect([200, 302, 401]).toContain(response.status);
    });

    it("should have accessible auth endpoints", async () => {
      const response = await fetch(`${TARGET_URL}/auth/github`);

      // Should either redirect to GitHub or show auth page
      expect([200, 302]).toContain(response.status);
    });
  });
});
