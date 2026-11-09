/**
 * The two intercept handlers: the only ways out of a job's container.
 *
 * Every test here hands the handler a request as the CONTAINER would make it —
 * and the container is the adversary. An intercept is chosen by TLS server
 * name, but the URL the handler sees comes from the Host header, which the
 * code in the container writes.
 */
import { describe, expect, it, vi } from "vitest";
import { handleAllowedEgress, handleGitProxy } from "../src/egress";
import { REPO_PASSWORD, REPO_URL } from "./helpers/fixtures";

const AUTHORIZATION = `Basic ${btoa(`x:${REPO_PASSWORD}`)}`;
const PROPS = { upstream: REPO_URL, authorization: AUTHORIZATION };
const REFS = "https://git.stratum.internal/repo.git/info/refs?service=git-upload-pack";
const PACK = "https://git.stratum.internal/repo.git/git-upload-pack";

function upstream(response: Response = new Response("refs", { status: 200 })) {
  return vi.fn(async (_input: string, _init: RequestInit) => response);
}

describe("the repository proxy", () => {
  it("serves the ref advertisement from the dispatch's repository, with the credential", async () => {
    const fetchImpl = upstream();
    const response = await handleGitProxy(new Request(REFS), PROPS, fetchImpl);

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${REPO_URL}/info/refs?service=git-upload-pack`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(AUTHORIZATION);
    expect(init?.method).toBe("GET");
  });

  it("serves the pack request, body and git headers included", async () => {
    const fetchImpl = upstream();
    await handleGitProxy(
      new Request(PACK, {
        method: "POST",
        body: "0032want aaaa\n",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
        },
      }),
      PROPS,
      fetchImpl,
    );

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${REPO_URL}/git-upload-pack`);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Git-Protocol")).toBe("version=2");
    expect(headers.get("Content-Type")).toBe("application/x-git-upload-pack-request");
    expect(await new Response(init?.body).text()).toBe("0032want aaaa\n");
  });

  it("refuses a request whose Host is not the proxy's, without contacting anything", async () => {
    const fetchImpl = upstream();
    // Reached through the intercept for git.stratum.internal (by SNI), but
    // asking, by Host, for somewhere else.
    for (const url of [
      "https://attacker.example.com/repo.git/info/refs?service=git-upload-pack",
      "https://git.stratum.internal.attacker.example.com/repo.git/info/refs?service=git-upload-pack",
      "https://acct.artifacts.cloudflare.net/git/ns/other.git/info/refs?service=git-upload-pack",
    ]) {
      const response = await handleGitProxy(new Request(url), PROPS, fetchImpl);
      expect(response.status).toBe(403);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a request that is not https", async () => {
    const fetchImpl = upstream();
    const response = await handleGitProxy(
      new Request("http://git.stratum.internal/repo.git/info/refs?service=git-upload-pack"),
      PROPS,
      fetchImpl,
    );
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a non-default port", async () => {
    // (A URL carrying credentials cannot reach a handler at all: the platform
    // refuses to construct a Request from one.)
    const fetchImpl = upstream();
    const url = "https://git.stratum.internal:8443/repo.git/info/refs?service=git-upload-pack";
    expect((await handleGitProxy(new Request(url), PROPS, fetchImpl)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not follow a redirect, and does not hand it to the container either", async () => {
    const fetchImpl = upstream(
      new Response(null, { status: 302, headers: { Location: "https://attacker.example.com/x" } }),
    );
    const response = await handleGitProxy(new Request(REFS), PROPS, fetchImpl);

    expect(response.status).toBe(502);
    expect(response.headers.get("Location")).toBeNull();
    // One request, sent with redirects off: the credential went to one URL.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("serves nothing but the two requests a fetch makes", async () => {
    const fetchImpl = upstream();
    const refused: Array<[string, string]> = [
      ["GET", "https://git.stratum.internal/repo.git/info/refs?service=git-receive-pack"],
      ["POST", "https://git.stratum.internal/repo.git/git-receive-pack"],
      ["GET", "https://git.stratum.internal/repo.git/info/refs"],
      ["GET", "https://git.stratum.internal/repo.git/info/refs?service=git-upload-pack&x=1"],
      ["GET", "https://git.stratum.internal/other.git/info/refs?service=git-upload-pack"],
      [
        "GET",
        "https://git.stratum.internal/repo.git/../other.git/info/refs?service=git-upload-pack",
      ],
      ["GET", "https://git.stratum.internal/repo.git/HEAD"],
      ["POST", "https://git.stratum.internal/repo.git/info/refs?service=git-upload-pack"],
      ["GET", "https://git.stratum.internal/repo.git/git-upload-pack"],
      ["DELETE", "https://git.stratum.internal/repo.git/git-upload-pack"],
      ["POST", "https://git.stratum.internal/repo.git/git-upload-pack?x=1"],
    ];
    for (const [method, url] of refused) {
      const response = await handleGitProxy(new Request(url, { method }), PROPS, fetchImpl);
      expect(response.status, `${method} ${url}`).toBe(403);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds the upstream request itself: nothing the container sent chooses where it goes", async () => {
    const fetchImpl = upstream();
    await handleGitProxy(
      new Request(REFS, {
        headers: {
          Authorization: "Basic Zm9yZ2VkOmZvcmdlZA==",
          Cookie: "session=stolen",
          "X-Forwarded-Host": "attacker.example.com",
        },
      }),
      PROPS,
      fetchImpl,
    );

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url?.startsWith(`${REPO_URL}/`)).toBe(true);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(AUTHORIZATION);
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("X-Forwarded-Host")).toBeNull();
  });

  it("returns nothing of the upstream's but the body and its content type", async () => {
    const fetchImpl = upstream(
      new Response("refs", {
        status: 200,
        headers: {
          "Content-Type": "application/x-git-upload-pack-advertisement",
          "Set-Cookie": "upstream=1",
          "WWW-Authenticate": 'Basic realm="x"',
        },
      }),
    );
    const response = await handleGitProxy(new Request(REFS), PROPS, fetchImpl);

    expect(response.headers.get("Content-Type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.text()).toBe("refs");
  });

  it("answers 502 without detail when the repository cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed for ${AUTHORIZATION}`);
    });
    const response = await handleGitProxy(new Request(REFS), PROPS, fetchImpl);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(REPO_PASSWORD);
  });
});

