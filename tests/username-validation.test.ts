import { describe, expect, it, vi } from "vitest";
import {
  getReservedUsernames,
  isReservedUsername,
  isValidUsername,
  sanitizeUsername,
  validateUsername,
} from "../src/utils/username-validation";

describe("Username Validation", () => {
  describe("validateUsername", () => {
    describe("valid usernames", () => {
      it("accepts a simple lowercase username", () => {
        const result = validateUsername("alice");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("alice");
        }
      });

      it("accepts username with numbers", () => {
        const result = validateUsername("alice123");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("alice123");
        }
      });

      it("accepts username with hyphens", () => {
        const result = validateUsername("alice-smith");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("alice-smith");
        }
      });

      it("accepts username starting with letter containing hyphens and numbers", () => {
        const result = validateUsername("a1-b2-c3");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("a1-b2-c3");
        }
      });

      it("accepts username at minimum length", () => {
        const result = validateUsername("abc");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("abc");
        }
      });

      it("accepts username at maximum length", () => {
        const longUsername = "a".repeat(39);
        const result = validateUsername(longUsername);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(longUsername);
        }
      });

      it("normalizes to lowercase", () => {
        const result = validateUsername("AliceSmith");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("alicesmith");
        }
      });

      it("trims whitespace", () => {
        const result = validateUsername("  alice  ");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("alice");
        }
      });
    });

    describe("invalid usernames - type and empty", () => {
      it("rejects non-string values", () => {
        const result = validateUsername(123);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toHaveLength(1);
          expect(result.error[0]?.message).toBe("Username must be a string");
        }
      });

      it("rejects null", () => {
        const result = validateUsername(null);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error[0]?.message).toBe("Username must be a string");
        }
      });

      it("rejects undefined", () => {
        const result = validateUsername(undefined);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error[0]?.message).toBe("Username must be a string");
        }
      });

      it("rejects empty string", () => {
        const result = validateUsername("");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error[0]?.message).toBe("Username cannot be empty");
        }
      });

      it("rejects whitespace-only string", () => {
        const result = validateUsername("   ");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error[0]?.message).toBe("Username cannot be empty");
        }
      });
    });

    describe("invalid usernames - length", () => {
      it("rejects username shorter than 3 characters", () => {
        const result = validateUsername("ab");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("at least"))).toBe(true);
        }
      });

      it("rejects single character username", () => {
        const result = validateUsername("a");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("at least"))).toBe(true);
        }
      });

      it("rejects username longer than 39 characters", () => {
        const tooLong = "a".repeat(40);
        const result = validateUsername(tooLong);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("no more than"))).toBe(true);
        }
      });

      it("rejects username longer than 39 characters", () => {
        const tooLong = `alice${"smith".repeat(10)}`;
        const result = validateUsername(tooLong);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("no more than"))).toBe(true);
        }
      });
    });

    describe("invalid usernames - characters", () => {
      it("accepts uppercase letters after normalization", () => {
        const result = validateUsername("Alice");
        expect(result.success).toBe(true);
      });

      it("rejects special characters", () => {
        const result = validateUsername("alice@smith");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("can only contain"))).toBe(true);
        }
      });

      it("rejects spaces", () => {
        const result = validateUsername("alice smith");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("can only contain"))).toBe(true);
        }
      });

      it("rejects underscores", () => {
        const result = validateUsername("alice_smith");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("can only contain"))).toBe(true);
        }
      });

      it("rejects dots", () => {
        const result = validateUsername("alice.smith");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("can only contain"))).toBe(true);
        }
      });
    });

    describe("invalid usernames - start/end rules", () => {
      it("rejects username starting with a number", () => {
        const result = validateUsername("1alice");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("start with a letter"))).toBe(true);
        }
      });

      it("rejects username starting with a hyphen", () => {
        const result = validateUsername("-alice");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("start with a letter"))).toBe(true);
        }
      });

      it("rejects username ending with a hyphen", () => {
        const result = validateUsername("alice-");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("end with a letter or number"))).toBe(
            true,
          );
        }
      });

      it("accepts username ending with a number", () => {
        const result = validateUsername("alice1");
        expect(result.success).toBe(true);
      });
    });

    describe("invalid usernames - consecutive hyphens", () => {
      it("rejects username with consecutive hyphens", () => {
        const result = validateUsername("alice--smith");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("consecutive hyphens"))).toBe(true);
        }
      });

      it("rejects username with multiple consecutive hyphens", () => {
        const result = validateUsername("alice---smith");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("consecutive hyphens"))).toBe(true);
        }
      });

      it("rejects username with consecutive hyphens at start", () => {
        const result = validateUsername("--alice");
        expect(result.success).toBe(false);
      });

      it("rejects username with consecutive hyphens at end", () => {
        const result = validateUsername("alice--");
        expect(result.success).toBe(false);
      });
    });

    describe("invalid usernames - numbers only", () => {
      it("rejects username with only numbers", () => {
        const result = validateUsername("12345");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("only numbers"))).toBe(true);
        }
      });

      it("rejects numeric username at minimum length", () => {
        const result = validateUsername("123");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("only numbers"))).toBe(true);
        }
      });
    });

    describe("invalid usernames - reserved names", () => {
      it("rejects reserved username api", () => {
        const result = validateUsername("api");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.some((e) => e.message.includes("reserved"))).toBe(true);
        }
      });

      it("rejects reserved username admin", () => {
        const result = validateUsername("admin");
        expect(result.success).toBe(false);
      });

      it("rejects reserved username www", () => {
        const result = validateUsername("www");
        expect(result.success).toBe(false);
      });

      it("rejects reserved username test", () => {
        const result = validateUsername("test");
        expect(result.success).toBe(false);
      });

      it("rejects reserved single letter a", () => {
        const result = validateUsername("a");
        expect(result.success).toBe(false);
      });

      it("rejects reserved single letter z", () => {
        const result = validateUsername("z");
        expect(result.success).toBe(false);
      });

      it("rejects reserved username api-v1", () => {
        const result = validateUsername("api-v1");
        expect(result.success).toBe(false);
      });

      it("rejects reserved username case-insensitively", () => {
        const result = validateUsername("API");
        expect(result.success).toBe(false);
      });

      it("accepts username containing reserved word as substring", () => {
        const result = validateUsername("myapi");
        expect(result.success).toBe(true);
      });

      it("accepts username with reserved word plus suffix", () => {
        const result = validateUsername("apiuser");
        expect(result.success).toBe(true);
      });
    });

    describe("multiple validation errors", () => {
      it("returns multiple errors for severely invalid username", () => {
        const result = validateUsername("--123@#$");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.length).toBeGreaterThan(1);
        }
      });
    });

    describe("logging", () => {
      it("uses custom logger when provided", () => {
        const mockLogger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          trace: vi.fn(),
          fatal: vi.fn(),
          child: vi.fn().mockReturnThis(),
        };

        validateUsername("alice", mockLogger as unknown as Parameters<typeof validateUsername>[1]);
        expect(mockLogger.debug).toHaveBeenCalled();
      });
    });
  });

  describe("isReservedUsername", () => {
    it("returns true for reserved username api", () => {
      expect(isReservedUsername("api")).toBe(true);
    });

    it("returns true for reserved username admin", () => {
      expect(isReservedUsername("admin")).toBe(true);
    });

    it("returns true for reserved username case-insensitively", () => {
      expect(isReservedUsername("ADMIN")).toBe(true);
      expect(isReservedUsername("Admin")).toBe(true);
    });

    it("returns true for reserved single letter", () => {
      expect(isReservedUsername("x")).toBe(true);
    });

    it("returns false for non-reserved username", () => {
      expect(isReservedUsername("alice")).toBe(false);
    });

    it("returns false for username containing reserved word", () => {
      expect(isReservedUsername("myapi")).toBe(false);
    });

    it("trims whitespace", () => {
      expect(isReservedUsername("  api  ")).toBe(true);
    });
  });

  describe("isValidUsername", () => {
    it("returns true for valid username", () => {
      expect(isValidUsername("alice")).toBe(true);
    });

    it("returns true for valid username with numbers", () => {
      expect(isValidUsername("alice123")).toBe(true);
    });

    it("returns true for valid username with hyphens", () => {
      expect(isValidUsername("alice-smith")).toBe(true);
    });

    it("returns false for non-string value", () => {
      expect(isValidUsername(123)).toBe(false);
    });

    it("returns false for too short username", () => {
      expect(isValidUsername("ab")).toBe(false);
    });

    it("returns false for too long username", () => {
      expect(isValidUsername("a".repeat(40))).toBe(false);
    });

    it("returns false for reserved username", () => {
      expect(isValidUsername("api")).toBe(false);
    });

    it("returns false for username starting with number", () => {
      expect(isValidUsername("1alice")).toBe(false);
    });

    it("returns false for username ending with hyphen", () => {
      expect(isValidUsername("alice-")).toBe(false);
    });

    it("returns false for username with consecutive hyphens", () => {
      expect(isValidUsername("alice--smith")).toBe(false);
    });

    it("returns false for numbers-only username", () => {
      expect(isValidUsername("12345")).toBe(false);
    });

    it("returns false for username with invalid characters", () => {
      expect(isValidUsername("alice_smith")).toBe(false);
    });

    it("narrows type correctly", () => {
      const value: unknown = "alice";
      if (isValidUsername(value)) {
        expect(typeof value).toBe("string");
      }
    });
  });

  describe("sanitizeUsername", () => {
    it("converts to lowercase", () => {
      expect(sanitizeUsername("Alice")).toBe("alice");
    });

    it("trims whitespace", () => {
      expect(sanitizeUsername("  alice  ")).toBe("alice");
    });

    it("removes invalid characters", () => {
      expect(sanitizeUsername("alice@smith")).toBe("alicesmith");
    });

    it("converts underscores to hyphens", () => {
      expect(sanitizeUsername("alice_smith")).toBe("alice-smith");
    });

    it("converts spaces to hyphens", () => {
      expect(sanitizeUsername("alice smith")).toBe("alice-smith");
    });

    it("removes special characters", () => {
      expect(sanitizeUsername("a!l@i#c$e%")).toBe("alice");
    });

    it("collapses consecutive hyphens", () => {
      expect(sanitizeUsername("alice--smith")).toBe("alice-smith");
    });

    it("collapses multiple consecutive hyphens", () => {
      expect(sanitizeUsername("alice---smith")).toBe("alice-smith");
    });

    it("trims hyphens from start", () => {
      expect(sanitizeUsername("-alice")).toBe("alice");
    });

    it("trims hyphens from end", () => {
      expect(sanitizeUsername("alice-")).toBe("alice");
    });

    it("trims multiple hyphens from start", () => {
      expect(sanitizeUsername("---alice")).toBe("alice");
    });

    it("trims multiple hyphens from end", () => {
      expect(sanitizeUsername("alice---")).toBe("alice");
    });

    it("limits length to 39 characters", () => {
      const longInput = "a".repeat(100);
      const result = sanitizeUsername(longInput);
      expect(result.length).toBeLessThanOrEqual(39);
    });

    it("handles complex input with multiple issues", () => {
      const result = sanitizeUsername("  --Alice_Smith--123--  ");
      expect(result).toBe("alice-smith-123");
    });

    it("returns empty string for all-invalid input", () => {
      const result = sanitizeUsername("!!!");
      expect(result).toBe("");
    });
  });

  describe("getReservedUsernames", () => {
    it("returns array of reserved usernames", () => {
      const reserved = getReservedUsernames();
      expect(Array.isArray(reserved)).toBe(true);
      expect(reserved.length).toBeGreaterThan(0);
    });

    it("includes expected reserved names", () => {
      const reserved = getReservedUsernames();
      expect(reserved).toContain("api");
      expect(reserved).toContain("admin");
      expect(reserved).toContain("www");
      expect(reserved).toContain("a");
      expect(reserved).toContain("z");
    });

    it("returns read-only type", () => {
      const reserved = getReservedUsernames();
      // Type is readonly string[] - compile-time protection
      expect(Array.isArray(reserved)).toBe(true);
      // Verify it's the expected type annotation by checking we can't modify it via types
      expect(Object.isFrozen(reserved)).toBe(false); // Not frozen at runtime, just typed as readonly
    });
  });
});
