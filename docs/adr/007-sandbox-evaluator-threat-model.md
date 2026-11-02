# ADR 007: Sandbox Evaluator Threat Model and Time Budget

## Status

Accepted. Implements the decisions in issue #239, which was filed because both
items below needed a policy call rather than a quick fix.

Note the ADR is written while the `[[sandboxes]]` binding is **commented out**
in `wrangler.toml`. Nothing here has been verified empirically against a live
Cloudflare Sandbox; the unknowns are labelled as such rather than resolved.

## Context

The `sandbox` evaluator (`src/evaluation/sandbox-evaluator.ts`) materializes the
full workspace tree at the evaluated commit into a Cloudflare Sandbox, installs
dependencies, and runs a configured command as a merge gate.

**The evaluated tree is untrusted input.** It is authored by an agent, or by any
human who can push to a workspace, and the evaluator runs against it *before*
any human review — that is the entire point of a merge gate. Everything below
follows from taking that seriously.

Two specific problems prompted this ADR.

**1. Nothing bounded total evaluation time.** `installTimeoutMs` and `timeoutMs`
were independent per-phase timeouts. With the old defaults (120s + 60s) a single
evaluation could occupy a synchronous request for 180s of sandbox work alone,
before an unbounded repo tree read. Evaluation runs on the request path — from
`POST /projects/:name/changes`, `POST /changes/:id/evaluate`, and the gated
`git push` receive-pack handler — so a caller or proxy gives up first and the
submitter never learns the verdict. Worse, both numbers came straight from
`.stratum/policy.yaml` with no validation: `installTimeoutMs: 999999999` was
accepted verbatim.

**2. `npm ci`/`npm install` executed untrusted lifecycle scripts.** A tree's
`package.json` can declare `preinstall`/`install`/`postinstall`. Those ran with
whatever access the Sandbox binding permits, before review. The binding is the
intended isolation boundary, but Stratum had never written down what that
boundary is assumed to provide.

## Decision

### 1. Installs pass `--ignore-scripts` by default

`installCommandFor` emits `--ignore-scripts` unless a project sets
`allowInstallScripts: true` on its `sandbox` evaluator config. The parameter is
optional and the safe behavior is the default, so omitting it cannot silently
opt a project in.

This is a **breaking change** for projects whose build needs lifecycle scripts.
The opt-in exists precisely for them.

### 2. A total budget bounds the evaluation

`totalBudgetMs` (default 150 000 ms) bounds the whole evaluation. Each phase is
granted `min(configured, budget remaining)`; exhaustion returns a verdict —
score 0, reason `sandbox budget exceeded (<phase>)` — reached two ways: a phase
that cannot be started, and a phase whose grant the budget had to shorten which
then failed at that shortened timeout.

A phase that hits the project's **own** configured timeout is deliberately not
in scope: it keeps returning `err(ExternalServiceError)`, as it did before this
change. Relabelling it would silently alter what every pre-existing sandbox
timeout reports, and it is not the budget's judgement to make.

Classification requires **both** that the budget shortened the grant and that
the phase actually spent it. A transient Sandbox failure part-way through a
budget-shortened phase stays an `err`, so a retryable infrastructure problem is
never converted into a definitive judgement that fails the merge gate. Elapsed
time is used for this rather than matching on error message text, which is
binding-specific and would rot silently.

The per-phase defaults were lowered so they sum to exactly the budget
(`installTimeoutMs` 120s → **90s**, `timeoutMs` unchanged at 60s), enforced by a
test. Without that, an unconfigured project's scored command would be truncated
through no choice of its own.

Exhaustion is a **verdict, not an error**. The sandbox was reachable and ran; it
simply did not finish in the time a synchronous request can carry. That is a
judgement about the change, whereas an unreachable sandbox is not.

### 3. Policy-supplied values are validated and clamped

`policy-loader.ts` clamps `sandbox.timeoutMs`, `sandbox.installTimeoutMs`,
`sandbox.totalBudgetMs`, `webhook.timeoutMs`, and top-level `minScore`;
validates `sandbox.command` (non-empty, no newlines, length-capped) and
`sandbox.allowInstallScripts` (real boolean); and drops malformed evaluator
entries that would otherwise crash `buildEvaluators` on `.type` access.

A clamp is **not** a malformed policy: it logs a warning, sets no `configError`,
and blocks no merge. `configError` is for a policy that could not be understood
at all; an out-of-range timeout is a bounded mistake that is safe to correct,
and escalating it to a merge block would be hostile to existing projects.

Load-time clamping is defense in depth, not the boundary. `evaluate()` is also
reachable from a 60-second KV policy cache and from callers that never went
through the loader, so the evaluator applies its own defaults and
`budget.allow()` regardless. This matches the existing point-of-use precedent in
`llm-evaluator.ts`.

## What the Sandbox binding is relied upon for

**Relied upon:** process and filesystem isolation per sandbox instance, and that
an instance is destroyed after each evaluation (`sb.destroy()` in a `finally`).
Stratum does not inject bindings, secrets, or tokens into the sandbox — the
evaluator writes only the repo tree and its own decode helpers.

