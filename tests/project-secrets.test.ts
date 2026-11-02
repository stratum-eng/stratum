/**
 * The encrypted deploy-secret store.
 *
 * The assertions that matter most here are the negative ones: AES-GCM binds
 * `(project_id, name)` as AAD, so a ciphertext lifted into another project or
 * renamed must fail to decrypt rather than quietly authenticate against the
 * wrong provider account. Those cases are exercised by writing a transplanted
 * row through the raw SQLite handle, because no code path in the store can
 * produce one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOY_SECRET_KEY_MISSING,
  MAX_SECRET_VALUE_BYTES,
  deleteSecret,
  listSecretNames,
  loadSecretValues,
  putSecret,
} from "../src/storage/project-secrets";
import { decryptSecret, deriveSecretKey, encryptSecret } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const ENV = { DEPLOY_SECRET_KEY: "test-deploy-key" };
const PROJECT = "prj_aaaaaaaa";
const OTHER_PROJECT = "prj_bbbbbbbb";

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];

beforeEach(() => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  vi.clearAllMocks();
});

function readCiphertext(projectId: string, name: string): string {
  const row = raw
    .prepare("SELECT ciphertext FROM project_secrets WHERE project_id = ? AND name = ?")
    .get(projectId, name) as { ciphertext: string } | undefined;
  if (!row) throw new Error(`no secret ${name} in ${projectId}`);
  return row.ciphertext;
}

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value under the same key and scope", async () => {
    const key = await deriveSecretKey("k");
    const scope = { projectId: PROJECT, name: "VERCEL_TOKEN" };
    const ciphertext = await encryptSecret("hunter2", key, scope);

    expect(ciphertext).not.toContain("hunter2");
    expect(await decryptSecret(ciphertext, key, scope)).toBe("hunter2");
  });

  it("round-trips an empty value, which is distinct from a decryption failure", async () => {
    const key = await deriveSecretKey("k");
    const scope = { projectId: PROJECT, name: "EMPTY" };
    expect(await decryptSecret(await encryptSecret("", key, scope), key, scope)).toBe("");
  });

  it("produces a different ciphertext each time for the same plaintext", async () => {
    const key = await deriveSecretKey("k");
    const scope = { projectId: PROJECT, name: "VERCEL_TOKEN" };
    const a = await encryptSecret("same", key, scope);
    const b = await encryptSecret("same", key, scope);
    expect(a).not.toBe(b);
  });

  it("fails when the project_id in the AAD differs", async () => {
    const key = await deriveSecretKey("k");
    const ciphertext = await encryptSecret("hunter2", key, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
    });

    expect(
      await decryptSecret(ciphertext, key, { projectId: OTHER_PROJECT, name: "VERCEL_TOKEN" }),
    ).toBeNull();
  });

  it("fails when the secret name in the AAD differs", async () => {
    const key = await deriveSecretKey("k");
    const ciphertext = await encryptSecret("hunter2", key, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
    });

    expect(
      await decryptSecret(ciphertext, key, { projectId: PROJECT, name: "CF_API_TOKEN" }),
    ).toBeNull();
  });

  it("fails when the split between project id and name shifts", async () => {
    // The NUL separator is what makes this fail: with a bare concatenation
    // "prj_1" + "AB" and "prj_1A" + "B" produce the same AAD.
    const key = await deriveSecretKey("k");
    const ciphertext = await encryptSecret("hunter2", key, { projectId: "prj_1", name: "AB" });

    expect(await decryptSecret(ciphertext, key, { projectId: "prj_1A", name: "B" })).toBeNull();
  });

  it("fails under a key derived from a different DEPLOY_SECRET_KEY", async () => {
    const scope = { projectId: PROJECT, name: "VERCEL_TOKEN" };
    const ciphertext = await encryptSecret("hunter2", await deriveSecretKey("k"), scope);

    expect(await decryptSecret(ciphertext, await deriveSecretKey("rotated"), scope)).toBeNull();
  });

  it("returns null rather than throwing on non-base64 input", async () => {
    const key = await deriveSecretKey("k");
    expect(
      await decryptSecret("!!!not base64!!!", key, { projectId: PROJECT, name: "X" }),
    ).toBeNull();
  });
});

describe("putSecret", () => {
  it("stores a secret and returns metadata without the value", async () => {
    const result = await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "hunter2",
      actorId: "usr_a",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      name: "VERCEL_TOKEN",
      createdBy: "usr_a",
      updatedBy: "usr_a",
    });
    expect(JSON.stringify(result.data)).not.toContain("hunter2");
    expect(readCiphertext(PROJECT, "VERCEL_TOKEN")).not.toContain("hunter2");
  });

  it("writes application ISO-8601 timestamps, not SQLite's space-separated form", async () => {
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "v",
      actorId: "usr_a",
    });

    const row = raw
      .prepare("SELECT created_at, updated_at FROM project_secrets WHERE project_id = ?")
      .get(PROJECT) as { created_at: string; updated_at: string };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("overwrites in place, keeping created_by while updating updated_by and updated_at", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const first = await putSecret(db, logger, ENV, {
        projectId: PROJECT,
        name: "VERCEL_TOKEN",
        value: "old",
        actorId: "usr_a",
      });
      expect(first.success).toBe(true);

      vi.setSystemTime(new Date("2026-02-02T00:00:00.000Z"));
      const second = await putSecret(db, logger, ENV, {
        projectId: PROJECT,
        name: "VERCEL_TOKEN",
        value: "new",
        actorId: "usr_b",
      });

      expect(second.success).toBe(true);
      if (!second.success) return;
      expect(second.data.createdBy).toBe("usr_a");
      expect(second.data.updatedBy).toBe("usr_b");
      expect(second.data.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(second.data.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }

    const count = raw
      .prepare("SELECT COUNT(*) AS n FROM project_secrets WHERE project_id = ?")
      .get(PROJECT) as { n: number };
    expect(Number(count.n)).toBe(1);

    const loaded = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["VERCEL_TOKEN"],
    });
    expect(loaded.success && loaded.data.values.get("VERCEL_TOKEN")).toBe("new");
  });

  it("keeps same-named secrets in different projects independent", async () => {
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "mine",
      actorId: "usr_a",
    });
    await putSecret(db, logger, ENV, {
      projectId: OTHER_PROJECT,
      name: "VERCEL_TOKEN",
      value: "theirs",
      actorId: "usr_b",
    });

    const loaded = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["VERCEL_TOKEN"],
    });
    expect(loaded.success && loaded.data.values.get("VERCEL_TOKEN")).toBe("mine");
  });

  it.each([
    ["lowercase", "vercel_token"],
    ["leading digit", "1TOKEN"],
    ["leading underscore", "_TOKEN"],
    ["a hyphen", "VERCEL-TOKEN"],
    ["a dot", "VERCEL.TOKEN"],
    ["empty", ""],
    ["over 64 characters", `A${"B".repeat(64)}`],
  ])("rejects a name with %s", async (_label, name) => {
    const result = await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name,
      value: "v",
      actorId: "usr_a",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["a single uppercase letter", "A"],
    ["exactly 64 characters", `A${"B".repeat(63)}`],
    ["digits and underscores after the first character", "CF_ACCOUNT_ID_2"],
  ])("accepts a name that is %s", async (_label, name) => {
    const result = await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name,
      value: "v",
      actorId: "usr_a",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a value of exactly the cap", async () => {
    const result = await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "BIG",
      value: "x".repeat(MAX_SECRET_VALUE_BYTES),
      actorId: "usr_a",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a value one byte over the cap", async () => {
    const result = await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "BIG",
      value: "x".repeat(MAX_SECRET_VALUE_BYTES + 1),
      actorId: "usr_a",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("measures the cap in UTF-8 bytes, not UTF-16 code units", async () => {
    // "é" is one UTF-16 code unit but two UTF-8 bytes: 2100 of them are under
    // the cap by `String.length` and over it on the wire.
    const value = "é".repeat(2100);
    expect(value.length).toBeLessThan(MAX_SECRET_VALUE_BYTES);

    const result = await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "BIG",
      value,
      actorId: "usr_a",
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ["a carriage return", "sk-ant-real\rX-Injected: 1"],
    ["a line feed", "sk-ant-real\nX-Injected: 1"],
    ["a NUL", "sk-ant-real\u0000"],
    ["a tab", "sk-ant-real\tmore"],
  ])("rejects a value containing %s, without echoing it", async (_case, value) => {
    // Not tidiness. A stored value goes into an outbound provider header, and
    // `new Headers()` throws a TypeError that QUOTES the offending value — which
    // would travel as an ExternalServiceError message into `EvalResult.reason`,
    // be persisted on the change, and be rendered on a page that is
    // world-readable for a public project. The store is the first of the two
    // ends that close that path.
    const result = await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "LEAKY",
      value,
      actorId: "usr_a",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    // The refusal must not become the leak it prevents.
    expect(result.error.message).not.toContain("sk-ant-real");
    expect(JSON.stringify(result.error.context ?? {})).not.toContain("sk-ant-real");

    // …and nothing was written, so the value cannot be read back either.
    const loaded = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["LEAKY"],
    });
    expect(loaded.success && loaded.data.missing).toEqual(["LEAKY"]);
  });

  it("accepts an empty value: there is deliberately no minimum length", async () => {
    const result = await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "EMPTY",
      value: "",
      actorId: "usr_a",
    });
    expect(result.success).toBe(true);

    const loaded = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["EMPTY"],
    });
    expect(loaded.success && loaded.data.values.get("EMPTY")).toBe("");
    expect(loaded.success && loaded.data.missing).toEqual([]);
  });

  it("returns a typed error when DEPLOY_SECRET_KEY is unset", async () => {
    const result = await putSecret(
      db,
      logger,
      {},
      { projectId: PROJECT, name: "VERCEL_TOKEN", value: "v", actorId: "usr_a" },
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(DEPLOY_SECRET_KEY_MISSING);

    const count = raw.prepare("SELECT COUNT(*) AS n FROM project_secrets").get() as { n: number };
    expect(Number(count.n)).toBe(0);
  });

  it("wraps a database failure instead of throwing", async () => {
    const result = await putSecret(makeThrowingD1(), logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "v",
      actorId: "usr_a",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("DATABASE_ERROR");
  });
});

describe("listSecretNames", () => {
  it("returns names and metadata but never a value", async () => {
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "hunter2",
      actorId: "usr_a",
    });
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "CF_API_TOKEN",
      value: "swordfish",
      actorId: "usr_a",
    });

    const result = await listSecretNames(db, logger, PROJECT);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((s) => s.name)).toEqual(["CF_API_TOKEN", "VERCEL_TOKEN"]);
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("swordfish");
    expect(serialized).not.toContain("ciphertext");
  });

  it("does not list another project's secrets", async () => {
    await putSecret(db, logger, ENV, {
      projectId: OTHER_PROJECT,
      name: "VERCEL_TOKEN",
      value: "theirs",
      actorId: "usr_b",
    });

    const result = await listSecretNames(db, logger, PROJECT);
    expect(result.success && result.data).toEqual([]);
  });

  it("wraps a database failure instead of throwing", async () => {
    const result = await listSecretNames(makeThrowingD1(), logger, PROJECT);
    expect(result.success).toBe(false);
  });
});

describe("deleteSecret", () => {
  it("removes the row and reports that it did", async () => {
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "hunter2",
      actorId: "usr_a",
    });

    const result = await deleteSecret(db, logger, { projectId: PROJECT, name: "VERCEL_TOKEN" });

    expect(result.success && result.data).toBe(true);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM project_secrets").get() as { n: number };
    expect(Number(count.n)).toBe(0);
  });

  it("reports false for a name the project does not have", async () => {
    const result = await deleteSecret(db, logger, { projectId: PROJECT, name: "ABSENT" });
    expect(result.success && result.data).toBe(false);
  });

  it("cannot delete another project's same-named secret", async () => {
    await putSecret(db, logger, ENV, {
      projectId: OTHER_PROJECT,
      name: "VERCEL_TOKEN",
      value: "theirs",
      actorId: "usr_b",
    });

    const result = await deleteSecret(db, logger, { projectId: PROJECT, name: "VERCEL_TOKEN" });

    expect(result.success && result.data).toBe(false);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM project_secrets").get() as { n: number };
    expect(Number(count.n)).toBe(1);
  });

  it("rejects a malformed name rather than issuing the delete", async () => {
    const result = await deleteSecret(db, logger, { projectId: PROJECT, name: "vercel_token" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("loadSecretValues", () => {
  it("resolves every requested name", async () => {
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "hunter2",
      actorId: "usr_a",
    });
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "CF_API_TOKEN",
      value: "swordfish",
      actorId: "usr_a",
    });

    const result = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["VERCEL_TOKEN", "CF_API_TOKEN"],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.values.get("VERCEL_TOKEN")).toBe("hunter2");
    expect(result.data.values.get("CF_API_TOKEN")).toBe("swordfish");
    expect(result.data.missing).toEqual([]);
    expect(result.data.undecryptable).toEqual([]);
  });

  it("names the secrets it could not find rather than failing the batch", async () => {
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "hunter2",
      actorId: "usr_a",
    });

    const result = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["VERCEL_TOKEN", "ABSENT"],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.missing).toEqual(["ABSENT"]);
    expect(result.data.values.has("ABSENT")).toBe(false);
  });

  it("returns nothing for a cross-project read", async () => {
    await putSecret(db, logger, ENV, {
      projectId: OTHER_PROJECT,
      name: "VERCEL_TOKEN",
      value: "theirs",
      actorId: "usr_b",
    });

    const result = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["VERCEL_TOKEN"],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.values.size).toBe(0);
    expect(result.data.missing).toEqual(["VERCEL_TOKEN"]);
  });

  it("refuses a ciphertext transplanted from another project", async () => {
    await putSecret(db, logger, ENV, {
      projectId: OTHER_PROJECT,
      name: "VERCEL_TOKEN",
      value: "theirs",
      actorId: "usr_b",
    });
    // A direct row write is the only way to construct this: putSecret always
    // binds the AAD to the project it is writing into.
    raw
      .prepare(
        "INSERT INTO project_secrets (id, project_id, name, ciphertext, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "psec_stolen",
        PROJECT,
        "VERCEL_TOKEN",
        readCiphertext(OTHER_PROJECT, "VERCEL_TOKEN"),
        "usr_evil",
        "usr_evil",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    const result = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["VERCEL_TOKEN"],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.values.size).toBe(0);
    expect(result.data.undecryptable).toEqual(["VERCEL_TOKEN"]);
  });

  it("refuses a ciphertext renamed within the same project", async () => {
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "hunter2",
      actorId: "usr_a",
    });
    raw
      .prepare("UPDATE project_secrets SET name = ? WHERE project_id = ? AND name = ?")
      .run("CF_API_TOKEN", PROJECT, "VERCEL_TOKEN");

    const result = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["CF_API_TOKEN"],
    });

    expect(result.success && result.data.undecryptable).toEqual(["CF_API_TOKEN"]);
  });

  it("reports a rotated DEPLOY_SECRET_KEY as undecryptable, not missing", async () => {
    await putSecret(db, logger, ENV, {
      projectId: PROJECT,
      name: "VERCEL_TOKEN",
      value: "hunter2",
      actorId: "usr_a",
    });

    const result = await loadSecretValues(
      db,
      logger,
      { DEPLOY_SECRET_KEY: "a-different-key" },
      { projectId: PROJECT, names: ["VERCEL_TOKEN"] },
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.undecryptable).toEqual(["VERCEL_TOKEN"]);
    expect(result.data.missing).toEqual([]);
  });

  it("returns a typed error when DEPLOY_SECRET_KEY is unset", async () => {
    const result = await loadSecretValues(db, logger, {}, { projectId: PROJECT, names: ["ANY"] });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe(DEPLOY_SECRET_KEY_MISSING);
  });

  it("resolves an empty request without touching the key or the database", async () => {
    const result = await loadSecretValues(
      makeThrowingD1(),
      logger,
      {},
      {
        projectId: PROJECT,
        names: [],
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.values.size).toBe(0);
  });

  it("deduplicates repeated names", async () => {
    const result = await loadSecretValues(db, logger, ENV, {
      projectId: PROJECT,
      names: ["ABSENT", "ABSENT"],
    });

    expect(result.success && result.data.missing).toEqual(["ABSENT"]);
  });

  it("wraps a database failure instead of throwing", async () => {
    const result = await loadSecretValues(makeThrowingD1(), logger, ENV, {
      projectId: PROJECT,
      names: ["VERCEL_TOKEN"],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("DATABASE_ERROR");
  });
});
