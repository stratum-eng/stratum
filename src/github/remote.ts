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
 * - {@link fetchGitHubBranch} — one branch's commits, into a clone the caller
 *   holds;
 * - {@link isAncestor} — the fast-forward test, on a clone the caller holds;
 * - {@link pushRefFastForward} — push one ref, never forced, with the refusal
 *   classified;
 * - {@link fetchPullRequestHead} — read one pull request's commits from the
 *   repository itself, bounded in bytes (#420).
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

/**
 * Resolves the credential for working with pull requests on `target` (#420),
 * narrowed to that one repository and to what the purpose needs:
 *
 * - `import` — read the pull request and fetch its commits: `contents: read`
 *   and `pull_requests: read`. Nothing can be written with it.
 * - `settle` — comment on and close a pull request whose change merged:
 *   `pull_requests: write` and nothing else. It cannot push. Like a mirror
 *   push, it also requires the project to be the repository's canonical
 *   target.
 *
 * The Pull requests permission is required, not optional: a token without it
 * cannot do either job, and failing here names the missing permission
 * (`GITHUB_APP_PERMISSION_DENIED`) instead of failing later with a bare 403.
 */
export async function openGitHubPullRequests(
  env: GitHubAuthEnv,
  project: ProjectEntry,
  target: GitHubRepoRef,
  purpose: "import" | "settle",
  logger: Logger,
): Promise<Result<GitHubRemote, AppError>> {
  const token = await resolveGitHubToken(
    env,
    {
      owner: target.owner,
      repo: target.repo,
      principal: projectPrincipal(project),
      ...(purpose === "settle" ? { project } : {}),
      repoScope: {
        permissions:
          purpose === "import"
            ? { contents: "read", pull_requests: "read" }
            : { pull_requests: "write" },
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
 * Bounds a shallow branch fetch. The same 30s a request-path clone gets: a
 * person is waiting on it, and a shallow window of a healthy repository
 * arrives in a few seconds.
 */
const FETCH_TIMEOUT_MS = 30_000;

/** The remote-tracking namespace {@link fetchGitHubBranch} writes under. */
export const GITHUB_TRACKING_REMOTE = "github";

/**
 * Fetches one branch of a GitHub repository into a clone the caller already
 * holds, without touching any local branch.
 *
 * The fetched tip lands under `refs/remotes/github/<branch>` and is returned;
 * the clone's own branches, and whatever remote it was cloned from, are left
 * exactly as they were. Deciding what the commits mean — a fast-forward, a
 * divergence, nothing new — is the caller's job, as is moving any ref.
 *
 * The clone's own tip is offered as a `have`, so when GitHub already knows
 * that commit (a mirror, in the normal case) only what lies past it is sent.
 *
 * @param opts.depth - Shallow window, in commits from the tip. Omit for the
 *   branch's whole history — and pass a `timeoutMs` to match.
 * @param opts.timeoutMs - Overrides the request-path default of 30s.
 * @returns The branch's tip on GitHub at the moment of the fetch
 */
export async function fetchGitHubBranch(
  fs: NodeFS,
  dir: string,
  remote: GitHubRemote,
  branch: string,
  opts: { depth?: number; timeoutMs?: number },
  logger: Logger,
): Promise<Result<{ tip: string }, AppError>> {
  // isomorphic-git will not record a fetched tip for a remote it has no
  // refspec for, even when the URL is passed explicitly. Only the refspec is
  // written — into this request's in-memory clone — never the URL or a token.
  const configured = await fromPromise(
    git.setConfig({
      fs,
      dir,
      path: `remote.${GITHUB_TRACKING_REMOTE}.fetch`,
      value: `+refs/heads/*:refs/remotes/${GITHUB_TRACKING_REMOTE}/*`,
    }),
  );
  if (!configured.success) {
    return err(remoteError(`preparing to fetch ${branch}`, remote, configured.error));
  }

  const fetched = await fromPromise(
    withTimeout(
      git.fetch({
        fs,
        http: httpClient(),
        dir,
        url: remote.url,
        remote: GITHUB_TRACKING_REMOTE,
        ref: branch,
        singleBranch: true,
        tags: false,
        // A server may reject `deepen 0`, so a nonsensical depth is floored
        // rather than forwarded.
        ...(opts.depth !== undefined ? { depth: Math.max(1, opts.depth) } : {}),
        onAuth: auth(remote),
      }),
      opts.timeoutMs ?? FETCH_TIMEOUT_MS,
      `fetchGitHubBranch: git.fetch ${branch}`,
    ),
  );
  if (!fetched.success) {
    logger.warn("Failed to fetch a branch from GitHub", {
      owner: remote.owner,
      repo: remote.repo,
      branch,
      error: fetched.error.message,
    });
    return err(remoteError(`fetching ${branch}`, remote, fetched.error));
  }
  const tip = fetched.data.fetchHead;
  if (typeof tip !== "string" || tip.length === 0) {
    // An empty repository answers the handshake with no refs at all, and
    // isomorphic-git reports that as a fetch of nothing rather than an error.
    return err(
      new AppError(
        `${remote.owner}/${remote.repo} has no branch '${branch}' to fetch`,
        "GITHUB_BRANCH_NOT_FOUND",
        409,
      ),
    );
  }
  return ok({ tip });
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

/** Thrown inside the response stream when a fetch passes its byte limit. */
class FetchLimitExceeded extends Error {
  constructor(readonly limitBytes: number) {
    super(`fetch exceeded ${limitBytes} bytes`);
    this.name = "FetchLimitExceeded";
  }
}

/**
 * An HTTP client that stops reading a response once `maxBytes` of it have
 * arrived. isomorphic-git has no size limit of its own, and the pack a fetch
 * downloads is chosen by whoever wrote the commits being fetched.
 */
function cappedHttpClient(maxBytes: number): {
  client: ReturnType<typeof createHttpClient>;
  exceeded: () => boolean;
} {
  const base = createHttpClient();
  let total = 0;
  let exceeded = false;
  return {
    exceeded: () => exceeded,
    client: {
      async request(args) {
        const response = await base.request(args);
        const body = response.body;
        async function* capped(): AsyncIterableIterator<Uint8Array> {
          for await (const chunk of body) {
            total += chunk.byteLength;
            if (total > maxBytes) {
              exceeded = true;
              throw new FetchLimitExceeded(maxBytes);
            }
            yield chunk;
          }
        }
        return { ...response, body: capped() };
      },
    },
  };
}

/** How long one pull request fetch may take. The request waits on it. */
const PULL_FETCH_TIMEOUT_MS = 60_000;

/** Name of the throwaway remote a pull request is fetched through. */
const PULL_REMOTE = "github-pull";

/**
 * Fetches the head of pull request `prNumber` into an existing clone and
 * returns its commit id.
 *
 * GitHub publishes every pull request's head on the BASE repository as
 * `refs/pull/<n>/head`, forks included. So this reads the mirror repository
 * with the mirror's own narrowed token and never contacts the fork: the fork's
 * owner chooses the bytes, but not the host, the URL or the credential.
 *
 * Bounded three ways: `depth` commits of history, `maxBytes` of response, and a
 * timeout. The clone's own branch is offered as what it already has, so only
 * objects the pull request adds are sent.
 *
 * @returns The head commit id; `PR_FETCH_TOO_LARGE` (422) when the response
 *   passed `maxBytes`; `PR_HEAD_UNAVAILABLE` (409) when GitHub does not
 *   advertise the ref
 */
export async function fetchPullRequestHead(
  fs: NodeFS,
  dir: string,
  remote: GitHubRemote,
  prNumber: number,
  limits: { depth: number; maxBytes: number },
  logger: Logger,
): Promise<Result<string, AppError>> {
  const capped = cappedHttpClient(limits.maxBytes);
  const fetched = await fromPromise(
    (async () => {
      // A named remote, because isomorphic-git refuses to finish a fetch for a
      // remote with no refspec configured. Nothing matches the refspec this
      // adds, so no local ref is written: the commits arrive, and the caller
      // is handed the id.
      await git.addRemote({ fs, dir, remote: PULL_REMOTE, url: remote.url, force: true });
      return withTimeout(
        git.fetch({
          fs,
          dir,
          http: capped.client,
          remote: PULL_REMOTE,
          url: remote.url,
          remoteRef: `refs/pull/${prNumber}/head`,
          singleBranch: true,
          depth: limits.depth,
          tags: false,
          onAuth: auth(remote),
        }),
        PULL_FETCH_TIMEOUT_MS,
        `fetchPullRequestHead: git.fetch refs/pull/${prNumber}/head`,
      );
    })(),
  );
  if (capped.exceeded()) {
    return err(
      new AppError(
        `The pull request's commits are larger than the ${Math.floor(limits.maxBytes / (1024 * 1024))} MB that can be brought in`,
        "PR_FETCH_TOO_LARGE",
        422,
      ),
    );
  }
  if (!fetched.success) {
    const code = (fetched.error as { code?: unknown }).code;
    if (code === "NotFoundError") {
      return err(
        new AppError(
          `GitHub does not have refs/pull/${prNumber}/head on ${remote.owner}/${remote.repo}`,
          "PR_HEAD_UNAVAILABLE",
          409,
        ),
      );
    }
    logger.warn("Failed to fetch pull request head", {
      owner: remote.owner,
      repo: remote.repo,
      prNumber,
      error: fetched.error.message,
    });
    return err(remoteError(`fetching pull request #${prNumber}`, remote, fetched.error));
  }
  const head = fetched.data.fetchHead;
  if (typeof head !== "string") {
    return err(
      new AppError(
        `GitHub does not have refs/pull/${prNumber}/head on ${remote.owner}/${remote.repo}`,
        "PR_HEAD_UNAVAILABLE",
        409,
      ),
    );
  }
  return ok(head);
}
