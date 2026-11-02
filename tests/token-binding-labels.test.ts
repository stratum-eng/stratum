/**
 * Review finding on #398: a token's binding label must not claim its target is
 * deleted when the lookup merely FAILED. "No longer exists" invites revoking a
 * working token; a lookup failure has to read as unknown.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DELETED_ORG_LABEL,
  DELETED_PROJECT_LABEL,
  UNRESOLVED_BINDING_LABEL,
  describeTokenBindings,
} from "../src/services/token-binding";
import type { ApiTokenSummary } from "../src/storage/api-tokens";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

function token(id: string, binding: ApiTokenSummary["binding"]): ApiTokenSummary {
  return {
    id,
    name: id,
    tokenPrefix: "stratum_user_00000000",
    scope: "read",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(binding !== undefined ? { binding } : {}),
  };
}

const TOKENS = [
  token("t_project", { kind: "project", projectId: "proj_1" }),
  token("t_org", { kind: "org", orgId: "org_1" }),
  token("t_unbound", undefined),
];

describe("describeTokenBindings", () => {
  it("says a target is gone only when the lookup succeeded and found nothing", async () => {
    const { db } = makeSqliteD1();
    const env = { DB: db, STATE: makeFakeKV() } as unknown as Env;
    const labels = await describeTokenBindings(env, logger, TOKENS);
    expect(labels.get("t_project")).toBe(DELETED_PROJECT_LABEL);
    expect(labels.get("t_org")).toBe(DELETED_ORG_LABEL);
    expect(labels.has("t_unbound")).toBe(false);
  });

  it("labels the binding unresolved, not deleted, when the lookups fail", async () => {
    const failingKv = {
      ...makeFakeKV(),
      list: async () => {
        throw new Error("KV down");
      },
    } as unknown as KVNamespace;
    const failingDb = {
      prepare: () => {
        throw new Error("D1 down");
      },
    } as unknown as D1Database;
    const env = { DB: failingDb, STATE: failingKv } as unknown as Env;

    const labels = await describeTokenBindings(env, logger, TOKENS);
    expect(labels.get("t_project")).toBe(UNRESOLVED_BINDING_LABEL);
    expect(labels.get("t_org")).toBe(UNRESOLVED_BINDING_LABEL);
  });
});
