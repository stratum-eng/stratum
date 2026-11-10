/**
 * Talking git to the GitHub copy of a project.
 *
 * The push mirror (#417) is the first caller; a resync from the mirror (#418)
 * is the next. Everything either needs to reach `github.com/<owner>/<repo>.git`
 * over smart HTTP is here, so neither has to know how the credential is chosen
 * or how isomorphic-git reports a refusal:
 *
 * - {@link openGitHubRemote} — the URL plus a GitHub App installation token
 *   narrowed to that one repository;
 * - {@link listGitHubRefs} — its branches and tags, one handshake, no objects;
 * - {@link isAncestor} — the fast-forward test, on a clone the caller holds;
 * - {@link pushRefFastForward} — push one ref, never forced, with the refusal
 *   classified.
 *
 * Nothing here force-pushes or deletes a ref, and there is deliberately no
 * option to. A caller that wants to overwrite GitHub has to write that code,
 * and argue for it, somewhere a reviewer will see it.
 */

import git from "isomorphic-git";
import {
  type NodeFS,
  type RemoteRefTree,
  createHttpClient,
  flattenRefTree,
  withTimeout,
} from "../storage/git-ops";
import { projectPrincipal } from "../storage/github-installations";
import type { ProjectEntry } from "../types";
import { AppError, ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";
import { type GitHubAuthEnv, resolveGitHubToken } from "./app-auth";

/** A handshake carries no object data, so a slow one is a stalled one. */
const REFS_TIMEOUT_MS = 15_000;
/**
 * Bounds one ref's push. Generous next to the 30s a change-promotion push
 * gets: a mirror's first push carries the whole history, and it runs on a
 * queue consumer with no user waiting on it.
 */
const PUSH_TIMEOUT_MS = 120_000;

/**
 * Built per call rather than once at module load: several suites replace
 * `git-ops` wholesale with a mock that has no `createHttpClient`, and a
 * top-level call would fail their import of anything that reaches this file.
 */
const httpClient = () => createHttpClient();

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** A GitHub repository this process may talk git to, and the token to do it. */
export interface GitHubRemote extends GitHubRepoRef {
  /** `https://github.com/<owner>/<repo>.git` */
  url: string;
  /** Installation token limited to this repository. Never log it. */
  token: string;
}

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Parses `owner/repo` (a trailing `.git` or a full `https://github.com/` URL is
 * tolerated), refusing anything that is not a plain GitHub repository path.
 *
 * The result is interpolated into a URL a credential is then sent to, so this
 * is a security boundary as much as input tidying: no other host, no extra
 * path segments, no `..`.
 */
export function parseGitHubRepo(input: unknown): GitHubRepoRef | null {
  if (typeof input !== "string") return null;
  const trimmed = input
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!GITHUB_OWNER.test(owner) || !GITHUB_NAME.test(repo)) return null;
  if (repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** The HTTPS git URL of a GitHub repository. */
export function githubRemoteUrl(target: GitHubRepoRef): string {
  return `https://github.com/${target.owner}/${target.repo}.git`;
}

/**
 * Resolves the credential for git access to `target` on behalf of `project`.
 *
 * Always a GitHub App installation token narrowed to the one repository with
 * `contents: <access>` (plus `workflows: write` for a write, when the App has
 * it) — never the instance PAT, which reaches every repository
 * its owner can. The project's owner must be linked to the installation, and a
 * `write` additionally requires the project to be the repository's canonical
 * target, so two projects can never both push to one repository. Both rules
 * live in `resolveGitHubToken`; this only asks for the narrow form.
 *
 * @returns The remote, or the refusal: `GITHUB_APP_NOT_CONFIGURED`,
 *   `GITHUB_APP_NOT_INSTALLED`, `GITHUB_APP_NOT_AUTHORIZED`,
 *   `GITHUB_APP_PERMISSION_DENIED`, `GITHUB_REPO_NOT_CANONICAL`, or a
 *   transient `GITHUB_ERROR`
 */
export async function openGitHubRemote(
  env: GitHubAuthEnv,
  project: ProjectEntry,
  target: GitHubRepoRef,
  access: "read" | "write",
  logger: Logger,
): Promise<Result<GitHubRemote, AppError>> {
  const token = await resolveGitHubToken(
    env,
    {
      owner: target.owner,
      repo: target.repo,
      principal: projectPrincipal(project),
      ...(access === "write" ? { project } : {}),
      repoScope: {
        permissions: { contents: access },
        // GitHub refuses a push that adds or changes a file under
        // `.github/workflows/` unless the token also carries `workflows`. Most
        // repositories worth mirroring have such files; an App that was not
        // granted the permission still gets a token, and the push of a commit
        // touching a workflow then fails with GitHub's own explanation.
        ...(access === "write" ? { optionalPermissions: { workflows: "write" as const } } : {}),
      },
    },
    logger,
  );
  if (!token.success) return token;
  return ok({ ...target, url: githubRemoteUrl(target), token: token.data.token });
}

/** Refusals of {@link openGitHubRemote} that no retry will change. */
export function isPermanentRemoteRefusal(error: AppError): boolean {
  return (
    error.code === "GITHUB_APP_NOT_CONFIGURED" ||
    error.code === "GITHUB_APP_NOT_INSTALLED" ||
    error.code === "GITHUB_APP_NOT_AUTHORIZED" ||
    error.code === "GITHUB_REPO_NOT_CANONICAL" ||
    error.code === "GITHUB_APP_PERMISSION_DENIED" ||
    error.code === "GITHUB_APP_KEY_INVALID"
  );
}

/** isomorphic-git auth callback that presents the remote's installation token. */
const auth = (remote: GitHubRemote) => () => ({
  username: "x-access-token",
  password: remote.token,
});

export interface GitHubRefs {
  /** Branch name → tip commit. */
  branches: Record<string, string>;
  /** Tag name → the oid the ref holds (the tag object, for an annotated tag). */
  tags: Record<string, string>;
}

/** The HTTP status carried by a git transport error, when it has one. */
function httpStatusOf(error: unknown): number | undefined {
  const data = (error as { code?: unknown; data?: { statusCode?: unknown } } | null)?.data;
  return (error as { code?: unknown } | null)?.code === "HttpError" &&
    typeof data?.statusCode === "number"
    ? data.statusCode
    : undefined;
}

/**
 * Maps a failed git HTTP exchange to an error that says whether to try again.
 * 401/403/404 are GitHub refusing this credential for this repository — the
 * App lost access, lacks the permission, or the repository is gone — and come
 * back as `GITHUB_ACCESS_DENIED`. Everything else is a 502.
 */
function remoteError(what: string, remote: GitHubRemote, error: Error): AppError {
  const status = httpStatusOf(error);
  if (status === 401 || status === 403 || status === 404) {
    return new AppError(
      `GitHub refused ${what} for ${remote.owner}/${remote.repo} (HTTP ${status}). Check that the GitHub App is installed on the repository with the Contents permission.`,
      "GITHUB_ACCESS_DENIED",
      status,
    );
  }
  return new ExternalServiceError("GitHub", `${what} failed: ${error.message}`, error);
}

/**
 * Lists a GitHub repository's branches and tags without fetching any objects.
 * An empty repository yields two empty maps.
 */
export async function listGitHubRefs(
  remote: GitHubRemote,
  logger: Logger,
): Promise<Result<GitHubRefs, AppError>> {
  const listed = await fromPromise(
    withTimeout(
      // `getRemoteInfo`, not `listServerRefs`: the latter mistakes an EMPTY
      // repository's advertisement for a protocol-v2 server and follows up with
      // a request GitHub rejects — and an empty repository is exactly what a
      // mirror's first push finds.
      git.getRemoteInfo({ http: httpClient(), url: remote.url, onAuth: auth(remote) }),
      REFS_TIMEOUT_MS,
      "listGitHubRefs: git.getRemoteInfo",
    ),
  );
  if (!listed.success) {
    logger.warn("Failed to list GitHub refs", {
      owner: remote.owner,
      repo: remote.repo,
      error: listed.error.message,
    });
    return err(remoteError("listing refs", remote, listed.error));
  }

  const advertised = listed.data.refs as
    | { heads?: RemoteRefTree; tags?: RemoteRefTree }
    | undefined;
  const tags: Record<string, string> = {};
  for (const [name, oid] of Object.entries(flattenRefTree(advertised?.tags))) {
    // `<tag>^{}` is the advertisement's peeled commit for an annotated tag, not
    // a ref of its own.
    if (!name.endsWith("^{}")) tags[name] = oid;
  }
  return ok({ branches: flattenRefTree(advertised?.heads), tags });
}

/**
 * Is `ancestor` reachable from `descendant` in this clone (or the same commit)?
 *
 * `false` means "not found by walking what this clone holds". In a shallow
 * clone that is not yet proof of divergence — the ancestor may lie past the
 * shallow boundary — so a caller acting on `false` must have cloned full
 * history first.
 */
export async function isAncestor(
  fs: NodeFS,
  dir: string,
  input: { ancestor: string; descendant: string },
): Promise<boolean> {
  if (input.ancestor === input.descendant) return true;
  const walked = await fromPromise(
    git.isDescendent({
      fs,
      dir,
      oid: input.descendant,
      ancestor: input.ancestor,
      depth: -1,
    }),
  );
  // A walk that throws ran into an object this clone does not have; that is
  // the same answer as not finding the ancestor.
  return walked.success && walked.data;
}

export type FastForwardPush =
  | { status: "pushed" }
  /**
   * - `not-fast-forward` — the remote ref is not an ancestor of the local one.
   * - `tag-exists` — the remote already has a tag by that name.
   * - `remote-rejected` — GitHub answered the push with a refusal of its own
   *   (a protected branch, or the ref moved after it was read).
   */
  | {
      status: "rejected";
      reason: "not-fast-forward" | "tag-exists" | "remote-rejected";
      detail: string;
    };

/**
 * Pushes one local ref to the same ref on GitHub, fast-forward only.
 *
 * Never forced: isomorphic-git refuses a non-descendant before any pack is
 * sent, and the push names the old oid it saw, so GitHub refuses it too if the
 * ref moved in between. A refusal is a normal outcome and comes back as
 * `rejected`; `err` is reserved for the push not having been judged at all.
 *
 * @param ref - A full ref name present in the clone: `refs/heads/<branch>` or
 *   `refs/tags/<tag>`
 */
export async function pushRefFastForward(
  fs: NodeFS,
  dir: string,
  remote: GitHubRemote,
  ref: string,
  logger: Logger,
): Promise<Result<FastForwardPush, AppError>> {
  const pushed = await fromPromise(
    withTimeout(
      git.push({
        fs,
        dir,
        http: httpClient(),
        url: remote.url,
        ref,
        remoteRef: ref,
        onAuth: auth(remote),
        force: false,
      }),
      PUSH_TIMEOUT_MS,
      `pushRefFastForward: git.push ${ref}`,
    ),
  );
  if (pushed.success) return ok({ status: "pushed" });

  const error = pushed.error as Error & {
    code?: string;
    data?: { reason?: string; prettyDetails?: string };
  };
  if (error.code === "PushRejectedError") {
    const reason = error.data?.reason === "tag-exists" ? "tag-exists" : "not-fast-forward";
    return ok({ status: "rejected", reason, detail: error.message });
  }
  if (error.code === "GitPushError") {
    return ok({
      status: "rejected",
      reason: "remote-rejected",
      detail: (error.data?.prettyDetails ?? error.message).trim(),
    });
  }
  logger.warn("Push to GitHub failed", {
    owner: remote.owner,
    repo: remote.repo,
    ref,
    error: error.message,
  });
  return err(remoteError(`pushing ${ref}`, remote, error));
}