**Not relied upon, because Cloudflare does not publicly document it and we
cannot verify it here:**

- **Network egress restrictions.** We assume egress **is** available. That
  conservative assumption is what motivates `--ignore-scripts`.
- **Whether `run()`'s `timeout` actually terminates the process** or is merely
  advisory. If advisory, a single runaway command is not interrupted; the budget
  still prevents *subsequent* phases from starting.
- Any guarantee about filesystem scoping beyond the instance.

Anyone enabling the `[[sandboxes]]` binding should verify these rather than
inherit the assumptions in this document.

## What `--ignore-scripts` does not close

It narrows the window from "arbitrary code, during install, before review" to
"the command the project explicitly configured". It is **not** containment. Still
open at install time:

- **A tree-supplied `.npmrc`.** npm honors one checked into the repo:
  `registry=`, `//host/:_authToken=`, proxy settings. Combined with the
  assumption that egress is available, a hostile tree can redirect dependency
  resolution to an attacker host with no lifecycle script involved.
- **Lockfile `resolved` URLs.** `package-lock.json` is attacker-authored and
  `npm ci` fetches those URLs verbatim.
- **The scored command itself.** `npm test` runs untrusted code by design. That
  is what the evaluator is for, and why the Sandbox binding — not
  `--ignore-scripts` — has to be the real boundary.

**The mitigation is npm-only.** `installCommandFor` returns `null` without a
`package.json`, so pnpm/yarn/bun trees get no install at all and then run the
scored command against an empty `node_modules`. This ADR does not bless that
behavior; it records it.

## The post-merge smoke check is a separate, worse exposure

`src/merge/post-merge.ts` runs `MergePolicy.postMergeCommand` in a sandbox
against the merged HEAD. It shares `materializeTree` with the evaluator but not
`installCommandFor`, so `--ignore-scripts` does not reach it. It is out of scope
for the code change this ADR accompanies, but it must be named, because it is
strictly more exposed than the path that was fixed:

- It mints a **write-scoped** repo token and runs untrusted merged code in the
  same request.
- It passes an **unbounded** `postMergeTimeoutMs` as the tree-decode timeout —
  `sanitizeMergePolicy` requires it to be positive but places no ceiling.
- It runs its command with **no dependency install at all**, so `npm test` there
  executes against a tree with no `node_modules`.

These should be addressed as follow-up work.

## Residual risks accepted

- **The budget does not bound Worker-side CPU.** Workers freeze `Date.now()`
  across pure-CPU spans (see `src/utils/phase-timer.ts`), so a tree engineered to
  burn CPU in pack decompression or base64 encoding advances the clock little.
  Such work is constrained by workerd's own CPU limit, not by this budget. The
  budget reliably bounds time spent *awaiting the sandbox*, which is the overrun
  #239 was filed about.
- **It is not a request-level bound.** The policy load and the two diff clones
  happen before evaluation starts; `sandbox.create()` and `sb.destroy()` take no
  timeout; and the `llm` evaluator has no timeout at all. Overall request latency
  remains unbounded.
- **Per-change budgeting is not rate limiting.** 150s of sandbox time per change,
  times N concurrent gated pushes, is still available to a hostile pusher. The
  `sandbox_ms` cost record is what surfaces this today.
- **`requireAll: false` absorbs a budget verdict.** `CompositeEvaluator.aggregate`
  then uses `some()` and `max()`, so a passing evaluator masks the sandbox's
  failure. That is the documented meaning of the setting and a project owner's
  choice, but it means "the sandbox fails closed" is true of the evaluator, not
  unconditionally of the gate.
- **Policy sanitization is still partial.** `requireAll`, `llm.threshold`, and
  `diff.forbiddenPatterns` remain unvalidated.

## Why `allowInstallScripts` needs no further ceremony

`.stratum/policy.yaml` is in `PROTECTED_CONFIG_FILES`, so a change that flips
the flag already requires a human approval and cannot be force-merged. That
protection is what makes the opt-in safe to offer.

It is worth recording its actual shape: `diffTouchesProtectedConfig` is a
substring match for `diff --git a/.stratum/policy.yaml b/.stratum/policy.yaml`.
A rename, non-default diff prefixes, or a path requiring git quoting would
defeat it. Hardening that check is separate work; this ADR leans on the
protection while naming its limit rather than assuming it is airtight.

## Alternatives considered

**Move evaluation off the request path** (issue #239's other option). A queue
binding, a consumer, a new `evaluating` change status, a migration, and a rework
of how the gated `git push` handler reports per-ref status. Deferred — tracked
in `docs/REMAINING_WORK.md`. The budget remains correct and useful inside a
future queue consumer, so this is not throwaway work.

**Race the tree read against the budget.** Rejected: it needs a real timer,
which an injected fake clock cannot drive, and leaks a live 150s timer into the
test event loop. The read is instead charged against the budget without being
interrupted.

**Treat a clamp as `configError`.** Rejected as hostile to existing projects;
see Decision 3.
