import { describe, expect, it, vi } from "vitest";
import { getFileContent, isValidFilePath } from "../src/ui/file-content";
import { defaultLogger } from "../src/utils/logger";

vi.mock("../src/storage/git-ops", () => ({
  readFileFromRepo: vi.fn(),
}));

import { readFileFromRepo } from "../src/storage/git-ops";

describe("isValidFilePath", () => {
  it("accepts a simple root-level filename", () => {
    expect(isValidFilePath("README.md")).toBe(true);
  });

  it("accepts a nested path", () => {
    expect(isValidFilePath("src/utils/helpers.ts")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidFilePath("")).toBe(false);
  });

  it("rejects .. segment", () => {
    expect(isValidFilePath("../etc/passwd")).toBe(false);
  });

  it("rejects .. in middle of path", () => {
    expect(isValidFilePath("src/../secret")).toBe(false);
  });

  it("rejects . segment", () => {
    expect(isValidFilePath("./file.ts")).toBe(false);
  });

  it("rejects absolute path", () => {
    expect(isValidFilePath("/etc/passwd")).toBe(false);
  });

  it("rejects path containing null byte", () => {
    expect(isValidFilePath("src/\0file.ts")).toBe(false);
  });

  it("rejects path longer than 4096 characters", () => {
    expect(isValidFilePath("a".repeat(4097))).toBe(false);
  });

  it("accepts path of exactly 4096 characters", () => {
    expect(isValidFilePath("a".repeat(4096))).toBe(true);
  });
});

describe("getFileContent", () => {
  it("returns content for a normal file", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValueOnce({
      success: true,
      data: "export const x = 1;",
    });
    const result = await getFileContent("remote", "token", "src/index.ts", defaultLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: "content", value: "export const x = 1;" });
    }
  });

  it("returns binary for content containing null byte", async () => {
    vi.mocked(readFileFromRepo).mockResolvedValueOnce({ success: true, data: "PNG\0binary" });
    const result = await getFileContent("remote", "token", "image.png", defaultLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: "binary" });
    }
  });

  it("returns oversize for content exceeding 512 KB", async () => {
    const bigContent = "x".repeat(513 * 1024);
    vi.mocked(readFileFromRepo).mockResolvedValueOnce({ success: true, data: bigContent });
    const result = await getFileContent("remote", "token", "big.txt", defaultLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: "oversize" });
    }
  });

  it("returns not-found for FS_ERROR", async () => {
    const { AppError } = await import("../src/utils/errors");
    vi.mocked(readFileFromRepo).mockResolvedValueOnce({
      success: false,
      error: new AppError("not found", "FS_ERROR", 500),
    });
    const result = await getFileContent("remote", "token", "missing.ts", defaultLogger);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: "not-found" });
    }
  });

  it("propagates non-FS errors as failure", async () => {
    const { AppError } = await import("../src/utils/errors");
    vi.mocked(readFileFromRepo).mockResolvedValueOnce({
      success: false,
      error: new AppError("network error", "NETWORK_ERROR", 502),
    });
    const result = await getFileContent("remote", "token", "file.ts", defaultLogger);
    expect(result.success).toBe(false);
  });
});
