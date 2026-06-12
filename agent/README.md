# @stratum/agent

Reference agent for Stratum: proves the platform end-to-end for agent workflows.

```bash
export STRATUM_HOST=https://your-stratum-instance
export STRATUM_API_KEY=stratum_user_…
export ANTHROPIC_API_KEY=sk-ant-…

npx @stratum/agent \
  --repo @user/my-api \
  --objective "Fix the N+1 query in the users endpoint" \
  --model claude-sonnet-4-6
```

## What it does

1. Creates an agent identity (`POST /api/agents`) — all subsequent writes use the
   short-lived agent token, so provenance records the agent, not the user.
2. Forks a workspace from the target project.
3. Reads a bounded slice of the repository (≤30 files / 256 KB).
4. Asks Claude for the complete new contents of the files needed to accomplish
   the objective (strict JSON contract; unsafe paths rejected).
5. Commits to the workspace and opens a Change — which runs the project's
   evaluation policy (secret scan, diff checks, and any configured evaluators).

Exit code is `2` when the Change is created but evaluation fails, so CI wrappers
can distinguish "agent produced rejected work" from operational errors (`1`).

Human review and merge stay on the platform: the agent cannot approve or merge
its own Change.
