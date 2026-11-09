/**
 * Everything a job's container can reach (#415, ADR 012).
 *
 * The container starts with `enableInternet: false`. A hostname resolves only
 * if an intercept is registered for it, and an intercepted request arrives
 * HERE, in the Worker, as a `fetch()` on one of the two entrypoints below.
 * Nothing leaves the container that this file did not send.
 *
 * Two rules shape both handlers:
 *
 * 1. An intercept is matched on the TLS server name, but the URL the handler
 *    sees is built from the `Host` header — which the code in the container
 *    writes. So a handler never trusts that it was reached for "its" host: it
 *    checks the scheme and the exact hostname of the request itself.
 * 2. The upstream request is BUILT, never forwarded. The repository proxy
 *    takes nothing from the container's URL but which of two git endpoints it
 *    asked for, and it does not follow redirects: a credential goes to the one
 *    URL Stratum named and nowhere a response points.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { GIT_HOST } from "./config";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function refusal(status: number, message: string): Response {
  return new Response(`stratum-ci: ${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** The request's URL, if it is plain `https://<hostname>/…` on the default port. */
function httpsRequestUrl(request: Request): URL | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url;
}

export interface GitProxyProps {
  /** The repository's real smart-HTTP URL, from the signed dispatch. */
  upstream: string;
  /** `Basic …` for it. Read-only, short-lived, and never sent to the container. */
  authorization: string;
}

/** What a fetch needs from the client, and nothing that could carry state. */
const GIT_REQUEST_HEADERS = ["content-type", "accept", "git-protocol", "content-encoding"];
const GIT_RESPONSE_HEADERS = ["content-type", "cache-control"];

/**
 * Serve `https://git.stratum.internal/repo.git` as a read-only view of one
 * repository: the two requests a `git fetch` makes, and no others.
 */
export async function handleGitProxy(
  request: Request,
  props: GitProxyProps,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const url = httpsRequestUrl(request);
  if (url === null) return refusal(400, "only https requests are proxied");
  if (url.hostname !== GIT_HOST) return refusal(403, "this proxy serves one repository");

  let upstream: string;
  if (
    request.method === "GET" &&
    url.pathname === "/repo.git/info/refs" &&
    url.search === "?service=git-upload-pack"
  ) {
    upstream = `${props.upstream}/info/refs?service=git-upload-pack`;
  } else if (
    request.method === "POST" &&
    url.pathname === "/repo.git/git-upload-pack" &&
    url.search === ""
  ) {
    upstream = `${props.upstream}/git-upload-pack`;
  } else {
    // Including every push endpoint: the credential is read-only, and this is
    // the second reason a job cannot write to the repository.
    return refusal(403, "only fetching the repository is allowed");
  }

  const headers = new Headers();
  for (const name of GIT_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("Authorization", props.authorization);
  headers.set("User-Agent", "stratum-ci-executor");

  let response: Response;
  try {
    response = await fetchImpl(upstream, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : null,
      // Never "follow": the next hop would receive the Authorization header.
      redirect: "manual",
    });
  } catch {
    return refusal(502, "the repository could not be reached");
  }
  if (response.status >= 300 && response.status < 400) {
    return refusal(502, "the repository answered with a redirect, which is not followed");
  }

  const out = new Headers();
  for (const name of GIT_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: out });
}

export interface AllowlistProps {
  /** Exact hostnames. No globs: an entry is one host. */
  hosts: string[];
}

/** Headers that describe one connection, not the request; never forwarded. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
];

/**
 * Pass a request through to an allowlisted host, unchanged and uncredentialed.
 *
 * Redirects go back to the client as they are. If it follows one, the new
 * host is either on the allowlist — and arrives here again — or does not
 * resolve inside the container at all.
 */
export async function handleAllowedEgress(
  request: Request,
  props: AllowlistProps,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const url = httpsRequestUrl(request);
  if (url === null) return refusal(400, "only https requests are allowed");
  if (!props.hosts.includes(url.hostname)) {
    return refusal(403, `'${url.hostname}' is not on this job's network allowlist`);
  }

  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    return await fetchImpl(`https://${url.hostname}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: "manual",
    });
  } catch {
    return refusal(502, `'${url.hostname}' could not be reached`);
  }
}

/** The repository, as the container sees it. One instance per job, by props. */
export class GitProxy extends WorkerEntrypoint<unknown, GitProxyProps> {
  override fetch(request: Request): Promise<Response> {
    return handleGitProxy(request, this.ctx.props);
  }
}

/** The package registries and whatever else the job's allowlist names. */
export class EgressAllowlist extends WorkerEntrypoint<unknown, AllowlistProps> {
  override fetch(request: Request): Promise<Response> {
    return handleAllowedEgress(request, this.ctx.props);
  }
}
