/**
 * The two intercept handlers: the only ways out of a job's container.
 *
 * Every test here hands the handler a request as the CONTAINER would make it —
 * and the container is the adversary. An intercept is chosen by TLS server
 * name, but the URL the handler sees comes from the Host header, which the
 * code in the container writes.
 */
import { describe, expect, it, vi } from "vitest";
import { handleAllowedEgress, handleCredentialedEgress, handleGitProxy } from "../src/egress";
import { DEPLOY_SECRET, DEPLOY_TOKEN, REPO_PASSWORD, REPO_URL } from "./helpers/fixtures";

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

describe("the deploy credential intercept", () => {
  const CREDENTIAL = { host: "api.cloudflare.com", secret: DEPLOY_SECRET };
  const API = "https://api.cloudflare.com/client/v4/accounts/acct123/workers/scripts/app?x=1";

  it("sends the request to its one host with the executor's credential attached", async () => {
    const fetchImpl = upstream(new Response('{"success":true}', { status: 200 }));
    const response = await handleCredentialedEgress(
      new Request(API, { method: "PUT", body: "module", headers: { "content-type": "text/x" } }),
      CREDENTIAL,
      DEPLOY_TOKEN,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(API);
    expect(init?.method).toBe("PUT");
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${DEPLOY_TOKEN}`);
    expect(headers.get("content-type")).toBe("text/x");
  });

  it("refuses a wrong host, whatever intercept it arrived through, without contacting anything", async () => {
    const fetchImpl = upstream();
    for (const url of [
      "https://evil.example.com/client/v4/user",
      "https://api.cloudflare.com.evil.example.com/client/v4/user",
      "https://xapi.cloudflare.com/client/v4/user",
    ]) {
      const response = await handleCredentialedEgress(
        new Request(url),
        CREDENTIAL,
        DEPLOY_TOKEN,
        fetchImpl,
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(DEPLOY_TOKEN);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a request that is not https, or on a non-default port", async () => {
    const fetchImpl = upstream();
    for (const url of [
      "http://api.cloudflare.com/client/v4/user",
      "https://api.cloudflare.com:8443/client/v4/user",
    ]) {
      const response = await handleCredentialedEgress(
        new Request(url),
        CREDENTIAL,
        DEPLOY_TOKEN,
        fetchImpl,
      );
      expect(response.status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not follow a redirect, and does not hand it to the container either", async () => {
    const fetchImpl = upstream(
      new Response(null, { status: 307, headers: { Location: "https://evil.example.com/steal" } }),
    );
    const response = await handleCredentialedEgress(
      new Request(API),
      CREDENTIAL,
      DEPLOY_TOKEN,
      fetchImpl,
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toContain("redirect");
    // Exactly one request left the Worker: the redirect target never got one.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("replaces whatever credential the container sent, in every header that carries one", async () => {
    const fetchImpl = upstream();
    await handleCredentialedEgress(
      new Request(API, {
        headers: {
          Authorization: "Bearer attached-by-the-stratum-executor",
          Cookie: "session=1",
          "X-Auth-Key": "legacy-key",
          "X-Auth-Email": "someone@example.com",
          "X-Custom": "kept",
        },
      }),
      CREDENTIAL,
      DEPLOY_TOKEN,
      fetchImpl,
    );

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${DEPLOY_TOKEN}`);
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("X-Auth-Key")).toBeNull();
    expect(headers.get("X-Auth-Email")).toBeNull();
    expect(headers.get("X-Custom")).toBe("kept");
  });

  it("builds the upstream URL from its own host: the container chooses only path and query", async () => {
    const fetchImpl = upstream();
    await handleCredentialedEgress(
      new Request("https://api.cloudflare.com//evil.example.com/x?y=https://evil.example.com"),
      CREDENTIAL,
      DEPLOY_TOKEN,
      fetchImpl,
    );
    const target = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(target.hostname).toBe("api.cloudflare.com");
    expect(target.protocol).toBe("https:");
  });

  it("answers 503, sending nothing, when the secret is not set", async () => {
    const fetchImpl = upstream();
    for (const token of [undefined, ""]) {
      const response = await handleCredentialedEgress(
        new Request(API),
        CREDENTIAL,
        token,
        fetchImpl,
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toContain(DEPLOY_SECRET);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never returns the credential, or a cookie, to the container", async () => {
    const fetchImpl = upstream(
      new Response("ok", { status: 200, headers: { "Set-Cookie": "a=b", "X-Request-Id": "r1" } }),
    );
    const response = await handleCredentialedEgress(
      new Request(API),
      CREDENTIAL,
      DEPLOY_TOKEN,
      fetchImpl,
    );
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("X-Request-Id")).toBe("r1");
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(DEPLOY_TOKEN);
  });

  it("answers 502 without detail when the host cannot be reached", async () => {
    const response = await handleCredentialedEgress(
      new Request(API),
      CREDENTIAL,
      DEPLOY_TOKEN,
      vi.fn(async () => {
        throw new Error(`connect failed with ${DEPLOY_TOKEN}`);
      }),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(DEPLOY_TOKEN);
  });
});
