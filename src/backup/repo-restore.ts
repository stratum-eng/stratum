import git from "isomorphic-git";
import {
  type NodeFS,
  artifactsRepoNameFromRemote,
  pushBranches,
  pushMain,
  pushTags,
} from "../storage/git-ops";
import { isValidBranchName } from "../storage/git-ops";
import { MemoryFS } from "../storage/memory-fs";
import { placeLooseObject, unpackObjects } from "../storage/object-loader";
import type { Env } from "../types";
import { projectDefaultBranch } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";
import { isValidRefName } from "../utils/validation";
import type { RepoManifest, RepoSnapshot } from "./repo-snapshot";

const DIR = "/";
const GITDIR = "/.git";

/**
 * Reconstructs a repository in an in-memory Git store from a snapshot.
 *
 * Restores the default branch, any tagged references, and any other branch
 * refs the manifest carries, verifying that their referenced objects are
 * present in the snapshot.
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
 * @param manifest - Snapshot metadata containing the tip and optional tags
 * @param branch - The branch to point at the tip; defaults to `main`, but imported repos keep their source branch name (master/trunk/…), and restoring one under the wrong name would leave the repo with no branch at its own default
 * @returns The in-memory filesystem, the repository directory, and the names of
 * the extra branch refs actually written — which is NOT simply
 * `manifest.branches`, since hostile, default-branch, and dangling entries are
 * skipped here. The caller pushes that list rather than the manifest's, so the
 * skip decisions live in one place and a push can never name a ref this repo
 * does not hold.
 */
