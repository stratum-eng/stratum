# Stratum

> The governance layer for AI-written code — the control plane that decides what
> agent output is allowed to merge, wherever your code lives.

Humans and AI agents are both first-class citizens, with different powers by design.

- **Evaluation-gated merges** — policy-as-code (`.stratum/policy.yaml`) blocks merges on
  secret scans, diff rules, sandboxed tests, external CI, and LLM review. A malformed
  policy fails closed.
- **Provenance & cost tracking** — every merged commit records which agent, model, and
  prompt produced it, its evaluation score, and what it cost.
- **Agent identities with a hard invariant** — agents authenticate as themselves and can
  never approve work. Approvals are a human gate on every surface: REST, CLI, and MCP.
- **Any agent, any editor** — REST API, CLI, and MCP server all speak to the same gate.
- **Two ways to run it** — as a layer over GitHub, or as a standalone forge with Git
  hosting on Cloudflare Artifacts, workspace forking, issues, and orgs.
- **Self-hostable and MIT-licensed** — runs on your own Cloudflare account.

## Documentation

- [Getting started](https://docs.usestratum.dev/guides/getting-started/)
- [Importing from GitHub](https://docs.usestratum.dev/guides/importing/)
- [Troubleshooting](https://docs.usestratum.dev/guides/troubleshooting/)
- [FAQ](https://docs.usestratum.dev/guides/faq/)
- [API reference](https://docs.usestratum.dev/reference/endpoints/)
- [OpenAPI specification](https://docs.usestratum.dev/openapi.yml)

## For language models

- [/llms.txt](https://docs.usestratum.dev/llms.txt) — index of documentation sets
- [/llms-full.txt](https://docs.usestratum.dev/llms-full.txt) — complete corpus
