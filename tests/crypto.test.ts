import { describe, expect, it } from "vitest";
import { constantTimeEqual, generateApiKey, hashToken, verifyToken } from "../src/utils/crypto";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("s3cret-key", "s3cret-key")).toBe(true);
  });

  it("returns false for same-length strings that differ", () => {
    expect(constantTimeEqual("s3cret-key", "s3cret-kez")).toBe(false);
  });

  it("returns false for different-length strings", () => {
    expect(constantTimeEqual("short", "longer-value")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("hashToken", () => {
  it("returns a 64-character hex string", async () => {
    const hash = await hashToken("hello");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", async () => {
    const a = await hashToken("same-input");
    const b = await hashToken("same-input");
    expect(a).toBe(b);
  });
});

describe("verifyToken", () => {
  it("returns true when plaintext matches the stored hash", async () => {
    const hash = await hashToken("correct-horse-battery-staple");
    expect(await verifyToken("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("returns false when plaintext does not match the stored hash", async () => {
    const hash = await hashToken("correct-horse-battery-staple");
    expect(await verifyToken("wrong-password", hash)).toBe(false);
  });
});

describe("generateApiKey", () => {
  it("starts with the given prefix followed by an underscore", async () => {
    const key = await generateApiKey("stratum_user");
    expect(key.startsWith("stratum_user_")).toBe(true);
  });

  it("returns different values on successive calls", async () => {
    const a = await generateApiKey("stratum_user");
    const b = await generateApiKey("stratum_user");
    expect(a).not.toBe(b);
  });

  it("has the expected total length (prefix + underscore + 32 hex chars)", async () => {
    const prefix = "stratum_user";
    const key = await generateApiKey(prefix);
    expect(key).toHaveLength(prefix.length + 1 + 32);
  });
});
