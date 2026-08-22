import git from "isomorphic-git";
import { type NodeFS, artifactsRepoNameFromRemote, pushMain, pushTags } from "../storage/git-ops";
import { MemoryFS } from "../storage/memory-fs";
import { placeLooseObject, unpackObjects } from "../storage/object-loader";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";
import type { RepoManifest, RepoSnapshot } from "./repo-snapshot";

const DIR = "/";
/**
 * Upper bound on a manifest tag name. Not a git rule — git bounds ref names by
 * the filesystem, not a fixed count — but a restore writes the name into a ref
 * path, so a hostile manifest gets a cap rather than an unbounded path.
 */
const MAX_TAG_NAME_LENGTH = 255;
const GITDIR = "/.git";

/**
 * Reconstructs a repository in an in-memory Git store from a snapshot.
 *
 * Restores the main branch and any tagged references, and verifies that their
 * referenced objects are present in the snapshot.
 *
 * The verification matters because the backup captured the FULL reachable
 * object set: the reconstructed pack is closed under reachability, so the
 * original tip sha is preserved rather than a new one being synthesised. A
 * resolved tip that disagrees with the manifest means the pack was truncated,
 * which must fail rather than silently restore a different history.
 *
 * Operates on an in-memory store, so it is fully testable without Artifacts.
 *
 * @param pack - Serialized Git objects from the snapshot
 * @param manifest - Snapshot metadata containing the main branch tip and optional tags
 * @returns The in-memory filesystem and repository directory, or a backup error
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

    // Tag refs (#182). `tags` is OPTIONAL: manifests from backups taken before
    // tag support omit it, and such a restore must keep working unchanged.
    for (const tag of manifest.tags ?? []) {
      // The name becomes a ref path component and is written with force:true,
      // and the manifest is read back from storage — so validate here rather
      // than trust the snapshot writer. A name containing `..` would resolve
      // outside refs/tags/ and could overwrite refs/heads/main.
      if (!isValidTagName(tag.name)) {
        return err(new AppError(`Invalid tag name in manifest: ${tag.name}`, "BACKUP_ERROR", 500));
      }
      await git.writeRef({
        // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
        fs: fs as any,
        dir: DIR,
        ref: `refs/tags/${tag.name}`,
        value: tag.oid,
        force: true,
      });
      // Same dangling-ref guard as the tip: prove the tag's object (annotated
      // tag object or lightweight target) actually unpacked.
      // biome-ignore lint/suspicious/noExplicitAny: isomorphic-git fs shape
      await git.readObject({ fs: fs as any, dir: DIR, oid: tag.oid });
    }

    logger.debug("Reconstructed repo", {
      tipSha: manifest.tipSha,
      tagCount: manifest.tags?.length ?? 0,
    });
    return ok({ fs, dir: DIR });
  } catch (error) {
    logger.error("Failed to reconstruct repo", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to reconstruct repo", "BACKUP_ERROR", 500));
  }
}

/**
 * Whether a manifest tag name is safe to write as `refs/tags/<name>`.
 *
 * Restore consumes stored manifest data, so the ref path is validated here
 * rather than trusted from the snapshot writer: an unchecked `../` escapes
 * `refs/tags/` and, with `force: true`, can overwrite `refs/heads/main`.
 *
 * These are git's own `check-ref-format` rules, expressed as a denylist. An
 * allowlist was tried first and was wrong in a way that matters for a restore
 * path: it rejected `release@prod`, every non-ASCII name, and `%`, `,`, `!`,
 * `(`, `'`, `=`, `&`, `;`, `{` — all of which git accepts. A backup holding
 * such a tag could be written but never restored, which is worse than the
 * traversal the allowlist was defending against.
 *
 * The oracle here is isomorphic-git's `writeRef`, not the `git` CLI, because
 * that is what performs the write. It is the stricter of the two: it treats a
 * ref as valid only if `clean-git-ref` leaves it unchanged, so it refuses
 * `v1./next` (`./` collapses to `/`) even though `git check-ref-format`
 * accepts it. Validating against the CLI's looser rules would let such a name
 * past this guard and throw from `writeRef` half-way through the tag loop,
 * leaving a partially restored repository — so `./` is rejected here.
 *
 * Differentially fuzzed against `writeRef` over ~1300 generated names with a
 * fresh MemoryFS per name: no name is accepted here that `writeRef` refuses.
 *
 * @param name - The candidate tag name, straight from the manifest.
 * @returns `true` if `refs/tags/<name>` is a ref name git would accept.
 */
