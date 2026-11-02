import type { Env, ProjectEntry, User } from "../types";
import { getArtifactsRepoName, getUserNamespace } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { type DeletionTarget, captureDeletionTarget } from "./deletion";
import { createDeletionJob } from "./deletion-jobs";
import { deleteProject, getProjectByPath } from "./state";
import { getUser } from "./users";

/*
 * A personal project is keyed under its owner's username, in KV. A username
 * change must therefore refuse while any project exists, and project creation
 * must not land under a name its owner has just given up. The two operations
 * touch different stores, and KV listings are only eventually consistent, so
 * KV alone cannot order them. D1 can: creation records a claim here before it
 * writes KV, and the rename (renameUser) refuses in the same UPDATE when a
 * claim exists. Whichever of the two reaches D1 first wins, and the loser sees
 * it: a rename after a claim is refused; a claim after a rename is caught by
 * confirmOwnerNamespace, which re-reads the owner and withdraws the project.
 *
 * A claim is released when its project is withdrawn during creation, and the
 * release is best effort: D1 can fail right after KV succeeded, and nothing
 * durable retries it. So a claim is not trusted forever. Past CLAIM_GRACE_MS
 * the KV entry is visible everywhere, and ownerHasClaims checks the claim
 * against it, dropping one with no project behind it, whether the release
 * failed or the project was deleted later. Within the window the claim is
 * taken at its word, which is the whole point of having it.
 */

/**
 * How long a claim counts without a KV check. KV writes settle across edges
 * within about a minute; fifteen keeps a wide margin and still bounds how long
 * a deleted or half-withdrawn project can hold a username.
 */
export const CLAIM_GRACE_MS = 15 * 60 * 1000;

interface ClaimRow {
  namespace: string;
  slug: string;
  created_at: string;
}

/** Record that `ownerId` is creating `namespace/slug`. Same owner re-creating a deleted slug simply refreshes the row. */
export async function claimNamespace(
  db: D1Database,
  claim: { ownerId: string; namespace: string; slug: string },
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        "INSERT OR REPLACE INTO namespace_claims (namespace, slug, owner_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(claim.namespace, claim.slug, claim.ownerId, new Date().toISOString())
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to record a namespace claim", error instanceof Error ? error : undefined, {
      ...claim,
    });
    return err(new AppError("Failed to record the project", "STORAGE_ERROR", 500, { ...claim }));
  }
}

/** Forget a claim whose project was withdrawn before it ever existed. */
export async function releaseNamespaceClaim(
  db: D1Database,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("DELETE FROM namespace_claims WHERE namespace = ? AND slug = ?")
      .bind(namespace, slug)
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error(
      "Failed to release a namespace claim",
      error instanceof Error ? error : undefined,
      {
        namespace,
        slug,
      },
    );
    return err(
      new AppError("Failed to release the claim", "STORAGE_ERROR", 500, { namespace, slug }),
    );
  }
}

/**
 * Whether `ownerId` holds a project under a claim: the strongly consistent
 * half of "may this username change". A claim younger than CLAIM_GRACE_MS
 * counts as it stands; an older one counts only if KV has its project, and a
 * stale one is dropped on the way past so the rename's own UPDATE does not
 * refuse on it. Fails closed: a claim that cannot be checked, or a stale one
 * that cannot be dropped, is an error rather than a count either way.
 * `now` is injectable for tests.
 */
