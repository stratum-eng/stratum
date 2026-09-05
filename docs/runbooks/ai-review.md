# AI code review (PR-Agent via Cloudflare AI Gateway)

`.github/workflows/pr-agent.yml` runs [PR-Agent](https://github.com/qodo-ai/pr-agent) on every
non-draft, non-fork PR (opened / reopened / ready_for_review). It posts a review comment with
findings; it never blocks a merge.

All LLM traffic goes through **Cloudflare AI Gateway's OpenAI-compatible `/compat` endpoint**
with unified billing: one Cloudflare API token, one Cloudflare bill, no third-party model
accounts. Every request (tokens, cost, latency, errors) is visible in the gateway's analytics,
and gateway-level caching/rate limits/spend caps apply.

## Model chain

Configured in the workflow env (`config.model` / `config.fallback_models`). Fallbacks trigger on
API errors or context overflow — not on review quality:

| Order | Model | Where it runs | Pricing (in/out per MTok, 2026-08) |
|---|---|---|---|
| 1 | `workers-ai/@cf/zai-org/glm-5.3` | Cloudflare Workers AI | $1.40 / $4.40 ($0.26 cached input) |
| 2 | `workers-ai/@cf/zai-org/glm-5.3-flash` | Cloudflare Workers AI | flash tier (~20× cheaper) |
| 3 | `openai/gpt-5.6-terra` | OpenAI via unified billing | $2.00 / $12.00 |

Kimi K3 was considered and dropped: Moonshot is not a Cloudflare-billable provider, so keeping
it would have required a third-party account — the thing this setup exists to avoid.

`config.model_reasoning` points flash at one specific call: `/improve`'s self-reflection pass,
which re-ranks the generated suggestions. PR-Agent 0.41.0 makes that pass mandatory and defaults
it to `config.model`, so `/improve` is otherwise two full GLM-5.3 generations back to back.

Typical PR review ≈ 15–40K input + a few K output tokens → **roughly $0.03–0.08 per review** on
GLM-5.3. Unified billing adds a 5% fee on credit *purchases*; per-token rates are provider
pass-through. Verify actuals in AI Gateway analytics after the first week.

## One-time setup

1. **AI Gateway**: Cloudflare dashboard → AI → AI Gateway → create gateway (e.g.
   `stratum-reviews`). Buy unified-billing credits (needed for the GPT-5.6 Terra fallback;
   Workers AI models bill to the account directly).
2. **API token**: create a Cloudflare API token with **AI Gateway: Run** (and Workers AI)
   permission.
3. **Repo secrets**:

   ```sh
   gh secret set CLOUDFLARE_AI_TOKEN --body '<cloudflare api token>'
   gh secret set AI_GATEWAY_COMPAT_BASE \
     --body 'https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/compat'
   ```

## Usage

- Auto-review posts once, when a PR is opened (or reopened / marked ready). After pushing new
  commits, comment `/review -i` for an incremental review of just the new commits, or
  `/review` for a fresh full pass.
- Comment commands — restricted to owner/member/collaborator, and the comment must start with
  `/` (ordinary discussion comments never start a run): `/review`, `/describe`, `/improve`,
  `/ask <question>`. `/review` also works on fork PRs (comment events run with base-repo
  secrets).
- **Workflow version depends on the trigger:** automatic `pull_request` runs use the workflow
  file from the PR's merge ref, while comment-triggered `issue_comment` runs use the default
  branch's workflow file. A PR that edits this workflow therefore cannot test those edits with a
  `/review` comment on itself: the comment runs the old settings.
- The `-i` in `/review -i` is matched exactly (`pr_reviewer.py`, `arg == "-i"`). `/review -I`
  is not an error — it silently runs a full review.
- A PR event posts one artifact: the reviewer guide (up to 5 findings + quality score +
  effort/security labels). The walkthrough (`auto_describe`) and the code-suggestions table
  (`auto_improve`) are both off — comment `/describe` or `/improve` to request either on
  demand. Committable ` ```suggestion ` blocks remain off by security decision. Turn dials
  down if the bot gets noisy.
- To change models, edit the workflow env — one line per model; no code involved.

## Timeouts

AI Gateway bounds a request on **time-to-first-byte**, not total duration. PR-Agent sends
`stream: false`, so TTFB is the entire generation — prefill, every reasoning token, every
output token. A long answer therefore trips a bound meant for an unresponsive provider.

That is what `/improve` did on every run: the gateway returned `408 / AiError 3046` after
~30 minutes, LiteLLM mapped the 408 to `litellm.Timeout`, and the fallback chain retried it
twice per model. Roughly two hours of runner time per PR, no suggestions posted. `/review`
survived only because it is shorter (~222s).

The bounds now in place, outermost first:

| Bound | Value | What it catches |
|---|---|---|
| `timeout-minutes` (job) | 20 min | anything that escapes the bounds below |
| `config.ai_timeout` | 420s | a slow call, client-side |
| `DISABLE_AIOHTTP_TRANSPORT` | `True` | makes the line above actually fire |
| `cf-aig-request-timeout` | 420000 ms | a slow call, at the gateway |
| `cf-aig-max-attempts` | 1 | gateway retries multiplying PR-Agent's own |
| `config.max_model_tokens` | 14000 | the prompt growing until the call cannot finish |

`DISABLE_AIOHTTP_TRANSPORT` is not incidental. LiteLLM's aiohttp transport ignores the
per-request timeout, so `config.ai_timeout` was silently unenforced — the logs read
`timeout value=600.0, time taken=1801.57 seconds`. It only holds on the httpx path.

Output length is one lever that keeps calls under the wall, so `pr_reviewer.num_max_findings`
and the `require_*` toggles are cost controls as much as noise controls.

### Prompt size is the other lever, and it binds first

TTFB grows with the prompt, so the wall is a token budget as much as a clock. Measured on
2026-09-04, one auto-review per row:

| PR | Input tokens | Wall clock | Result |
|---|---|---|---|
| #361 | 4,487 | 3m40s | posted |
| docs/deployments-roadmap | 6,473 | 1m58s | posted |
| docs/deploy-quickstart | 7,800 | 2m34s | posted |
| #362 | 16,788 | 8m00s | posted, ~10s of margin |
| #358 | pruned to 32,000 (from 36,219) | 20m, killed | nothing |
| #359 | pruned to 32,000 (from 177,415) | 20m, killed | nothing |

The 420s wall sits somewhere around 17–20K input tokens. Above it a call cannot land, and the
failure is not one timeout but six: PR-Agent retries each model twice across a three-model
chain, so a doomed review spends 420s per attempt until `timeout-minutes` kills the job during
attempt three. It never reaches the `gpt-5.6-terra` fallback — the runner dies first. Both
killed runs above are that shape; neither had anything to do with the fallback chain's health.

`config.max_model_tokens` (14000) is what keeps the prompt under the wall: PR-Agent prunes the
diff to that budget before calling. Note that `config.custom_model_max_tokens` (131072) does
*not* do this — PR-Agent clamps it with `max_model_tokens`, whose default is 32000, which is why
every oversized PR logged `total tokens over limit: 32000` while the 131072 sat there inert.
Raise the budget only alongside streaming.

`ignore.glob` trims the input before the budget has to. It drops generated files from the diff
the model sees — `worker-configuration.d.ts` (476 KB, from `npm run cf-typegen`) and the five committed
`package-lock.json` files are together about a megabyte, so a dependency bump or a typegen
refresh would otherwise crowd out the code worth reviewing. Extend the glob list when you
commit something else that a machine writes.

We deliberately have *not* trimmed `patch_extra_lines_before` (5) or `allow_dynamic_context`.
Those are the surrounding lines the model reads to understand a hunk, so cutting them buys
input tokens at the cost of review quality, and the budget above already bounds the prompt.
Revisit only if reviews start clipping.

### Re-enabling auto_improve

Two things need to be true first:

1. **`/improve` completes at all.** Comment `/improve` on a real PR **after these settings are
   on `main`** — comment runs read the default branch's workflow, so testing from a PR branch
   silently measures the old config — and confirm both calls land inside 420s now that
   self-reflection runs on flash.
2. **The chain has a working last resort.** `openai/gpt-5.6-terra` currently returns
   `400 Chat completion bad format` from the gateway, immediately after PR-Agent logs
   `Using reasoning_effort='medium' for GPT-5 model`. 0.41.0 injects that parameter for any
   `gpt-5*` model with no setting to suppress it. Verify with a direct `curl` to the compat
   endpoint, with and without `reasoning_effort`, before trusting the fallback.

The real fix is streaming, which sidesteps a TTFB bound entirely. PR-Agent's
`litellm.force_streaming_api_base_substrings` does exactly this, but as of v0.43.0 it is
unreleased (`main` only), so it is not reachable from a digest-pinned image yet.

## Security posture & abuse bounds

Who can spend money, from broadest to narrowest:

- **Strangers: nobody.** Fork PRs and non-collaborator comments skip the job before a runner
  starts — a flood of drive-by PRs produces skipped jobs, not LLM calls.
- **Collaborators: bounded (best-effort).** Auto-review runs once per PR (open/reopen/ready)
  — pushes never re-review, so cost scales with PR count, not push count. A daily cap
  (50 successful runs, checked against the Actions API before the review step) bounds
  routine spend; it is check-then-act, so concurrent runs can overshoot slightly — a soft
  bound. Per-PR concurrency serializes runs (comment-triggered runs queue, never cancel).
- **Hard limit:** gateway-level spend caps / rate limits on the Cloudflare side (unified
  billing credits are prepaid, so the Terra fallback cannot overspend structurally), plus
  billing notifications on the account.

Other hardening:

- The action image is pinned by immutable sha256 digest, not by tag.
- The job has `contents: read` — the bot can comment but never push.
- Comment triggers are gated by `author_association`, so drive-by accounts on the public repo
  cannot spend LLM credits.
- **Prompt injection is an accepted residual risk**: PR diffs and descriptions are
  attacker-influenced input to the model, so a crafted PR could steer the review's wording.
  Blast radius is a misleading comment — treat bot reviews as advisory, never as a merge
  gate or a substitute for human review of untrusted contributions.

## Turning it off

Disable the workflow in the Actions tab (or delete `.github/workflows/pr-agent.yml`). Gateway
rate limits / spend caps on the Cloudflare gateway are the backstop.

## Known limitations

- Fallback chain is availability-based, not quality-based; if GLM-5.3 errors persistently you
  are silently reviewed by flash-tier — check gateway logs when reviews look shallow. It is also
  no help against a timeout: the 20-minute job cap fires before the chain reaches its last model.
- Large PRs are reviewed partially. Anything over the 14K prompt budget gets pruned, and the
  pruned files are named in the run log ("insufficient token budget to process"). PR #359 was
  177K tokens of diff; no setting makes that reviewable in one pass. Split the PR, or `/ask`
  about the specific files that were dropped.
- `auto_improve` is off; code suggestions are on-demand via an `/improve` comment. See
  [Timeouts](#timeouts).
- `auto_describe` is off. Its walkthrough comment restated the author's own description plus a
  file-by-file table, which is noise on a repo where descriptions are written by hand. It also
  never edited the description, so nothing downstream depended on it. Run `/describe` when a
  generated summary is genuinely wanted — the `pr_description.*` settings still govern it.
- Draft PRs are skipped until marked ready for review.
- A build-your-own alternative (a Cloudflare Worker reviewer with a custom rubric) was specced
  and shelved in favor of PR-Agent; revisit as a Stratum-native feature once the project
  self-hosts off GitHub.
