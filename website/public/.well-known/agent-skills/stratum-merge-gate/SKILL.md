---
name: stratum-merge-gate
description: Get a change through Stratum's evaluation gates and merged, and read the verdict when a gate blocks it.
license: MIT
homepage: https://docs.usestratum.dev/guides/getting-started/
---

# Getting a change through the Stratum merge gate

Stratum is the control plane that decides what agent output is allowed to merge.
Every contribution — human or agent — takes the same path:

```text
workspace  →  commit  →  change (evaluation runs)  →  human review  →  merge
```

You, as an agent, can do everything except the review step.

## 1. Read the policy before you write code

Merge gates are policy-as-code in `.stratum/policy.yaml` at the repository root.
When that file is absent Stratum falls back to `stratum.config.json`, and with
neither it applies the built-in default policy. Read whichever applies first: it
tells you what will block you.

```bash
curl -H "Authorization: Bearer $STRATUM_API_KEY" \
  "https://app.usestratum.dev/api/projects/@you/my-project/files/.stratum/policy.yaml"
```

A malformed policy **fails closed** — the gate blocks rather than falling back to
defaults. If you edit the policy, validate it in the same change.

## 2. Fork a workspace and commit

A workspace is an isolated fork of the project, with its own git remote.

```bash
stratum workspace create @you/my-project --name fix-n-plus-one
stratum commit --project @you/my-project --workspace fix-n-plus-one -m "Fix N+1 query"
```

## 3. Create the change — this runs the gates synchronously

```bash
stratum change create --project @you/my-project --workspace fix-n-plus-one
```

The response carries each evaluator's verdict. Do not poll; the evaluation is
already done when the call returns.

## 4. Interpret the verdict

| Evaluator | Why it blocked you | What to do |
|---|---|---|
| `secret_scan` | A credential is in the diff. Always on, cannot be disabled. | Remove the credential and rewrite the commit. Never re-submit the same blob. |
| `diff` | Exceeded `maxFiles`/`maxLines`, or matched a `forbiddenPattern`. | Split the change, or remove the offending pattern (e.g. a stray `console.log(`). |
| `webhook` | The project's external CI returned a failure. | Read the returned detail; fix the underlying build or test. |
| `sandbox` | `command` (usually `npm test`) exited non-zero. | Fix the failing tests. This evaluator fails closed when the Sandboxes binding is absent. |
| `llm` | The AI reviewer scored the diff below `threshold`. It can also fail closed with no review at all — an unusable provider configuration in the policy, or an exhausted allowance on an instance with entitlement enforcement enabled (a metered instance that is only observing admits instead). | Read the reviewer's rationale on the change and address it substantively. A fail-closed reason names its own cause; that one is not fixed by resubmitting. |

## 5. Merge

```bash
stratum change merge chg_xxxxx
```

Merges are squash merges, serialized per project through a Durable Object merge
queue. A merge is rejected when:

- a `requiredEvaluators` entry is failing,
- approvals are short of `requiredApprovals`,
- `409 STALE_BASE` — the recorded base is behind project HEAD and the policy sets
  `requireFreshBase`,
- `409 STALE_WORKSPACE` — the workspace advanced after evaluation. This one is
  unconditional: you can never merge commits the evaluators did not see.

Re-run step 3 against the current base and retry.

## The invariant you cannot route around

**Agent tokens can never approve a change** — not their own, not another
agent's. This holds on every surface (REST, CLI, MCP) and no configuration
relaxes it. If a change needs an approval, stop and hand it to a human. Do not
attempt to approve with a user token you were given for another purpose.

Force-merge (`?force=true`) is deny-by-default and is rejected unless the policy
explicitly sets `allowForce: true`. Treat it as a human break-glass action, not
an agent affordance.

## Reference

- Change flow and policy reference: https://docs.usestratum.dev/guides/getting-started/
- Error codes: https://docs.usestratum.dev/reference/errors/
- OpenAPI contract: https://docs.usestratum.dev/openapi.yml
