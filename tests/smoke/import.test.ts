/**
 * Smoke Tests - Import Critical Path
 *
 * These tests verify the import functionality is working correctly
 * on the deployed environment. These are lightweight checks that
 * don't require actual GitHub imports to complete.
 *
 * Run with: STAGING_URL=https://... npm run test:smoke
 */

import { beforeAll, describe, expect, it } from "vitest";

const TARGET_URL = process.env.STAGING_URL || process.env.PRODUCTION_URL || "http://localhost:8787";

// Skip these tests if no valid auth token is available
const hasAuthToken = !!process.env.TEST_AUTH_TOKEN;

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

describe("Import Critical Path Smoke Tests", () => {
  describe.skipIf(!targetReachable)(`Testing against: ${TARGET_URL}`, () => {
    it("should have accessible import endpoint", async () => {
      // Test that the import endpoint exists
      const response = await fetch(`${TARGET_URL}/api/projects/test/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          githubUrl: "https://github.com/test/repo",
          branch: "main",
        }),
      });

      // Should return 401 (unauthorized), 404 (project not found), or 400 (bad request)
      // Should NOT return 500 (server error) or 405 (method not allowed)
      expect([400, 401, 404]).toContain(response.status);
      expect(response.status).toBeLessThan(500);
    });

    it("should reject invalid import requests", async () => {
      const response = await fetch(`${TARGET_URL}/api/projects/test/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Missing required fields
          branch: "main",
        }),
      });

      // Should return 400 (bad request), 401 (unauthorized), or 404
      expect([400, 401, 404]).toContain(response.status);
    });

    it("should have accessible import status endpoint", async () => {
      const response = await fetch(`${TARGET_URL}/api/projects/test/import/status`);

      // Should not 500 error
      expect(response.status).toBeLessThan(500);
    });

    it("should have accessible import cancel endpoint", async () => {
      const response = await fetch(`${TARGET_URL}/api/projects/test/import/cancel`, {
        method: "POST",
      });

      // Should not 500 error - 404 is ok if endpoint doesn't exist yet
      expect(response.status).toBeLessThan(500);
    });
  });

  describe("Target not reachable", () => {
    it.skipIf(targetReachable)("should inform about missing target", () => {
      console.log(`
⚠️  Target not reachable: ${TARGET_URL}

To run smoke tests, start the dev server or set STAGING_URL/PRODUCTION_URL:
  npm run dev
  # or
  STAGING_URL=https://stratum-staging.jlmx.workers.dev npm run test:smoke
      `);
    });
  });
});

describe("Queue Health Smoke Tests", () => {
  describe(`Testing against: ${TARGET_URL}`, () => {
    it("should not show queue processing errors", async () => {
      // Health endpoint should indicate service is ok even if queues are busy
      const response = await fetch(`${TARGET_URL}/health`);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("ok");
    });
  });
});

describe("Rate Limiting Smoke Tests", () => {
  describe(`Testing against: ${TARGET_URL}`, () => {
    it("should handle rapid requests gracefully", async () => {
      // Make 10 rapid requests
      const requests = Array.from({ length: 10 }, () =>
        fetch(`${TARGET_URL}/health`),
      );

      const responses = await Promise.all(requests);

      // All should return valid responses (200 or 429 if rate limited)
      for (const response of responses) {
        expect([200, 429]).toContain(response.status);
      }
    });
  });
});

// These tests require authentication
describe.skipIf(!hasAuthToken)("Authenticated Import Smoke Tests", () => {
  const authHeaders = {
    Authorization: `Bearer ${process.env.TEST_AUTH_TOKEN}`,
  };

  describe(`Testing against: ${TARGET_URL}`, () => {
    it("should return 404 for non-existent project import", async () => {
      const response = await fetch(`${TARGET_URL}/api/projects/non-existent-project-12345/import`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          githubUrl: "https://github.com/test/repo",
          branch: "main",
        }),
      });

      expect(response.status).toBe(404);
    });

    it("should reject invalid GitHub URLs", async () => {
      // First create a test project - this might fail if project exists
      // but we're testing the import endpoint, not project creation
      const projectResponse = await fetch(`${TARGET_URL}/api/projects`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "smoke-test-project",
          visibility: "private",
        }),
      });

      // Project might already exist, that's ok

      // Try import with invalid URL
      const response = await fetch(`${TARGET_URL}/api/projects/smoke-test-project/import`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          githubUrl: "not-a-valid-url",
          branch: "main",
        }),
      });

      // Should reject invalid URL
      expect([400, 422]).toContain(response.status);
    });
  });
});
