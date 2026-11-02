# Diagnosing MCP connections

How to tell, from Workers Logs alone, where a remote MCP connection stopped.
The flow has a browser half and a server half, and the two fail differently.

## The healthy sequence

One connection from a fresh client produces these lines, in order, usually
within a few seconds of each other. All are at `info`.

| Line | Emitted by | What it proves |
|---|---|---|
| `OAuth client registered` | `POST /oauth/register` | Discovery worked. The client found `/.well-known/oauth-protected-resource` and the authorization-server metadata, and registered itself. Once per client install, not per connection. |
| `MCP consent screen shown` | `GET /oauth/authorize` | The user reached the consent page signed in. Carries `clientId`, `clientName`, `userId`, `scope`. |
| `Authorization code issued` | `POST /oauth/authorize` | The user clicked Allow. Carries `codeId`. |
| `OAuth tokens issued` | `POST /oauth/token` | The client redeemed the code. Carries the same `codeId`. |
| `MCP client initialized` | `POST /mcp` | The client opened a session and said who it is (`clientName`, `clientVersion`, `protocolVersion`). |

A `codeId` is the first twelve hex digits of the code's hash. It is a join key
for the two lines above, nothing more.

## Where it stopped, and what that means

**Registered, but no consent screen.** The client never opened the browser,
or the user is not signed in and the login round trip did not return them to
`/oauth/authorize`. Check for the login redirect in the same request id.

**Consent shown, but no code issued.** The user did not click Allow, or the
POST was rejected. A rejection logs at `warn` (`Authorization rejected - …`)
with the reason; `MCP consent declined` at `info` is the Cancel button.

**Code issued, but no tokens issued.** Consent succeeded and delivery failed.
Two places to look:

- `CSP violation reported` at `warn`, with `effectiveDirective: "form-action"`
  and a `blockedUri` on the client's origin, means the browser refused to
  follow the post-consent redirect. This is the failure #353 and #355 fixed;
  if it recurs, a `form-action` directive has crept back onto the consent
  page.
- No CSP report and no `Token request rejected - …` warning means the client
  never called `/oauth/token`: it never received the redirect, or gave up.
  If the client did call and was refused, the warning names why (wrong
  client, PKCE mismatch, replay), with the same `codeId`.

Either way the sweep will confirm it: `Authorization codes expired unredeemed`
at `warn`, every five minutes, with a per-client count. A non-zero count on an
instance with real users is worth an alert.

**Tokens issued, but no `MCP client initialized`.** The client has a token
and has not used it yet, or its first request was refused by the auth
middleware (`Auth failed - …` at `warn`). The `/mcp` 401 always carries the
`WWW-Authenticate` challenge, so a well-behaved client re-authorizes on its
own.

**Initialized, but tools fail.** `MCP tool call failed` at `warn` carries the
tool name and the first line of the error the model was shown, which is the
REST API's own error. `MCP tool call rejected` is a call the endpoint itself
refused (unknown tool, bad params). A read-only grant failing on a write tool
reads `This OAuth grant is read-only…`; the fix is to disconnect and
re-authorize, requesting `mcp:write`.

## What the server cannot see

Anything the browser blocks without reporting, and anything that happens on
the client's side of the redirect. The CSP report endpoint closes the first
gap for policy violations. For the second, the only server-side evidence is
absence: a code that expired unredeemed.
