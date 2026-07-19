/**
 * PROV: provenance stores and returns the snapshotted model + prompt hash.
 */
import { describe, expect, it, vi } from "vitest";
import { listProvenance, recordProvenance } from "../src/storage/provenance";
import type { Logger } from "../src/utils/logger";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

// Minimal D1 stub: stores INSERTed provenance rows and serves them back for the
// SELECT in listProvenance. Only the columns the tests exercise are modelled.
function makeD1() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    prepare(sql: string) {
      return {
        _sql: sql,
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          this._binds = args;
          return this;
        },
        async run() {
          if (this._sql.startsWith("INSERT INTO provenance")) {
            const b = this._binds;
            rows.push({
              id: b[0],
              commit_sha: b[1],
              project: b[2],
              workspace: b[3],
              change_id: b[4],
              agent_id: b[5] ?? null,
              eval_score: b[6] ?? null,
              model: b[7] ?? null,
              prompt_hash: b[8] ?? null,
              merged_at: b[9],
            });
          }
          return { success: true };
        },
        async all() {
          const project = this._binds[0];
          return { results: rows.filter((r) => r.project === project) };
        },
        async first() {
          return rows[0] ?? null;
        },
      };
    },
  } as unknown as D1Database;
}

describe("provenance model + prompt hash", () => {
  it("stores and returns the model and prompt hash", async () => {
    const db = makeD1();
    const write = await recordProvenance(db, logger, {
      commitSha: "abc123",
      project: "proj-1",
      workspace: "fix-bug",
      changeId: "chg_1",
      agentId: "agent_1",
      evalScore: 0.95,
      model: "claude-fable-5",
      promptHash: "sha256:digest",
    });
    expect(write.success).toBe(true);
    if (write.success) {
      expect(write.data.model).toBe("claude-fable-5");
      expect(write.data.promptHash).toBe("sha256:digest");
    }

    const read = await listProvenance(db, logger, "proj-1");
    expect(read.success).toBe(true);
    if (read.success) {
      expect(read.data).toHaveLength(1);
      expect(read.data[0]?.model).toBe("claude-fable-5");
      expect(read.data[0]?.promptHash).toBe("sha256:digest");
    }
  });

  it("leaves model and prompt hash undefined for a user-authored merge", async () => {
    const db = makeD1();
    await recordProvenance(db, logger, {
      commitSha: "def456",
      project: "proj-2",
      workspace: "feat-x",
      changeId: "chg_2",
    });
    const read = await listProvenance(db, logger, "proj-2");
    expect(read.success).toBe(true);
    if (read.success) {
      expect(read.data[0]?.model).toBeUndefined();
      expect(read.data[0]?.promptHash).toBeUndefined();
    }
  });
});
