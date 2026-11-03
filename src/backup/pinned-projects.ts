import type { ProjectEntry } from "../types";
import type { Logger } from "../utils/logger";
import { validateNamespace, validateSlug } from "../utils/validation";

/** A project the operator has pinned into every backup run, by its URL path. */
export interface PinnedProjectRef {
  namespace: string;
  slug: string;
}

export interface ParsedPins {
  pins: PinnedProjectRef[];
  /** Entries rejected as malformed, verbatim (after trimming). */
  invalid: string[];
}

/** Canonical `@namespace/slug` form, used for dedup, matching and reporting. */
export function pinPath(ref: PinnedProjectRef): string {
  return `${ref.namespace}/${ref.slug}`;
}

/**
 * Parse `BACKUP_PINNED_PROJECTS`: a comma-separated list of `@namespace/slug`
 * entries. The leading `@` is optional (`ns/slug` means `@ns/slug`) because every
 * namespace carries one and operators routinely omit it.
 *
 * Strict by design: an entry is accepted only if both halves pass the same
 * validators the project routes use. A malformed entry is dropped and reported
 * rather than guessed at — loosely matching a typo could silently back up the
 * wrong repository while the intended one goes uncovered. Empty entries (a
 * trailing comma, `a,,b`) are ignored, and duplicates collapse to one.
 */
export function parsePinnedProjects(raw: string | undefined): ParsedPins {
  const pins: PinnedProjectRef[] = [];
  const invalid: string[] = [];
  if (raw === undefined) return { pins, invalid };

  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;

    const segments = entry.split("/");
    if (segments.length !== 2) {
      invalid.push(entry);
      continue;
    }
    const [rawNamespace = "", slug = ""] = segments;
    const namespace = rawNamespace.startsWith("@") ? rawNamespace : `@${rawNamespace}`;
    if (!validateNamespace(namespace).success || !validateSlug(slug).success) {
      invalid.push(entry);
      continue;
    }

    const ref = { namespace, slug };
    const key = pinPath(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push(ref);
  }
  return { pins, invalid };
}

export interface ResolvedPins {
  /** Pinned projects that exist, in the order the operator listed them. */
  pinned: ProjectEntry[];
  /** Well-formed entries that matched no project (deleted, renamed, or a typo). */
  missing: string[];
}

/**
 * Resolve parsed pins against the project list, logging a warning for every
 * entry that cannot be honoured so a misconfiguration is visible in the logs of
 * every run rather than discovered at restore time.
 */
export function resolvePinnedProjects(
  raw: string | undefined,
  projects: readonly ProjectEntry[],
  logger: Logger,
): ResolvedPins {
  const { pins, invalid } = parsePinnedProjects(raw);
  for (const entry of invalid) {
    logger.warn("Backup: ignoring malformed BACKUP_PINNED_PROJECTS entry", {
      entry,
      expected: "@namespace/slug",
    });
  }

  const byPath = new Map<string, ProjectEntry>();
  for (const p of projects) byPath.set(pinPath(p), p);

  const pinned: ProjectEntry[] = [];
  const missing: string[] = [];
  const pinnedIds = new Set<string>();
  for (const ref of pins) {
    const path = pinPath(ref);
    const project = byPath.get(path);
    if (!project) {
      missing.push(path);
      logger.warn("Backup: pinned project not found; it is not in this run", { project: path });
      continue;
    }
    // Two paths can't resolve to one id today, but guard so a pinned project is
    // never snapshotted twice in one run.
    if (pinnedIds.has(project.id)) continue;
    pinnedIds.add(project.id);
    pinned.push(project);
  }
  return { pinned, missing };
}