function isValidTagName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) return false;
  // Not a git rule: a Stratum bound so a hostile manifest can't push an
  // arbitrarily long path at the ref store.
  if (name.length > MAX_TAG_NAME_LENGTH) return false;

  // Control characters (including DEL) and space, compared by code point. A
  // regex range spanning them is what lint rules about control characters in
  // patterns object to, and the comparison states the bound outright.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  // The characters git reserves for its revision syntax.
  if (/[~^:?*[\\]/.test(name)) return false;

  if (name.includes("..") || name.includes("@{")) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  // `./` and a trailing `.` are both rewritten by clean-git-ref, so writeRef
  // rejects them.
  if (name.includes("./") || name.endsWith(".")) return false;

  return name.split("/").every((c) => c.length > 0 && !c.startsWith(".") && !c.endsWith(".lock"));
}

/**
 * Restores a project's repository to Artifacts, optionally overwriting an
 * existing repository.
 *
 * The push leg is the one part that cannot run in CI -- it needs real
 * Artifacts -- so it is validated on staging via the runbook instead. Keep
 * that in mind when changing this function: the tests around it cover
 * reconstruction, not publication.
 *
 * @param snapshot - The repository snapshot and manifest to restore.
 * @param opts - Restore options; set `force` to overwrite an existing repository.
 * @returns The restored manifest tip SHA.
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

  // If we freshly created the repo but the reconstruction or push fails, delete the
  // empty repo we just made — otherwise a retried restore sees it and (wrongly)
  // demands `force`, even though there is nothing to protect.
  const rollbackIfCreated = async () => {
    if (repoExists) return;
    const removed = await fromPromise(env.ARTIFACTS.delete(name));
    if (!removed.success) {
      logger.warn("Failed to roll back orphaned repo after a failed restore", { name });
    }
  };

  const rebuilt = await reconstructRepo(snapshot.pack, snapshot.manifest, logger);
  if (!rebuilt.success) {
    await rollbackIfCreated();
    return err(rebuilt.error);
  }

  const pushed = await pushMain(remote, token, rebuilt.data.fs, rebuilt.data.dir, logger, {
    force: repoExists,
  });
  if (!pushed.success) {
    await rollbackIfCreated();
    return err(pushed.error);
  }

  // Tag refs (#182): push after main so their target commits are already on the
  // remote. Optional field — a pre-tag-support manifest restores exactly as before.
  const tagNames = (snapshot.manifest.tags ?? []).map((t) => t.name);
  if (tagNames.length > 0) {
    const tagsPushed = await pushTags(
      remote,
      token,
      rebuilt.data.fs,
      rebuilt.data.dir,
      tagNames,
      logger,
      { force: repoExists },
    );
    if (!tagsPushed.success) {
      // rollbackIfCreated is a no-op for a pre-existing repo, so a forced restore
      // that fails here leaves main pushed and only some tags present. Say so
      // explicitly: the caller's error alone cannot convey how far it got.
      if (repoExists) {
        logger.error("Forced restore left partial state on an existing repo", undefined, {
          name,
          tipSha: snapshot.manifest.tipSha,
          mainPushed: true,
          tagCount: tagNames.length,
          detail: tagsPushed.error.message,
        });
      }
      await rollbackIfCreated();
      return err(tagsPushed.error);
    }
  }

  logger.info("Restored project repo", {
    name,
    tipSha: snapshot.manifest.tipSha,
    tagCount: tagNames.length,
  });
  return ok({ tipSha: snapshot.manifest.tipSha });
}
