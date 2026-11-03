import { describe, expect, it, vi } from "vitest";
import { parsePinnedProjects, resolvePinnedProjects } from "../src/backup/pinned-projects";
import type { ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

function makeLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function project(namespace: string, slug: string, id = `${namespace}/${slug}`): ProjectEntry {
  return {
    id,
    name: slug,
    slug,
    namespace,
    ownerId: "u1",
    ownerType: "user",
    remote: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("parsePinnedProjects", () => {
  it("returns nothing for an unset or blank value", () => {
    expect(parsePinnedProjects(undefined)).toEqual({ pins: [], invalid: [] });
    expect(parsePinnedProjects("  , ,")).toEqual({ pins: [], invalid: [] });
  });

  it("accepts @namespace/slug and namespace/slug, trimming whitespace", () => {
    expect(parsePinnedProjects(" @org/core , jordan/dotfiles ").pins).toEqual([
      { namespace: "@org", slug: "core" },
      { namespace: "@jordan", slug: "dotfiles" },
    ]);
  });

  it("collapses duplicates, including @-less spellings of the same project", () => {
    expect(parsePinnedProjects("@org/core,org/core,@org/core").pins).toEqual([
      { namespace: "@org", slug: "core" },
    ]);
  });

  it("rejects malformed entries instead of guessing", () => {
    const parsed = parsePinnedProjects(
      "@org/core,core,@org/a/b,@Org/core,@org/,/core,@org/has space,@-bad/x",
    );
    expect(parsed.pins).toEqual([{ namespace: "@org", slug: "core" }]);
    expect(parsed.invalid).toEqual([
      "core",
      "@org/a/b",
      "@Org/core",
      "@org/",
      "/core",
      "@org/has space",
      "@-bad/x",
    ]);
  });
});

describe("resolvePinnedProjects", () => {
  it("resolves pins in listed order and reports missing and malformed entries", () => {
    const logger = makeLogger();
    const projects = [project("@aa", "one"), project("@bb", "two"), project("@cc", "three")];

    const resolved = resolvePinnedProjects(
      "@cc/three,@gone/repo,not-a-pin,@aa/one",
      projects,
      logger as unknown as Logger,
    );

    expect(resolved.pinned.map((p) => p.id)).toEqual(["@cc/three", "@aa/one"]);
    expect(resolved.missing).toEqual(["@gone/repo"]);
    const warnings = logger.warn.mock.calls.map((c) => c[1]);
    expect(warnings).toContainEqual({ entry: "not-a-pin", expected: "@namespace/slug" });
    expect(warnings).toContainEqual({ project: "@gone/repo" });
  });

  it("never pins one project id twice", () => {
    const logger = makeLogger();
    const projects = [project("@aa", "one", "same-id"), project("@aa", "alias", "same-id")];
    const resolved = resolvePinnedProjects(
      "@aa/one,@aa/alias",
      projects,
      logger as unknown as Logger,
    );
    expect(resolved.pinned.map((p) => p.id)).toEqual(["same-id"]);
  });
});
