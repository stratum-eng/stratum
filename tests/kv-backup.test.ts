import { describe, expect, it, vi } from "vitest";
import { exportKvIdentity, restoreKvIdentity } from "../src/storage/kv-backup";
import { setProject, setWorkspace } from "../src/storage/state";
import type { ProjectEntry, WorkspaceEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const project = (id: string, slug: string): ProjectEntry => ({
  id,
  name: slug,
  slug,
  namespace: "@owner",
  ownerId: "u1",
  ownerType: "user",
  remote: `https://artifacts.example.com/repos/${slug}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const workspace = (name: string, parent: string): WorkspaceEntry => ({
  name,
  remote: `https://artifacts.example.com/repos/${name}`,
  parent,
  branchName: name,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("KV identity backup", () => {
  it("dumps and restores projects and workspaces", async () => {
    const src = makeFakeKV();
    await setProject(src, project("p1", "repo-a"), logger);
    await setProject(src, project("p2", "repo-b"), logger);
    await setWorkspace(src, "p1", workspace("fix-bug", "p1"), logger);
    await setWorkspace(src, "p2", workspace("feat-x", "p2"), logger);

    const dump = await exportKvIdentity(src, logger);
    expect(dump.success).toBe(true);
    if (!dump.success) return;
    expect(dump.data.projectCount).toBe(2);
    expect(dump.data.workspaceCount).toBe(2);

    const dst = makeFakeKV();
    const restored = await restoreKvIdentity(dst, dump.data.projects, dump.data.workspaces, logger);
    expect(restored.success && restored.data).toEqual({ projects: 2, workspaces: 2 });

    // Restored KV resolves the same project + workspace keys as the source.
    expect(dst.store.size).toBe(src.store.size);
    expect([...dst.store.keys()].sort()).toEqual([...src.store.keys()].sort());
  });

  it("handles an empty instance", async () => {
    const dump = await exportKvIdentity(makeFakeKV(), logger);
    expect(dump.success && dump.data.projectCount).toBe(0);
  });
});
