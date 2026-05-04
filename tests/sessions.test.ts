import { describe, expect, it } from "vitest";
import {
  createSession,
  deleteAllUserSessions,
  deleteSession,
  getUserSessions,
  refreshSession,
} from "../src/storage/sessions";

describe("Session Storage Functions", () => {
  // Note: These are unit tests for the storage functions
  // Integration tests would require a real D1 database

  describe("createSession", () => {
    it("should be defined", () => {
      expect(createSession).toBeDefined();
      expect(typeof createSession).toBe("function");
    });

    it("should accept rememberMe parameter", () => {
      // Verify function signature accepts rememberMe
      const fn = createSession;
      expect(fn.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("refreshSession", () => {
    it("should be defined", () => {
      expect(refreshSession).toBeDefined();
      expect(typeof refreshSession).toBe("function");
    });

    it("should accept rememberMe parameter", () => {
      const fn = refreshSession;
      expect(fn.length).toBe(4);
    });
  });

  describe("deleteAllUserSessions", () => {
    it("should be defined", () => {
      expect(deleteAllUserSessions).toBeDefined();
      expect(typeof deleteAllUserSessions).toBe("function");
    });
  });

  describe("getUserSessions", () => {
    it("should be defined", () => {
      expect(getUserSessions).toBeDefined();
      expect(typeof getUserSessions).toBe("function");
    });
  });

  describe("deleteSession", () => {
    it("should be defined", () => {
      expect(deleteSession).toBeDefined();
      expect(typeof deleteSession).toBe("function");
    });
  });
});

describe("Session Router", () => {
  it("should have session router defined", async () => {
    const { sessionRouter } = await import("../src/routes/sessions");
    expect(sessionRouter).toBeDefined();
  });

  it("should export session router", async () => {
    const { sessionRouter } = await import("../src/routes/sessions");
    expect(sessionRouter).toBeTruthy();
  });
});
