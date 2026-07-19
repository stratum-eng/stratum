import git from "isomorphic-git";
import { type NodeFS, artifactsRepoNameFromRemote, pushMain } from "../storage/git-ops";
import { MemoryFS } from "../storage/memory-fs";
import { placeLooseObject, unpackObjects } from "../storage/object-loader";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";
import type { RepoManifest, RepoSnapshot } from "./repo-snapshot";

const DIR = "/";
const GITDIR = "/.git";

/**
 * Rebuild a repo in an in-memory git store from a snapshot's pack + manifest:
 * write every object loose, point `main` at the tip, and verify the resolved tip
 * matches the manifest. Because the backup captured the FULL reachable object set,
 * the reconstructed pack is closed under reachability and the original tip sha is
 * preserved. Fully testable — no Artifacts.
 */
export async function reconstructRepo(
  pack: Uint8Array,
  manifest: RepoManifest,
  logger: Logger,
): Promise<Result<{ fs: NodeFS; dir: string }, AppError>> {
  try {
    const fs = new MemoryFS().toNodeFS() as unknown as NodeFS;
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await git.init({ fs: fs as any, dir: DIR, defaultBranch: "main" });

    for (const obj of unpackObjects(pack)) {
      await placeLooseObject(fs, GITDIR, obj.oid, obj.bytes);
    }
    await git.writeRef({
      // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
      fs: fs as any,
      dir: DIR,
      ref: "refs/heads/main",
      value: manifest.tipSha,
      force: true,
    });

    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    const resolved = await git.resolveRef({ fs: fs as any, dir: DIR, ref: "main" });
    if (resolved !== manifest.tipSha) {
      return err(
        new AppError(
          `Reconstructed tip ${resolved} does not match manifest ${manifest.tipSha}`,
          "BACKUP_ERROR",
          500,
        ),
      );
    }
    // resolveRef only reads back the ref we just wrote; it does not prove the tip
    // COMMIT OBJECT actually unpacked into the store. readCommit does — it throws
    // if the object (or any pack it needs) is missing, catching a corrupt pack
    // that reconstructs a dangling ref.
    // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
    await git.readCommit({ fs: fs as any, dir: DIR, oid: manifest.tipSha });
    logger.debug("Reconstructed repo", { tipSha: manifest.tipSha });
    return ok({ fs, dir: DIR });
  } catch (error) {
    logger.error("Failed to reconstruct repo", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to reconstruct repo", "BACKUP_ERROR", 500));
  }
}

/**
 * Restore a project's repo into Artifacts: create the repo (or reuse with
 * `force`), reconstruct the objects, and push. The push against real Artifacts is
 * the one leg that can't run in CI — it is validated on staging via the runbook.
 */
export async function restoreProjectRepo(
  env: Env,
  snapshot: RepoSnapshot,
  opts: { force?: boolean },
  logger: Logger,
): Promise<Result<{ tipSha: string }, AppError>> {
  if (!env.ARTIFACTS)
    return err(new AppError("ARTIFACTS binding not configured", "CONFIG_ERROR", 500));

  const project = snapshot.manifest.project;
  const name = artifactsRepoNameFromRemote(project.remote);
  if (!name)
    return err(new AppError("Project remote is not an Artifacts repo", "BACKUP_ERROR", 500));

  // Determine whether the repo already exists so we don't clobber live data.
  const existing = await fromPromise(env.ARTIFACTS.get(name));
  let remote: string;
  let token: string;
  const repoExists = existing.success && existing.data != null;

  if (repoExists) {
    if (!opts.force) {
      return err(
        new AppError(`Repo '${name}' already exists; pass force to overwrite`, "CONFLICT", 409),
      );
    }
    const tok = await fromPromise(existing.data.createToken("write"));
    if (!tok.success) return err(new AppError("Failed to mint write token", "STORAGE_ERROR", 500));
    remote = existing.data.remote;
    token = tok.data.plaintext;
  } else {
    const created = await fromPromise(env.ARTIFACTS.create(name));
    if (!created.success)
      return err(new AppError(`Failed to create repo '${name}'`, "STORAGE_ERROR", 500));
    remote = created.data.remote;
    token = created.data.token;
  }

  const rebuilt = await reconstructRepo(snapshot.pack, snapshot.manifest, logger);
  if (!rebuilt.success) return err(rebuilt.error);

  const pushed = await pushMain(remote, token, rebuilt.data.fs, rebuilt.data.dir, logger, {
    force: repoExists,
  });
  if (!pushed.success) return err(pushed.error);

  logger.info("Restored project repo", { name, tipSha: snapshot.manifest.tipSha });
  return ok({ tipSha: snapshot.manifest.tipSha });
}
