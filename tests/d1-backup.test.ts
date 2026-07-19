import { describe, expect, it, vi } from "vitest";
import { BACKUP_TABLES, exportTable, restoreTable } from "../src/storage/d1-backup";
import type { Logger } from "../src/utils/logger";
import { makeFakeD1 } from "./helpers/fake-d1";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

describe("D1 table export/restore", () => {
  it("round-trips rows through NDJSON into a fresh table", async () => {
    const src = makeFakeD1();
    src.seed("users", [
      { id: "u1", email: "a@x.com", username: "a" },
      { id: "u2", email: "b@x.com", username: "b" },
    ]);

    const dump = await exportTable(src, "users", logger);
    expect(dump.success).toBe(true);
    if (!dump.success) return;
    expect(dump.data.rowCount).toBe(2);
    expect(dump.data.columns).toEqual(["id", "email", "username"]);

    const dst = makeFakeD1();
    const restored = await restoreTable(dst, "users", dump.data.ndjson, logger);
    expect(restored.success && restored.data.inserted).toBe(2);
    expect(dst.rows("users")).toEqual([
      { id: "u1", email: "a@x.com", username: "a" },
      { id: "u2", email: "b@x.com", username: "b" },
    ]);
  });

  it("paginates across multiple pages (>PAGE_SIZE rows)", async () => {
    const src = makeFakeD1();
    const rows = Array.from({ length: 1200 }, (_v, i) => ({ id: `c${i}`, project: "p" }));
    src.seed("changes", rows);

    const dump = await exportTable(src, "changes", logger);
    expect(dump.success).toBe(true);
    if (!dump.success) return;
    expect(dump.data.rowCount).toBe(1200);

    const dst = makeFakeD1();
    const restored = await restoreTable(dst, "changes", dump.data.ndjson, logger);
    expect(restored.success && restored.data.inserted).toBe(1200);
    expect(dst.rows("changes").length).toBe(1200);
  });

  it("restores FK-parented tables top-to-bottom without dangling refs", async () => {
    const src = makeFakeD1();
    src.seed("users", [{ id: "u1", email: "a@x.com", username: "a" }]);
    src.seed("agents", [{ id: "ag1", owner_id: "u1", name: "bot" }]);
    src.seed("changes", [{ id: "c1", agent_id: "ag1", project: "p" }]);

    const dst = makeFakeD1();
    // BACKUP_TABLES order puts users before agents before changes.
    for (const table of ["users", "agents", "changes"]) {
      const dump = await exportTable(src, table, logger);
      expect(dump.success).toBe(true);
      if (!dump.success) return;
      const r = await restoreTable(dst, table, dump.data.ndjson, logger);
      expect(r.success).toBe(true);
    }
    expect(dst.rows("changes")[0]).toMatchObject({ id: "c1", agent_id: "ag1" });
    // Sanity: the allow-list actually orders users < agents < changes.
    expect(BACKUP_TABLES.indexOf("users")).toBeLessThan(BACKUP_TABLES.indexOf("agents"));
    expect(BACKUP_TABLES.indexOf("agents")).toBeLessThan(BACKUP_TABLES.indexOf("changes"));
  });

  it("rejects a dump whose header table doesn't match the target", async () => {
    const src = makeFakeD1();
    src.seed("users", [{ id: "u1", email: "a", username: "a" }]);
    const dump = await exportTable(src, "users", logger);
    if (!dump.success) throw new Error("export failed");
    const dst = makeFakeD1();
    const res = await restoreTable(dst, "agents", dump.data.ndjson, logger);
    expect(res.success).toBe(false);
  });

  it("fails loudly on a non-serializable (BLOB-like) column", async () => {
    const src = makeFakeD1();
    src.seed("users", [{ id: "u1", email: "a", blobcol: new Uint8Array([1, 2, 3]) }]);
    const dump = await exportTable(src, "users", logger);
    expect(dump.success).toBe(false);
  });

  it("handles an empty table", async () => {
    const src = makeFakeD1();
    const dump = await exportTable(src, "issues", logger);
    expect(dump.success && dump.data.rowCount).toBe(0);
    const dst = makeFakeD1();
    const restored = await restoreTable(dst, "issues", dump.success ? dump.data.ndjson : new Uint8Array(), logger);
    expect(restored.success && restored.data.inserted).toBe(0);
  });
});
