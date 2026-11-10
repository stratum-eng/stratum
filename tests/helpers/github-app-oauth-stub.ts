/**
 * A scripted GitHub for the app's user-to-server OAuth (#442), installed over
 * `globalThis.fetch`. It answers the five calls linking makes — the code
 * exchange, `GET /user`, `GET /user/installations`, `GET
 * /user/memberships/orgs`, and the token revocation — from what a test
 * says a person can reach on GitHub at that moment, and records every request
 * so a test can assert on what was (and was not) asked.
 *
 * It behaves like GitHub where the difference matters: a `code` is single-use,
 * a bad one is answered `200` with an `error` field, a revoked token stops
 * working, and a long installation list is paged with a `Link` header.
 */

export const STUB_CLIENT_ID = "Iv1.stubclientid";
export const STUB_CLIENT_SECRET = "stub-client-secret-do-not-leak";

/** What GitHub would say about one person when their token asks. */
export interface GitHubPersona {
  /** The GitHub user id the token belongs to. */
  id: number;
  /** What `GET /user/installations` lists for them. */
  installations: Array<{
    id: number;
    account: { id: number; login: string; type: "User" | "Organization" | "Enterprise" };
  }>;
  /** Org login → the membership GitHub reports. A login not named here is a 404. */
  memberships?: Record<
    string,
    { state: "active" | "pending"; role: "admin" | "member"; organizationId: number }
  >;
}

export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

export interface GitHubStub {
  /** Every request made through `fetch` while the stub was installed. */
  calls: RecordedCall[];
  /** Every user token the stub has minted, in order. */
  tokens: string[];
  /** Tokens the app asked GitHub to revoke. */
  revoked: string[];
  /** API paths (prefix match) that answer with this status instead. */
  outages: Map<string, number>;
  /** When set, the code exchange answers with this instead of minting a token. */
  exchangeAnswer?: { status: number; body: string };
  /** The person approves on GitHub: returns the `code` their redirect carries. */
  approve(persona: GitHubPersona): string;
  /** Requests whose URL path starts with `path`. */
  callsTo(path: string): RecordedCall[];
  /** Puts the real `fetch` back. */
  restore(): void;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * Replaces `globalThis.fetch` with the scripted GitHub.
 *
 * @param options - `pageSize` splits `GET /user/installations` into pages
 * @returns The stub's controls; call `restore()` when done
 */
export function stubGitHub(options: { pageSize?: number } = {}): GitHubStub {
  const original = globalThis.fetch;
  const pageSize = options.pageSize ?? 100;
  const codes = new Map<string, GitHubPersona>();
  const live = new Map<string, GitHubPersona>();
  let minted = 0;

  const stub: GitHubStub = {
    calls: [],
    tokens: [],
    revoked: [],
    outages: new Map(),
    approve(persona) {
      minted += 1;
      const code = `code${minted}x${persona.id}`;
      codes.set(code, persona);
      return code;
    },
    callsTo(path) {
      return stub.calls.filter((call) => new URL(call.url).pathname.startsWith(path));
    },
    restore() {
      globalThis.fetch = original;
    },
  };

  function exchange(body: string | null): Response {
    if (stub.exchangeAnswer) {
      return new Response(stub.exchangeAnswer.body, {
        status: stub.exchangeAnswer.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    const sent = JSON.parse(body ?? "{}") as Record<string, unknown>;
    if (sent.client_id !== STUB_CLIENT_ID || sent.client_secret !== STUB_CLIENT_SECRET) {
      return json({ error: "incorrect_client_credentials" });
    }
    const persona = typeof sent.code === "string" ? codes.get(sent.code) : undefined;
    if (!persona || typeof sent.code !== "string") return json({ error: "bad_verification_code" });
    codes.delete(sent.code);
    const token = `ghu_STUBUSERTOKEN${stub.tokens.length + 1}x${persona.id}`;
    stub.tokens.push(token);
    live.set(token, persona);
    return json({ access_token: token, token_type: "bearer", scope: "" });
  }

  function api(method: string, url: URL, authorization: string | null, body: string | null) {
    const revoke = /^\/applications\/([^/]+)\/token$/.exec(url.pathname);
    if (method === "DELETE" && revoke) {
      const expected = `Basic ${btoa(`${STUB_CLIENT_ID}:${STUB_CLIENT_SECRET}`)}`;
      if (authorization !== expected) return json({ message: "Bad credentials" }, 401);
      const sent = JSON.parse(body ?? "{}") as Record<string, unknown>;
      if (typeof sent.access_token !== "string" || !live.has(sent.access_token)) {
        return json({ message: "Not Found" }, 404);
      }
      live.delete(sent.access_token);
      stub.revoked.push(sent.access_token);
      return new Response(null, { status: 204 });
    }

    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const persona = live.get(token);
    if (!persona || method !== "GET") return json({ message: "Bad credentials" }, 401);

    for (const [prefix, status] of stub.outages) {
      if (url.pathname.startsWith(prefix)) return json({ message: "outage" }, status);
    }

    if (url.pathname === "/user") return json({ id: persona.id, login: `user${persona.id}` });

    if (url.pathname === "/user/installations") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * pageSize;
      const slice = persona.installations.slice(start, start + pageSize);
      const more = start + pageSize < persona.installations.length;
      return json(
        {
          total_count: persona.installations.length,
          installations: slice.map((inst) => ({
            id: inst.id,
            app_id: 1,
            target_type: inst.account.type,
            account: inst.account,
          })),
        },
        200,
        more
          ? { Link: `<https://api.github.com/user/installations?page=${page + 1}>; rel="next"` }
          : {},
      );
    }

    // The list form only. The per-organization form needs the app to hold
    // "Members: read", which the deployment guide does not grant, so code
    // that calls it falls through to "unexpected" below and fails its test.
    if (url.pathname === "/user/memberships/orgs") {
      const wanted = url.searchParams.get("state");
      const all = Object.entries(persona.memberships ?? {})
        .filter(([, membership]) => wanted === null || membership.state === wanted)
        .map(([login, membership]) => ({
          state: membership.state,
          role: membership.role,
          organization: { id: membership.organizationId, login },
        }));
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * pageSize;
      const more = start + pageSize < all.length;
      return json(
        all.slice(start, start + pageSize),
        200,
        more
          ? { Link: `<https://api.github.com/user/memberships/orgs?page=${page + 1}>; rel="next"` }
          : {},
      );
    }

    return json({ message: "unexpected" }, 599);
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const authorization = request.headers.get("authorization");
    const body = method === "GET" || method === "HEAD" ? null : await request.text();
    stub.calls.push({ method, url: request.url, authorization, body });

    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      return method === "POST" ? exchange(body) : json({ message: "unexpected" }, 599);
    }
    if (url.origin === "https://api.github.com") return api(method, url, authorization, body);
    return json({ message: "unexpected" }, 599);
  }) as typeof fetch;

  return stub;
}