export async function ownerHasClaims(
  env: Pick<Env, "DB" | "STATE">,
  ownerId: string,
  logger: Logger,
  now = Date.now(),
): Promise<Result<boolean, AppError>> {
  let claims: ClaimRow[];
  try {
    const result = await env.DB.prepare(
      "SELECT namespace, slug, created_at FROM namespace_claims WHERE owner_id = ? ORDER BY created_at DESC",
    )
      .bind(ownerId)
      .all<ClaimRow>();
    claims = result.results;
  } catch (error) {
    logger.error("Failed to read namespace claims", error instanceof Error ? error : undefined, {
      ownerId,
    });
    return err(new AppError("Failed to read namespace claims", "STORAGE_ERROR", 500, { ownerId }));
  }
  for (const claim of claims) {
    // Newest first, so the first young claim answers without a KV read. An
    // unparsable timestamp makes the age NaN, which fails the test and counts
    // the claim as live: the safe side.
    const age = now - Date.parse(claim.created_at);
    if (!(age >= CLAIM_GRACE_MS)) return ok(true);
    const present = await projectExists(env.STATE, claim.namespace, claim.slug, logger);
    if (!present.success) return present;
    if (present.data) return ok(true);
    logger.warn("Dropping a namespace claim with no project behind it", { ownerId, ...claim });
    const dropped = await dropStaleClaim(env.DB, claim, logger);
    if (!dropped.success) return dropped;
  }
  return ok(false);
}

/** Whether KV holds the project: a 404 is a clean "no"; any other failure, a thrown read included, is unknown. */
async function projectExists(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const found = await getProjectByPath(kv, namespace, slug, logger);
    if (found.success) return ok(true);
    if (found.error.statusCode === 404) return ok(false);
    return err(found.error);
  } catch (error) {
    logger.error(
      "Failed to read the project behind a namespace claim",
      error instanceof Error ? error : undefined,
      { namespace, slug },
    );
    return err(
      new AppError("Failed to read the project behind a namespace claim", "STORAGE_ERROR", 500, {
        namespace,
        slug,
      }),
    );
  }
}

/**
 * Remove exactly the row that was found stale. Matching on `created_at` too
 * means a claim refreshed meanwhile by a re-creation of the same slug is left
 * alone for the rename's UPDATE to see.
 */
async function dropStaleClaim(
  db: D1Database,
  claim: ClaimRow,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("DELETE FROM namespace_claims WHERE namespace = ? AND slug = ? AND created_at = ?")
      .bind(claim.namespace, claim.slug, claim.created_at)
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error(
      "Failed to drop a stale namespace claim",
      error instanceof Error ? error : undefined,
      {
        ...claim,
      },
    );
    return err(
      new AppError("Failed to drop a stale namespace claim", "STORAGE_ERROR", 500, { ...claim }),
    );
  }
}

/**
 * After a personal project has been written to KV, confirm that its owner
 * still carries its namespace, and withdraw the project if not.
 *
 * This is the creation side of the ordering described at the top of the
 * file: the claim went into D1 before the KV write, so if the owner's name
 * has moved by now, the rename committed before the claim and this project is
 * under a namespace nobody holds. It is withdrawn (KV entry, backing
 * repository, claim) and the caller reports a conflict so the user retries
 * under the new name.
 *
 * Fails closed. An owner that cannot be re-read (after one retry) leaves the
 * project unconfirmed, and an unconfirmed project is withdrawn rather than
 * left where a rename may have stranded it: the project is seconds old and
 * its creator is at the keyboard, so a retry is cheap, whereas an orphan is
 * invisible to everyone. Org-owned projects are not subject to any of this:
 * an org's slug is its own.
 */
export async function confirmOwnerNamespace(
  env: Env,
  ownerId: string,
  project: ProjectEntry,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const { namespace, slug } = project;
  const owner = await readOwner(env.DB, ownerId, logger);
  if (owner === null) {
    logger.warn("Owner could not be re-read after creating a project; withdrawing it", {
      ownerId,
      namespace,
      slug,
    });
    const withdrawn = await withdraw(env, project, logger);
    if (!withdrawn.success) return withdrawn;
    return err(
      new AppError(
        "Your account could not be confirmed after the project was created, so it was not kept. Try again.",
        "STORAGE_ERROR",
        500,
        { namespace, slug },
      ),
    );
  }
  if (getUserNamespace(owner.username) === namespace) return ok(undefined);

  logger.warn("Project withdrawn - the owner's username changed during creation", {
    ownerId,
    namespace,
    slug,
    current: owner.username,
  });
  const withdrawn = await withdraw(env, project, logger);
  if (!withdrawn.success) return withdrawn;
  return err(
    new AppError(
      "Your username changed while the project was being created, so it was not kept. Try again.",
      "CONFLICT",
      409,
      { namespace, slug },
    ),
  );
}

