import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowlistAdmits,
  ensureCanonicalProject,
  parseOwnerBindings,
  resolveInboundProject,
} from "../src/github/repo-authorization";
import type { ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

let raw: ReturnType<typeof makeSqliteD1>["raw"];
let env: {
  DB: D1Database;
  STATE: KVNamespace;
  GITHUB_ALLOWED_OWNERS?: string;
  GITHUB_APP_ALLOWED_OWNERS?: string;
};

beforeEach(() => {
  vi.clearAllMocks();
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = { DB: sqlite.db, STATE: makeFakeKV() };
  for (const [id, username] of [
    ["usr_alice", "alice"],
    ["usr_mallory", "mallory"],
  ]) {
    raw
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .run(id, `${username}@example.com`, username, `h_${id}`);
  }
  raw
    .prepare("INSERT INTO orgs (id, slug, name, owner_id) VALUES (?, ?, ?, ?)")
    .run("org_stratum", "stratum", "Stratum", "usr_alice");
});

async function putProject(
  project: Partial<ProjectEntry> & Pick<ProjectEntry, "id" | "namespace" | "slug">,
): Promise<ProjectEntry> {
  const entry = {
    name: project.slug,
    ownerId: "usr_alice",
    ownerType: "user",
    createdAt: "2026-01-01T00:00:00Z",
    sourceUrl: "https://github.com/acme/api",
    ...project,
  } as ProjectEntry;
  await env.STATE.put(`project:${entry.namespace}:${entry.slug}`, JSON.stringify(entry));
  return entry;
}

function linkInstallation(installationId: number, owner: { type: "user" | "org"; id: string }) {
  raw
    .prepare(
      `INSERT INTO github_app_installations
         (installation_id, account_login, account_id, account_type, stratum_owner_type, stratum_owner_id)
       VALUES (?, 'acme', '99', 'Organization', ?, ?)`,
    )
    .run(installationId, owner.type, owner.id);
}

const linkedProjectId = () =>
  (
    raw.prepare("SELECT project_id FROM github_repo_links").get() as
      | { project_id: string }
      | undefined
  )?.project_id;

describe("parseOwnerBindings", () => {
  it("binds GitHub owners to stable org and user ids", () => {
    const { bindings, unbound } = parseOwnerBindings(
      " Stratum-Eng=org:org_stratum , acme=user:usr_alice ,, ",
    );
    expect([...(bindings.get("stratum-eng") ?? [])]).toEqual(["org:org_stratum"]);
    expect([...(bindings.get("acme") ?? [])]).toEqual(["user:usr_alice"]);
    expect(unbound).toEqual([]);
  });

  it("ignores namespace-bound, unbound and malformed entries", () => {
    const { bindings, unbound } = parseOwnerBindings(
      "acme,acme=@alice,acme=alice,other=,=org:x,bad owner=org:y,ok=team:z,ok=org:",
    );
    expect(bindings.size).toBe(0);
    expect(unbound).toEqual([
      "acme",
      "acme=@alice",
      "acme=alice",
      "other=",
      "=org:x",
      "bad owner=org:y",
      "ok=team:z",
      "ok=org:",
    ]);
  });

  it("allows several owners per GitHub account", () => {
    const { bindings } = parseOwnerBindings("acme=user:usr_alice,acme=org:org_stratum");
    expect([...(bindings.get("acme") ?? [])].sort()).toEqual(["org:org_stratum", "user:usr_alice"]);
  });
});

describe("allowlistAdmits", () => {
  it("admits only the bound ids, with an agent matching through its owner's user id", async () => {
    env.GITHUB_ALLOWED_OWNERS = "acme=user:usr_alice,acme=org:org_stratum";
    raw
      .prepare(
        "INSERT INTO agents (id, name, owner_id, token_hash) VALUES ('agt_1', 'a', 'usr_alice', 'h')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO agents (id, name, owner_id, token_hash) VALUES ('agt_2', 'b', 'usr_mallory', 'h2')",
      )
      .run();

    expect(await allowlistAdmits(env, "ACME", { type: "user", id: "usr_alice" }, logger)).toBe(
      true,
    );
    expect(await allowlistAdmits(env, "acme", { type: "org", id: "org_stratum" }, logger)).toBe(
      true,
    );
    expect(await allowlistAdmits(env, "acme", { type: "agent", id: "agt_1" }, logger)).toBe(true);
    expect(await allowlistAdmits(env, "acme", { type: "user", id: "usr_mallory" }, logger)).toBe(
      false,
    );
    expect(await allowlistAdmits(env, "acme", { type: "agent", id: "agt_2" }, logger)).toBe(false);
    expect(await allowlistAdmits(env, "acme", { type: "agent", id: "agt_missing" }, logger)).toBe(
      false,
    );
    expect(await allowlistAdmits(env, "other", { type: "user", id: "usr_alice" }, logger)).toBe(
      false,
    );
    expect(await allowlistAdmits(env, "acme", null, logger)).toBe(false);
    // A user id is not an org id, even when the strings match.
    expect(await allowlistAdmits(env, "acme", { type: "org", id: "usr_alice" }, logger)).toBe(
      false,
    );
  });

  it("treats an unbound or namespace-bound entry as admitting nobody", async () => {
    env.GITHUB_APP_ALLOWED_OWNERS = "acme,acme=@alice";
    expect(await allowlistAdmits(env, "acme", { type: "user", id: "usr_alice" }, logger)).toBe(
      false,
    );
  });

  it("does not follow a name: after a rename, the newcomer to the old name is not admitted", async () => {
    env.GITHUB_ALLOWED_OWNERS = "acme=org:org_stratum";
    // @stratum renames to @stratum-old; mallory creates a new org called stratum.
    raw.prepare("UPDATE orgs SET slug = 'stratum-old' WHERE id = 'org_stratum'").run();
    raw
      .prepare(
        "INSERT INTO orgs (id, slug, name, owner_id) VALUES ('org_squat', 'stratum', 'S', 'usr_mallory')",
      )
      .run();

    expect(await allowlistAdmits(env, "acme", { type: "org", id: "org_squat" }, logger)).toBe(
      false,
    );
    expect(await allowlistAdmits(env, "acme", { type: "org", id: "org_stratum" }, logger)).toBe(
      true,
    );
  });

  it("does not follow a name: after a delete and reclaim, the newcomer is not admitted", async () => {
    env.GITHUB_ALLOWED_OWNERS = "acme=user:usr_alice";
    raw.prepare("DELETE FROM orgs WHERE owner_id = 'usr_alice'").run();
    raw.prepare("DELETE FROM users WHERE id = 'usr_alice'").run();
    raw
      .prepare(
        "INSERT INTO users (id, email, username, token_hash) VALUES ('usr_new', 'n@example.com', 'alice', 'hn')",
      )
      .run();

    expect(await allowlistAdmits(env, "acme", { type: "user", id: "usr_new" }, logger)).toBe(false);
  });
});

describe("resolveInboundProject", () => {
  it("skips a project that only names the repo, and routes to the authorized one", async () => {
    // Mallory imported acme/api first; only Alice is linked to the installation.
    await putProject({
      id: "prj_m",
      namespace: "@mallory",
      slug: "api",
      ownerId: "usr_mallory",
      createdAt: "2025-01-01T00:00:00Z",
    });
    await putProject({ id: "prj_a", namespace: "@alice", slug: "api" });
    linkInstallation(777, { type: "user", id: "usr_alice" });

    const routed = await resolveInboundProject(env, "acme", "api", 777, logger);

    expect(routed.success && routed.data?.id).toBe("prj_a");
    expect(linkedProjectId()).toBe("prj_a");
  });

  it("drops the event when no project is authorized", async () => {
    await putProject({ id: "prj_m", namespace: "@mallory", slug: "api", ownerId: "usr_mallory" });
    linkInstallation(777, { type: "user", id: "usr_alice" });

    const routed = await resolveInboundProject(env, "acme", "api", 777, logger);

    expect(routed).toEqual({ success: true, data: null });
    expect(linkedProjectId()).toBeUndefined();
  });

  it("does not let a link vouch for a plain repo webhook (no installation id)", async () => {
    await putProject({ id: "prj_a", namespace: "@alice", slug: "api" });
    linkInstallation(777, { type: "user", id: "usr_alice" });

    expect(await resolveInboundProject(env, "acme", "api", undefined, logger)).toEqual({
      success: true,
      data: null,
    });

    env.GITHUB_ALLOWED_OWNERS = "acme=user:usr_alice";
    const routed = await resolveInboundProject(env, "acme", "api", undefined, logger);
    expect(routed.success && routed.data?.id).toBe("prj_a");
  });

  it("does not accept another installation's id as a link", async () => {
    await putProject({ id: "prj_a", namespace: "@alice", slug: "api" });
    linkInstallation(777, { type: "user", id: "usr_alice" });
    expect(await resolveInboundProject(env, "acme", "api", 888, logger)).toEqual({
      success: true,
      data: null,
    });
  });

  it("keeps routing to the canonical project once claimed, ignoring later authorized copies", async () => {
    await putProject({ id: "prj_a", namespace: "@alice", slug: "api" });
    linkInstallation(777, { type: "user", id: "usr_alice" });
    await resolveInboundProject(env, "acme", "api", 777, logger);

    await putProject({
      id: "prj_a2",
      namespace: "@alice",
      slug: "api-copy",
      createdAt: "2020-01-01T00:00:00Z",
    });
    const routed = await resolveInboundProject(env, "acme", "api", 777, logger);
    expect(routed.success && routed.data?.id).toBe("prj_a");
  });

  it("moves the link when its holder is deleted", async () => {
    await putProject({ id: "prj_a", namespace: "@alice", slug: "api" });
    linkInstallation(777, { type: "user", id: "usr_alice" });
    await resolveInboundProject(env, "acme", "api", 777, logger);

    await env.STATE.delete("project:@alice:api");
    await putProject({ id: "prj_b", namespace: "@alice", slug: "api-new" });

    const routed = await resolveInboundProject(env, "acme", "api", 777, logger);
    expect(routed.success && routed.data?.id).toBe("prj_b");
    expect(linkedProjectId()).toBe("prj_b");
  });
});

describe("ensureCanonicalProject", () => {
  it("claims a free repo, keeps it for the holder, and refuses a second project", async () => {
    linkInstallation(777, { type: "user", id: "usr_alice" });
    const a = await putProject({ id: "prj_a", namespace: "@alice", slug: "api" });
    const b = await putProject({ id: "prj_b", namespace: "@alice", slug: "api-copy" });

    expect(await ensureCanonicalProject(env, "acme", "api", a, logger)).toEqual({
      success: true,
      data: true,
    });
    expect(await ensureCanonicalProject(env, "ACME", "API", a, logger)).toEqual({
      success: true,
      data: true,
    });
    expect(await ensureCanonicalProject(env, "acme", "api", b, logger)).toEqual({
      success: true,
      data: false,
    });
    expect(linkedProjectId()).toBe("prj_a");
  });

  it("hands the repo over once the holder is no longer authorized", async () => {
    linkInstallation(777, { type: "user", id: "usr_alice" });
    const a = await putProject({ id: "prj_a", namespace: "@alice", slug: "api" });
    await ensureCanonicalProject(env, "acme", "api", a, logger);

    // The installation is relinked to the stratum org.
    raw
      .prepare(
        "UPDATE github_app_installations SET stratum_owner_type = 'org', stratum_owner_id = 'org_stratum'",
      )
      .run();
    const org = await putProject({
      id: "prj_o",
      namespace: "@stratum",
      slug: "api",
      ownerType: "org",
      ownerId: "org_stratum",
    });

    expect(await ensureCanonicalProject(env, "acme", "api", org, logger)).toEqual({
      success: true,
      data: true,
    });
    expect(linkedProjectId()).toBe("prj_o");
  });
});
