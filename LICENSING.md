# Licensing

Copyright © 2026 Jordan Lamoreaux.

Stratum is free software. It is not, however, under one license: the server is
copyleft and the client packages are permissive, on purpose. This file is the
authoritative account of which is which and why.

## What is under which license

| Path | License | SPDX |
|---|---|---|
| Everything not listed below — `src/`, `migrations/`, `scripts/`, `tests/`, `docs/`, `website/`, `wrangler.toml` | GNU Affero General Public License v3.0 or later | [`AGPL-3.0-or-later`](LICENSE) |
| [`cli/`](cli) — the `@stratum-eng/cli` package | Apache License 2.0 | [`Apache-2.0`](cli/LICENSE) |
| [`agent/`](agent) — the `@stratum-eng/agent` reference agent | Apache License 2.0 | [`Apache-2.0`](agent/LICENSE) |
| `website/public/.well-known/agent-skills/` — the published agent skill files | MIT License | `MIT` |

The split follows the boundary that matters to a user: what you *run as a
service* is copyleft, and what you *run inside your own pipeline* is not.

The clients are permissive because a CLI you invoke from CI, or a reference
agent you fork into your own automation, should never raise a question about
the license of the code it operates on. It does not — talking to a Stratum
server over HTTP is not derivation under any reading — but a permissive license
means nobody has to reason about it. Apache-2.0 rather than MIT for the express
patent grant (§3) and the trademark reservation (§6), neither of which MIT
provides. The trade: Apache-2.0 cannot be combined into a GPLv2-**only**
project, where MIT can.

The server is copyleft because it is the part someone could take, improve
privately, and run as a competing service while contributing nothing back.

The agent skill files stay MIT because they exist to be fetched and pasted into
other people's agents. They contain no implementation — they are instructions
for calling a public API — and copyleft on a discovery artifact would discourage
exactly the copying they are published for. Their `license:` frontmatter and the
generated `index.json` say MIT on purpose.

## If you run Stratum

**Running an unmodified Stratum obliges you to nothing.** Not a notice, not a
publication, not a mail to anyone. Running the software is not conveying it
(AGPL §0, §2), and §13 attaches to *modified* versions.

**If you modify Stratum and other people interact with your instance over a
network, AGPL §13 applies to you.** You must prominently offer those users the
Corresponding Source of the version you are running, under this same license.
"Other people" includes your own employees on your own network.

Stratum makes that one edit, not a project:

```ts
// src/version.ts
export const STRATUM_SOURCE_URL = "https://github.com/stratum-eng/stratum";
```

Point it at the repository holding your changes and redeploy. Stratum then
carries the offer on every surface it serves: the footer of every page, and, for
callers who never receive HTML at all — the REST API, `/mcp`, anything answering
in JSON — a `Link: …; rel="license"` and an `X-Source-Code` header on every
response. §13 reaches everyone interacting with the program over the network,
not only the people looking at markup, so an agent driving Stratum entirely over
`/mcp` is offered the source too.

That is the source-offer mechanism, and it is the part Stratum can do for you.
It is not a substitute for the rest of the license: if you modify Stratum you
still carry §5's obligations to mark your changes and keep the legal notices
intact. Publishing your fork on any host your users can reach is what discharges
the offer itself; there is no requirement to contribute anything upstream, and
no requirement that your *users'* code, the repositories Stratum stores, or
anything you build with it be licensed at all. The AGPL covers Stratum, and
nothing that passes through it.

## What this does not restrict

- **Your code.** Repositories hosted in Stratum, changes evaluated by it, and
  policies written for it are yours, under whatever license you choose.
- **Commercial use.** You may run Stratum commercially, including as a paid
  service, under the AGPL. §13 is a source-availability condition, not a
  non-compete.
- **Your agents and integrations.** Anything that speaks to the REST API, the
  CLI, or the `/mcp` endpoint is a separate work.

## Commercial licensing

If the AGPL does not work for you — you want to embed Stratum in a proprietary
product, or run a modified instance without offering its source — a commercial
license is available. Open a
[discussion](https://github.com/stratum-eng/stratum/discussions) or contact the
maintainer, [@jlamoreaux](https://github.com/jlamoreaux).

This is possible only because contributors grant the rights described in
[`CLA.md`](CLA.md). Without that, no one, the maintainer included, could offer
terms other than the AGPL.

## History: this project was MIT

Stratum was MIT-licensed from its first commit through **v0.2.0**. That does not
change and cannot be revoked: every release up to and including v0.2.0 remains
available under the MIT License, and anyone holding a copy of that code keeps
their MIT rights in it forever, including the right to fork it and continue
under MIT.

The AGPL and Apache-2.0 terms above apply from the relicensing commit forward
(v0.3.0 onward). The relicense was possible because the maintainer holds
copyright in all of it: the only non-maintainer contributions merged before the
change were four automated docstring pull requests from CodeRabbit.

The change was made deliberately, while the project was small enough that the
decision affects nobody's existing deployment, rather than later, when it would
have.

## Third-party code

Stratum's runtime dependencies are MIT, ISC, BSD, and Apache-2.0, all of which
combine into an AGPL-licensed work without restriction. Their license texts
travel with them in `node_modules`; none are vendored into this repository.