/**
 * The owner row, with one retry: a single failed read must not decide a
 * project's fate. A read that rejects counts as a failure like one that
 * returns an error, so a thrown D1 error still reaches the withdrawal path.
 */
async function readOwner(db: D1Database, ownerId: string, logger: Logger): Promise<User | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await getUser(db, ownerId, logger);
      if (result.success) return result.data;
    } catch (error) {
      logger.warn("Owner read threw", {
        ownerId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

/**
 * Remove the project entry, then its backing repository and its claim, in
 * that order: once the entry is gone the project is unreachable, and a
 * leftover repository is recovered by the "already exists" path on the next
 * create, whereas the reverse order could leave a reachable project with no
 * repository. The KV delete is retried once; an entry that still cannot be
 * removed stays reachable under a namespace its owner may not hold, so it is
 * handed to the durable deletion pipeline (scheduleWithdrawal) and reported
 * as a server error, with the repository and the claim left for that job.
 */
async function withdraw(
  env: Env,
  project: ProjectEntry,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const { namespace, slug } = project;
  let removed = await deleteProject(env.STATE, namespace, slug, logger);
  if (!removed.success) removed = await deleteProject(env.STATE, namespace, slug, logger);
  if (!removed.success) return scheduleWithdrawal(env, project, removed.error, logger);
  try {
    await env.ARTIFACTS.delete(getArtifactsRepoName(namespace, slug));
  } catch (error) {
    logger.warn("Could not delete the backing repository of a withdrawn project", {
      namespace,
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // Best effort: a leftover claim errs on the safe side until CLAIM_GRACE_MS
  // passes, after which ownerHasClaims finds no project behind it and drops it.
  await releaseNamespaceClaim(env.DB, namespace, slug, logger);
  return ok(undefined);
}

/**
 * Hand a project whose KV entry could not be removed to the deletion jobs
 * that the five-minute sweep re-drives: the same cascade a user-requested
 * delete goes through, so the entry, the repository and the D1 rows keyed
 * under the namespace all go, with retries and an operator trail. The
 * inventory is captured the normal way when it can be; the project is seconds
 * old, so when the capture itself fails (KV is what just failed) a target
 * built from the entry alone is complete except for the collision scan, which
 * is assumed positive so the cascade never touches rows keyed by a bare name
 * another tenant might share. A job that cannot be recorded either leaves the
 * project reachable with nothing tracking it, which is the one outcome that
 * needs a person: it is logged at error level and reported as such.
 */
async function scheduleWithdrawal(
  env: Env,
  project: ProjectEntry,
  cause: AppError,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const { namespace, slug } = project;
  const captured = await captureDeletionTarget(env, project, logger);
  const target: DeletionTarget = captured.success
    ? captured.data
    : {
        projectId: project.id,
        namespace,
        slug,
        name: project.name,
        workspaceNames: [],
        forkRepoNames: [],
        projectRepoName: getArtifactsRepoName(namespace, slug),
        changeIds: [],
        webhookIds: [],
        issueIds: [],
        nameCollision: true,
      };
  const job = await createDeletionJob(env.DB, logger, {
    kind: "project",
    target,
    targetId: project.id,
  });
  if (!job.success) {
    logger.error(
      "Project could not be withdrawn or scheduled for removal and remains under a namespace its owner may not hold",
      job.error,
      { namespace, slug, projectId: project.id, cause: cause.message },
    );
    return err(
      new AppError(
        "The project could not be withdrawn after its namespace changed. Contact support with its name.",
        "STORAGE_ERROR",
        500,
        { namespace, slug },
      ),
    );
  }
  logger.warn("Project could not be withdrawn directly; its removal is scheduled", {
    namespace,
    slug,
    projectId: project.id,
    jobId: job.data.job.id,
    capturedInventory: captured.success,
    cause: cause.message,
  });
  return err(
    new AppError(
      "The project could not be withdrawn after its namespace changed; its removal is scheduled. Try again in a few minutes.",
      "STORAGE_ERROR",
      500,
      { namespace, slug },
    ),
  );
}