describe("the allowlist", () => {
  const HOSTS = { hosts: ["registry.npmjs.org", "nodejs.org"] };

  it("passes a request to an allowed host through, with no credential added", async () => {
    const fetchImpl = upstream(new Response("{}", { status: 200 }));
    const response = await handleAllowedEgress(
      new Request("https://registry.npmjs.org/left-pad?write=true", {
        headers: { Accept: "application/json" },
      }),
      HOSTS,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://registry.npmjs.org/left-pad?write=true");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Authorization")).toBeNull();
    expect(init?.redirect).toBe("manual");
  });

  it("refuses a host that is not on the list, whatever intercept it arrived through", async () => {
    const fetchImpl = upstream();
    for (const url of [
      "https://attacker.example.com/exfil",
      "https://registry.npmjs.org.attacker.example.com/",
      "https://sub.registry.npmjs.org/",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect((await handleAllowedEgress(new Request(url), HOSTS, fetchImpl)).status).toBe(403);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses http and other ports", async () => {
    const fetchImpl = upstream();
    for (const url of [
      "http://registry.npmjs.org/left-pad",
      "https://registry.npmjs.org:8443/left-pad",
    ]) {
      expect((await handleAllowedEgress(new Request(url), HOSTS, fetchImpl)).status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a redirect to the client instead of following it", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example.com/tarball" },
    });
    const fetchImpl = upstream(redirect);
    const response = await handleAllowedEgress(
      new Request("https://nodejs.org/dist/latest"),
      HOSTS,
      fetchImpl,
    );

    // The container may follow it — and lands back here, where the new host
    // is checked like any other.
    expect(response.status).toBe(302);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses everything when the list is empty", async () => {
    const fetchImpl = upstream();
    const response = await handleAllowedEgress(
      new Request("https://git.stratum.internal/repo.git/info/refs?service=git-upload-pack"),
      { hosts: [] },
      fetchImpl,
    );
    expect(response.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards a request body", async () => {
    const fetchImpl = upstream();
    await handleAllowedEgress(
      new Request("https://registry.npmjs.org/-/npm/v1/security/audits", {
        method: "POST",
        body: '{"a":1}',
      }),
      HOSTS,
      fetchImpl,
    );
    expect(await new Response(fetchImpl.mock.calls[0]?.[1]?.body).text()).toBe('{"a":1}');
  });
});