export async function reconstructRepo(
  pack: Uint8Array,
  manifest: RepoManifest,
  logger: Logger,
  branch = "main",
): Promise<Result<{ fs: NodeFS; dir: string; branches: string[] }, AppError>> {
  try {
    const fs = new MemoryFS().toNodeFS();
    await git.init({ fs, dir: DIR, defaultBranch: branch });

    for (const obj of unpackObjects(pack)) {
      await placeLooseObject(fs, GITDIR, obj.oid, obj.bytes);
    }
    await git.writeRef({
      fs,
      dir: DIR,
      ref: `refs/heads/${branch}`,
      value: manifest.tipSha,
      force: true,
    });

    const resolved = await git.resolveRef({ fs, dir: DIR, ref: branch });
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
    await git.readCommit({ fs, dir: DIR, oid: manifest.tipSha });

    // Tag refs (#182). `tags` is OPTIONAL: manifests from backups taken before
    // tag support omit it, and such a restore must keep working unchanged.
    for (const tag of manifest.tags ?? []) {
      // The name becomes a ref path component and is written with force:true,
      // and the manifest is read back from storage — so validate here rather
      // than trust the snapshot writer. A name containing `..` would resolve
      // outside refs/tags/ and could overwrite refs/heads/main.
      if (!isValidRefName(tag.name)) {
        return err(new AppError(`Invalid tag name in manifest: ${tag.name}`, "BACKUP_ERROR", 500));
      }
      await git.writeRef({
        fs,
        dir: DIR,
        ref: `refs/tags/${tag.name}`,
        value: tag.oid,
        force: true,
      });
      // Same dangling-ref guard as the tip: prove the tag's object (annotated
      // tag object or lightweight target) actually unpacked.
      await git.readObject({ fs, dir: DIR, oid: tag.oid });
    }

    // Branch refs (#181). `branches` is OPTIONAL, and here absence and `[]` are
    // handled identically on purpose: a legacy manifest, a snapshot whose ref
    // advertisement failed, and a repo with genuinely no branches all restore
    // to "tip only", which is exactly what each of them should do. The manifest
    // keeps the three distinguishable (see `RepoManifest.branches`) for a reader
    // reporting on backup completeness; restore does not need the distinction.
    //
    // The tip ref written above is `refs/heads/${branch}`; `restoreProjectRepo`
    // passes the project's default branch for it, but a direct caller need not,
    // so both names are held back below rather than assuming the two agree.
    const tipBranches = new Set([branch, projectDefaultBranch(manifest.project)]);
    const branches: string[] = [];
    for (const branchRef of manifest.branches ?? []) {
      // Same untrusted-input reasoning as the tag loop: the manifest is read
      // back from storage and the name becomes a ref path written with
      // force:true. Here it matters more, not less — `refs/heads/` is the very
      // namespace a `../heads/main` traversal aims at.
      //
      // Unlike the tag loop this SKIPS rather than failing the restore, per the
      // spec's edge-case 16. The two other guards below already degrade that
      // way, and one unusable branch ref is not worth withholding the tip and
      // every tag from an operator: branch refs are the one part of a repo that
      // can be recreated by hand afterwards.
      // `isValidBranchName`, not `isValidRefName`: the restore path is the
      // designated UNTRUSTED input, so it must not be one guard weaker than the
      // request path. `HEAD` is the difference — legal for a tag, and refused
      // as a branch because it collides with the symbolic ref every client
      // resolves to find the default branch.
      if (!isValidBranchName(branchRef.name)) {
        logger.warn("Restore: skipping branch with an invalid name in manifest", {
          name: branchRef.name,
        });
        continue;
      }
      // The verified tip is already written at this exact ref, and a manifest
      // oid can be stale — overwriting it would restore a different history
      // than the one the tip check above just proved. No such guard exists on
      // the tag path because tags land in refs/tags/, a namespace the tip does
      // not occupy.
      if (tipBranches.has(branchRef.name)) {
        // Equal oids are the ordinary case and warrant no noise. A DISAGREEING
        // oid is the one an operator needs: it means the branch moved between
        // the ref advertisement and the object walk, so the tip this restore
        // verified is not the commit the manifest recorded for that name.
        if (branchRef.oid !== manifest.tipSha) {
          logger.warn("Restore: manifest entry for the tip branch is stale; keeping verified tip", {
            name: branchRef.name,
            manifestOid: branchRef.oid,
            tipSha: manifest.tipSha,
          });
        }
        continue;
      }
      // Dangling-tip guard, checked BEFORE the write rather than after it as
      // the tag loop does: skipping means leaving no ref behind at all.
      const tip = await fromPromise(git.readObject({ fs, dir: DIR, oid: branchRef.oid }));
      if (!tip.success) {
        logger.warn("Restore: skipping branch whose tip is absent from the restored objects", {
          name: branchRef.name,
          oid: branchRef.oid,
        });
        continue;
      }
      // A branch must point at a COMMIT. The create path enforces this, so a
      // manifest saying otherwise is corrupt or hostile — and writing it would
      // fail the push with an ObjectTypeError AFTER the tip and every tag had
      // already landed, leaving a forced restore in partial state.
      if (tip.data.type !== "commit") {
        logger.warn("Restore: skipping branch whose tip is not a commit", {
          name: branchRef.name,
          oid: branchRef.oid,
          type: tip.data.type,
        });
        continue;
      }
      // Refs are files in a directory tree, so `main` and `main/x` cannot both
      // exist and `writeRef` throws ENOTDIR on the second. Caught per branch:
      // an unguarded throw here escapes to the outer catch and withholds the
      // tip and every tag over one unusable ref — exactly what the skip-don't-
      // fail choice above exists to avoid.
      const written = await fromPromise(
        git.writeRef({
          fs,
          dir: DIR,
          ref: `refs/heads/${branchRef.name}`,
          value: branchRef.oid,
          force: true,
        }),
      );
      if (!written.success) {
        logger.warn("Restore: skipping branch whose ref path collides with one already written", {
          name: branchRef.name,
          error: written.error instanceof Error ? written.error.message : String(written.error),
        });
        continue;
      }
      branches.push(branchRef.name);
    }

    logger.debug("Reconstructed repo", {
      tipSha: manifest.tipSha,
      tagCount: manifest.tags?.length ?? 0,
      branchCount: branches.length,
    });
    return ok({ fs, dir: DIR, branches });
  } catch (error) {
    logger.error("Failed to reconstruct repo", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to reconstruct repo", "BACKUP_ERROR", 500));
  }
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

  // Restore under the project's real default branch so an imported master/trunk
  // repo comes back with the ref every other git op targets.
  const branch = projectDefaultBranch(project);
  const rebuilt = await reconstructRepo(snapshot.pack, snapshot.manifest, logger, branch);
  if (!rebuilt.success) {
    await rollbackIfCreated();
    return err(rebuilt.error);
  }

  const pushed = await pushMain(remote, token, rebuilt.data.fs, rebuilt.data.dir, logger, {
    force: repoExists,
    branch,
  });
  if (!pushed.success) {
    // A PUSH_TIMEOUT is not a confirmed failure — the underlying push is
    // never actually cancelled, so it may still land after this returns.
    // Deleting the repo on that ambiguous a signal risks destroying a
    // restore that actually succeeded (or racing a delete against a push
    // still in flight); leave it in place and say the outcome is unknown
    // rather than assuming either "definitely restored" or "safe to clean up".
    if (pushed.error.code === "PUSH_TIMEOUT") {
      logger.error("Restore push timed out; outcome unknown, not rolling back", undefined, {
        name,
        repoExists,
        detail: pushed.error.message,
      });
      return err(pushed.error);
    }
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
      // Same ambiguity as pushMain's own PUSH_TIMEOUT check: the timed-out
      // tag (and everything after it) may still land, and rolling back would
      // also destroy main plus every tag already confirmed pushed on the
      // strength of a signal that isn't a confirmed failure.
      if (tagsPushed.error.code === "PUSH_TIMEOUT") {
        logger.error("Restore tag push timed out; outcome unknown, not rolling back", undefined, {
          name,
          repoExists,
          detail: tagsPushed.error.message,
        });
        return err(tagsPushed.error);
      }
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

  // Branch refs (#181): pushed last, after main and the tags, so every object
  // a branch tip needs is already on the remote. The names come from the
  // reconstruction, not from the manifest, so a skipped branch is never pushed.
  const branchNames = rebuilt.data.branches;
  // `pushBranches`, not `pushBranchToRemote`: the latter is the GitHub helper
  // and authenticates as `x-access-token` with the token verbatim. An Artifacts
  // token is `<secret>?expires=<ts>` and the suffix must be stripped, so the
  // GitHub helper would have failed EVERY restore that carried a branch — after
  // main and the tags had already landed.
  const branchesPushed = await pushBranches(
    remote,
    token,
    rebuilt.data.fs,
    rebuilt.data.dir,
    branchNames,
    logger,
    { force: repoExists },
  );
  if (!branchesPushed.success) {
    if (repoExists) {
      logger.error("Forced restore left partial state on an existing repo", undefined, {
        name,
        tipSha: snapshot.manifest.tipSha,
        mainPushed: true,
        tagCount: tagNames.length,
        branchCount: branchNames.length,
        detail: branchesPushed.error.message,
      });
    }
    await rollbackIfCreated();
    return err(branchesPushed.error);
  }

  logger.info("Restored project repo", {
    name,
    tipSha: snapshot.manifest.tipSha,
    tagCount: tagNames.length,
    branchCount: branchNames.length,
  });
  return ok({ tipSha: snapshot.manifest.tipSha });
}
