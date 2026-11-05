/**
 * Issue #323: the credential binding inside `utils/authz.ts`.
 *
 * Each helper is held to the same rule: a binding only narrows. The principal
 * here is maximally privileged — direct owner of the personal projects and an
 * admin of every org — so the binding is the only thing that can say no.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/orgs", async () =>
  (await import("./helpers/org-access-mock")).withOrgAccess({
    getOrgAccessLevel: vi.fn(async () => "admin" as const),
  }),
);

import type { CredentialBinding, ProjectEntry, WorkspaceEntry } from "../src/types";
import {
  UNBOUND,
  bindingAllowsCreateIn,
  bindingCoversProject,
  canReadProject,
  canWriteProject,
  canWriteWorkspace,
  credentialBindingFrom,
  filterMemberProjects,
  filterReadableProjects,
  isBound,
  isDirectOwner,
  isProjectAdmin,
} from "../src/utils/authz";

const db = {} as D1Database;

function project(id: string, overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id,
    name: id,
    slug: id,
    namespace: "@me",
    ownerId: "usr_me",
    ownerType: "user",
    remote: "https://example.invalid/r.git",
    createdAt: "2026-01-01T00:00:00.000Z",
    visibility: "private",
    ...overrides,
  };
}

const mine = project("p_mine");
const sibling = project("p_sibling");
const publicSibling = project("p_public", { visibility: "public" });
const acme = project("p_acme", { namespace: "@acme", ownerId: "org_acme", ownerType: "org" });
const globex = project("p_globex", {
  namespace: "@globex",
  ownerId: "org_globex",
  ownerType: "org",
});
const all = [mine, sibling, publicSibling, acme, globex];

const toMine: CredentialBinding = { kind: "project", projectId: "p_mine" };
const toAcme: CredentialBinding = { kind: "org", orgId: "org_acme" };

const workspace: WorkspaceEntry = {
  name: "ws",
  remote: "https://example.invalid/ws.git",
  parent: "p_mine",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdByUserId: "usr_me",
} as WorkspaceEntry;

describe("bindingCoversProject", () => {
  it("unbound covers everything", () => {
    expect(all.every((p) => bindingCoversProject(UNBOUND, p))).toBe(true);
  });

  it("a project binding covers exactly that project id", () => {
    expect(all.filter((p) => bindingCoversProject(toMine, p)).map((p) => p.id)).toEqual(["p_mine"]);
  });

  it("an org binding covers that org's projects only, never a member's personal ones", () => {
    expect(all.filter((p) => bindingCoversProject(toAcme, p)).map((p) => p.id)).toEqual(["p_acme"]);
  });

  it("an org binding does not match a USER whose id happens to equal the org id", () => {
    const userOwned = project("p_collide", { ownerId: "org_acme", ownerType: "user" });
    expect(bindingCoversProject(toAcme, userOwned)).toBe(false);
  });
});

describe("every authz helper honours the binding", () => {
  it.each([
    ["canReadProject", canReadProject],
    ["canWriteProject", canWriteProject],
    ["isProjectAdmin", isProjectAdmin],
  ] as const)("%s", async (_name, check) => {
    expect(await check(db, mine, toMine, "usr_me")).toBe(true);
    expect(await check(db, sibling, toMine, "usr_me")).toBe(false);
    expect(await check(db, acme, toMine, "usr_me")).toBe(false);
    expect(await check(db, acme, toAcme, "usr_me")).toBe(true);
    expect(await check(db, globex, toAcme, "usr_me")).toBe(false);
    expect(await check(db, mine, toAcme, "usr_me")).toBe(false);
    // Agents inherit the same narrowing through their owner id.
    expect(await check(db, sibling, toMine, undefined, "usr_me")).toBe(false);
    expect(await check(db, sibling, UNBOUND, "usr_me")).toBe(true);
  });

  it("canReadProject refuses a PUBLIC project outside the binding", async () => {
    expect(await canReadProject(db, publicSibling, toMine, "usr_me")).toBe(false);
    // ...which anonymous access, carrying no binding, still reaches.
    expect(await canReadProject(db, publicSibling, UNBOUND)).toBe(true);
  });

  it("canWriteWorkspace", async () => {
    expect(await canWriteWorkspace(db, mine, workspace, toMine, "usr_me")).toBe(true);
    const foreign = { ...workspace, parent: "p_sibling" } as WorkspaceEntry;
    expect(await canWriteWorkspace(db, sibling, foreign, toMine, "usr_me")).toBe(false);
  });

  it("isDirectOwner", () => {
    expect(isDirectOwner(mine, toMine, "usr_me")).toBe(true);
    expect(isDirectOwner(sibling, toMine, "usr_me")).toBe(false);
    expect(isDirectOwner(sibling, UNBOUND, "usr_me")).toBe(true);
  });

  it("filterReadableProjects and filterMemberProjects", async () => {
    const ids = (ps: ProjectEntry[]) => ps.map((p) => p.id);
    expect(ids(await filterReadableProjects(db, all, toMine, "usr_me"))).toEqual(["p_mine"]);
    expect(ids(await filterReadableProjects(db, all, toAcme, "usr_me"))).toEqual(["p_acme"]);
    expect(ids(await filterMemberProjects(db, all, toMine, "usr_me"))).toEqual(["p_mine"]);
    expect(ids(await filterMemberProjects(db, all, toAcme, "usr_me"))).toEqual(["p_acme"]);
    expect(ids(await filterReadableProjects(db, all, UNBOUND, "usr_me"))).toHaveLength(5);
  });
});

describe("bindingAllowsCreateIn", () => {
  it("lets an unbound caller create anywhere it otherwise may", () => {
    expect(bindingAllowsCreateIn(UNBOUND, { type: "user", id: "usr_me" })).toBe(true);
  });

  it("never lets a project binding create", () => {
    expect(bindingAllowsCreateIn(toMine, { type: "user", id: "usr_me" })).toBe(false);
    expect(bindingAllowsCreateIn(toMine, { type: "org", id: "org_acme" })).toBe(false);
  });

  it("lets an org binding create only in its org", () => {
    expect(bindingAllowsCreateIn(toAcme, { type: "org", id: "org_acme" })).toBe(true);
    expect(bindingAllowsCreateIn(toAcme, { type: "org", id: "org_globex" })).toBe(false);
    expect(bindingAllowsCreateIn(toAcme, { type: "user", id: "usr_me" })).toBe(false);
  });
});

describe("credentialBindingFrom", () => {
  it("is unbound when the middleware published nothing (sessions, agents, OAuth, legacy)", () => {
    const binding = credentialBindingFrom({ get: () => undefined });
    expect(binding).toEqual({ kind: "unbound" });
    expect(isBound(binding)).toBe(false);
  });

  it("returns what the middleware published", () => {
    expect(credentialBindingFrom({ get: () => toAcme })).toBe(toAcme);
    expect(isBound(toAcme)).toBe(true);
  });
});
