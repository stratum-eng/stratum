# First-party CI

Stratum can run a project's own lint, type-check and test commands for every
change, and gate the merge on them, without you operating a CI system. You
commit a `.stratum/ci.yaml` listing named steps; Stratum's **CI executor** runs
them in a fresh container for each evaluated revision and reports each step as
a [check run](checks.md).

This is the same machinery as [check runs](checks.md) — statuses, deadlines,
re-runs, the merge gate — with Stratum's executor in the place of your runner.
If you already run CI elsewhere, keep it: [bring your own CI](ci-integration.md)
and first-party CI can gate the same change side by side.

> **Self-hosters:** first-party CI needs a second Worker, the executor, which is
> not deployed with Stratum. Until it is, a project with a `.stratum/ci.yaml`
> gets `errored` checks saying so. See
> [Self-hosting: deploy the executor](#self-hosting-deploy-the-executor).

## Quick start

Commit this to the project's default branch as `.stratum/ci.yaml`:

```yaml
version: 1
steps:
  - name: install
    run: npm ci
  - name: lint
    run: npm run lint
  - name: test
    run: npm test
    timeoutMinutes: 20
```

and make sure `.stratum/policy.yaml` on the same branch sets
`merge.requireFreshBase` (why is [below](#set-requirefreshbase)):

```yaml
evaluators:
  - type: diff
merge:
  requireFreshBase: true
  requiredApprovals: 1
```

From then on, every change gets three checks — `install`, `lint`, `test` — and
cannot merge until all three have `passed` on the revision that was evaluated.
You did not list them under `merge.requiredChecks`: **declaring a step is what
makes it required.**

Because `.stratum/ci.yaml` is [protected configuration](#what-reading-from-the-base-protects),
the change that adds it — and every later change that edits it — needs an
approval from someone other than its author before it can merge.

## `.stratum/ci.yaml`

```yaml
version: 1              # optional; 1 is the only version
timeoutMinutes: 30      # the whole job; default 30, max 120
instance: standard-1    # optional container size; see below
network:
  allow:                # optional extra hostnames; see "Network"
    - registry.example.com
steps:
  - name: test          # the check's name
    run: |              # a bash script
      npm ci
      npm test
    timeoutMinutes: 20  # this step; default 10, max 120
    optional: false     # true = reported, but does not gate the merge (unless merge.requiredChecks names the step)
```

| Field | Meaning |
|---|---|
| `steps` | 1 to 16 steps. They run in file order. |
| `steps[].name` | The check's name: letters, digits, `.`, `_`, `-` or `/`, starting with a letter or digit; 1–64 characters; unique in the file and different from every name a `checks` evaluator in the policy declares. |
| `steps[].run` | A bash script, up to 4000 characters, run with `bash -eo pipefail` at the repository root. The first failing command fails the step. |
| `steps[].timeoutMinutes` | Whole minutes, 1–120. Default 10. |
| `steps[].optional` | `true` makes the step advisory: reported, but not a merge gate. Default `false`. A step that `merge.requiredChecks` names is required whatever this says. |
| `timeoutMinutes` | Wall-clock limit for the whole job, 1–120. Default 30. The executor's operator may set a lower maximum. |
| `instance` | `lite`, `standard-1`, `standard-2`, `standard-3` or `standard-4`. Omit it for the executor's default. A size above the executor's configured maximum is refused. |
| `network.allow` | Up to 16 exact hostnames added to the default network allowlist. No wildcards, ports, IP addresses or URLs. |

The file is validated strictly. An unknown field, a misspelled key
(`optinal: true`), an out-of-range timeout or a duplicate name makes the whole
file invalid, and **an invalid file blocks every merge** in the project until it
is fixed — the reason is shown on the blocked merge. A gate that silently
ignored the line it did not understand would be a gate nobody wrote.

A project with no `.stratum/ci.yaml` is unaffected by any of this.

## What reading from the base protects

`.stratum/ci.yaml` is read from the project's **default branch**, never from
the change being tested. A change that edits the file is still tested, and
gated, by the version already on the default branch. So a change cannot remove
a step, rename it, mark it optional, shorten its timeout, ask for a bigger
container or widen the network allowlist for itself.

**That protects the list of steps. It does not protect what a step runs.** A
step that says `npm test` runs the `test` script of the tree under test, and a
change can make that script `exit 0`. A change can equally edit the test files,
the lint configuration or a build script an earlier step calls. This is true of
any CI that tests a change's own code; reading `ci.yaml` from the base does not
alter it.

What covers it is review:

- **`merge.requiredApprovals`** in `.stratum/policy.yaml` requires a person
  other than the author to approve every change. A project whose changes are
  written by agents, and which relies on first-party CI as a gate, should set
  it. An agent's change is authored by the agent's owner, whose own approval
  does not count — so this needs a second person with write access.
- **Protected configuration.** A change that touches `.stratum/ci.yaml`,
  `.stratum/policy.yaml` or `stratum.config.json` always needs one independent
  approval, whatever `requiredApprovals` says.

Stratum's merge policy has no path-specific approval rule yet ("require
approval when `package.json` changes"). Until it does, `requiredApprovals` is
the control.

## How a job runs

For each evaluated revision of a change, Stratum sends the executor one job.

1. **A fresh container.** Every job gets its own, started for it and destroyed
   when it ends. Nothing is shared between jobs: no cache, no workspace, no
   leftover process.
2. **The checkout is rebuilt and verified.** The job fetches the change's
   **base commit**, applies the change's diff, and compares the resulting git
   tree with the tree Stratum evaluated. If they differ, **no step runs** and
   every check is `errored`. The job never tests something other than what was
   evaluated.
3. **Steps run in order**, in that one checkout, each as its own check. A
   failing step does not stop the ones after it: a lint failure is no reason to
   withhold the test results. Because they share a checkout, a later step sees
   what an earlier one left behind — `install` first, then the steps that need
   `node_modules`.
4. **The container is destroyed**, whatever happened.

### The environment

- **Image:** Debian with Node.js (the current LTS line), npm and git. Nothing
  else is installed; there is no Docker, no browser and no database. The image
  belongs to the executor, so a project cannot choose another.
- **Working directory:** the repository root, at `/workspace`. The tree is
  committed, so `git status` is clean. The base commit is available as the ref
  `refs/stratum/base` (for example `git diff refs/stratum/base`). History is
  shallow: one base commit.
- **Environment variables:** `CI=true`, `STRATUM_CI=true`, `HOME`, `PATH`,
  `LANG` and a few tool settings. Nothing from the project, and no secrets.
- **User:** root, inside the container.

### No credentials

A job holds **no credential of any kind**: no Stratum token, no repository
token, no deploy key, no project secret. The repository is fetched through a
hostname that exists only inside the job's network; the executor attaches a
short-lived, read-only token for that one repository *outside* the container,
and closes that path as soon as the checkout is verified. The code under test
cannot read the token, cannot push, and cannot call Stratum's API as anyone.

There is deliberately no way to give a step a secret. Jobs run code from
changes nobody has reviewed yet. Deployments, which do need credentials, are a
separate feature: see [Deployments](deployments.md).

### Network

A job's container has **no internet access**. It can reach only:

| Host | Why |
|---|---|
| `registry.npmjs.org` | npm packages |
| `registry.yarnpkg.com` | Yarn's alias of the npm registry |
| `nodejs.org` | Node headers for native addons; Corepack downloads |
| anything in `network.allow` | what the project added, if the executor's operator allows additions |

HTTPS only, by exact hostname. Everything else fails to resolve — including
`github.com`, so a dependency installed from a git URL needs its hosts added to
`network.allow`, and a test that calls a public API will fail unless it is
mocked.

An allowlist limits where a job can send what it can read; it does not make
that impossible. A dependency's install script can send the checkout to a
registry it is allowed to reach. That is why the job holds nothing but the
checkout.

### Pull requests from the mirror

A change that began as a [pull request on the project's GitHub
mirror](mirror-pull-requests.md) gets no job until a maintainer imports it.
After that its job is the same kind as any other: the same image, the same
allowlist, no credential but the read of the project's repository, and the
steps of the default branch's `.stratum/ci.yaml`, never the pull request's.

The job is marked as external in the dispatch. The executor refuses an external
job under any profile but `ci`. That is true of every job today, because `ci`
is the only profile. The rule is there so that a future deploy or publish
profile cannot be reached from a stranger's pull request.

## Results

Each step's check ends in one of three states:

| Status | Meaning |
|---|---|
| `passed` | The script exited `0` within its time limit. |
| `failed` | The script exited non-zero, was killed by a signal, or ran past **its own** `timeoutMinutes`. The step's fault. |
| `errored` | The step did not produce a result: the tree could not be verified, the checkout could not be built, the **job's** wall-clock limit ran out, the container stopped, the executor was at capacity, or the instance has no executor. Not evidence about the code. |

Neither `failed` nor `errored` lets a change merge. The check's summary says
which it was and why.

Limits are enforced from outside the container, by the executor, so the code
under test cannot extend them. A step that ignores its timeout takes the
container with it: that step is `failed`, and the steps after it are `errored`
as not run.

### Logs

Every step has a log — its combined stdout and stderr — linked from the check
as **details**, and available at
`GET /api/changes/{id}/checks/{checkId}/log`. A running step's log updates
about every ten seconds.

- **Who can read it:** exactly who can read the project. A log is whatever the
  change's code printed, which for a private repository can be the repository.
  Logs are stored in a private bucket bound to the executor; Stratum fetches a
  log on your behalf only after checking your access to the project.
- **Size:** the first 1 MiB of a step's output is kept (the operator can change
  this). Beyond that the log keeps its beginning and its last 64 KiB, with a
  line saying how much was dropped.
- **Retention:** set by the executor's operator.

## The merge gate

- **Every step is a required check**, unless it is marked `optional: true`. This
  is in addition to anything in `merge.requiredChecks`. Naming a step there
  makes it required even if the file marks it optional.
- A required step blocks the merge unless its newest run **on the evaluated
  revision** is `passed` — exactly as for [any required check](checks.md#the-merge-gate).
- **The checks must be the base's steps.** At merge time Stratum reads
  `.stratum/ci.yaml` from the default branch again. If the file has changed
  since the change's checks were dispatched — a step added, removed or renamed,
  a command or a timeout edited — the earlier results no longer answer the
  question the file now asks, and the merge is blocked with:

  > CI steps 'lint', 'test' have not run for the evaluated revision under the
  > base branch's current .stratum/ci.yaml; re-evaluate the change

  Re-evaluating the change runs the steps the base declares now. The same
  happens when a `ci.yaml` is added to a project that has open changes: they
  must be re-evaluated before they can merge.
- If the file is invalid, or cannot be read from the default branch, merges are
  blocked until it can be. If the default branch cannot be read **at all** —
  Stratum cannot then tell a project with no CI from one whose repository is
  unavailable — every merge in a project that has run first-party CI before is
  refused ("…could not be read from the base branch to confirm which steps are
  required; try again"), and a project that never has is treated as it always
  was.

A change to the policy or CI file on the default branch can take up to a minute
to be seen by the merge gate.

### Set `requireFreshBase`

A job tests the change's head: its base commit plus its diff. If the default
branch has moved on since, a merge combines the tested tree with commits it was
never tested against. `merge.requireFreshBase: true` refuses such a merge with
`STALE_BASE`; the author rebases, re-evaluates, and the steps run again on the
new base.

**A project that gates on first-party CI should set `requireFreshBase`.**
Without it, "CI passed" describes a tree that may not be the one that lands.

Under `requireFreshBase`, a merge is refused — not waved through — when
freshness cannot be established: `STALE_BASE` if the change has no recorded
base, and `503 BASE_UNVERIFIABLE` if the project's head cannot be read right
now (retry).

Know its limits:

- It is checked just before the merge, not atomically with it. Two merges
  racing each other can both pass the check.
- A force merge bypasses it, like every protection, where the policy sets
  `merge.allowForce`. Leave `allowForce` off.

## Re-running

Re-run a step from the change page, with
`POST /api/changes/{id}/checks/{checkId}/rerun`, or with the MCP tool
`stratum_rerun_check`. Because steps share one checkout, **re-running any step
re-runs the whole job**: every step gets a new run and the earlier results stop
counting. A re-run uses the same revision and the steps the default branch
declares now.

## Capacity

The executor runs a fixed number of jobs at once, set by its operator. When all
slots are busy a job waits, and its checks stay `queued`. If the wait queue is
also full, the job is refused: its checks are `errored` with "the CI executor is
at capacity", and you re-run once other jobs have finished. A job that waits so
long it could no longer finish before its checks' deadline is given up the same
way.

## Limits and what is not here yet

- **Binary files.** A change that adds or modifies a file that is not UTF-8
  text cannot be rebuilt from its diff, so its tree does not verify and its
  checks are `errored`. Until this is lifted, such a change cannot pass
  first-party CI.
- **One image.** Node.js and git. No service containers, no Docker-in-Docker,
  no other language toolchains unless a step installs one from an allowed host.
- **No caching.** Every job installs dependencies from scratch.
- **No secrets, no artifacts, no test-report parsing.** A step produces a
  status, a summary and a log.
- **No matrix.** One job per revision; steps run one after another.
- **No cancel button.** A job whose change is re-evaluated, or whose checks are
  re-run, stops when it next reports a step and learns it was replaced.
- **Changes from outside the project's trust boundary** (forks) are not
  handled differently from a member's change.
- **Size.** A change whose dispatch exceeds 4 MiB — in practice, a very large
  diff — is refused by the executor and its checks are `errored`.

## Self-hosting: deploy the executor

The executor is a separate Cloudflare Worker in [`ci-executor/`](https://github.com/stratum-eng/stratum/tree/main/ci-executor),
deployed separately from Stratum **on purpose**: it runs unreviewed code, so it
is bound to nothing worth stealing — no D1, no KV, no Artifacts, no deploy
credential. It holds one shared secret, one R2 bucket for logs, and its own two
Durable Object classes.

You need: the Workers Paid plan (Cloudflare Containers), **Docker running
locally** when you deploy (Wrangler builds the job image), and Wrangler logged
in to the account Stratum runs on. The executor pins its own Wrangler version;
use it (`npx wrangler` inside `ci-executor/`), because the Containers
scheduling policy it uses is in public beta.

Do these in order.

**1. Install the executor's tooling.**

```bash
cd ci-executor
npm install
```

**2. Create the log bucket.** Private; do not attach a public domain to it.

```bash
npx wrangler r2 bucket create stratum-ci-logs
# Optional but recommended: expire logs. 30 days here.
npx wrangler r2 bucket lifecycle add stratum-ci-logs expire-ci-logs logs/ --expire-days 30
```

**3. Set the executor's variables** in `ci-executor/wrangler.toml` under
`[vars]`:

| Variable | Required | Meaning |
|---|---|---|
| `STRATUM_ORIGIN` | **yes** | The public origin of your Stratum instance, e.g. `https://stratum.example.com` — the same value as Stratum's `APP_URL`. The executor reports only there. |
| `CI_MAX_CONCURRENT_JOBS` | **yes** | Containers running at once. There is no "unlimited" and no default in code: without a valid value the executor refuses every job. Start at `2`. |
| `CI_MAX_QUEUED_JOBS` | no (`10`) | Jobs that may wait for a slot. |
| `CI_DEFAULT_INSTANCE` | no (`standard-1`) | Container size when `ci.yaml` asks for none. |
| `CI_MAX_INSTANCE` | no (`standard-2`) | Largest size `ci.yaml` may ask for. |
| `CI_MAX_JOB_MINUTES` | no (`60`) | Longest job wall-clock limit. |
| `CI_ALLOW_PROJECT_HOSTS` | no (`true`) | Whether `network.allow` may extend the default allowlist. |
| `CI_GIT_HOST_SUFFIX` | no (`.artifacts.cloudflare.net`) | Repositories are fetched only from hosts ending in this. |
| `CI_LOG_MAX_BYTES` | no (`1048576`) | Output kept per step. |

The bucket name under `[[r2_buckets]]` must match step 2.

**4. Deploy the executor.** This builds the image from
`ci-executor/container/Dockerfile` and pushes it to Cloudflare's registry.

```bash
npx wrangler deploy
```

It deploys with `workers_dev = false` and no route: it has no public URL, and is
reached only through the service binding in step 7.

**5. Generate the shared secret and give it to the executor.** At least 32
characters; the executor refuses every job until it is set.

```bash
openssl rand -hex 32          # copy the output
npx wrangler secret put CI_EXECUTOR_SECRET     # in ci-executor/
```

**6. Give Stratum the same secret.** From the repository root, for each
environment you deploy:

```bash
cd ..
npx wrangler secret put CI_EXECUTOR_SECRET                   # production
npx wrangler secret put CI_EXECUTOR_SECRET --env=staging     # if you run staging
```

Use a different secret, and a different executor, per environment.

**7. Bind Stratum to the executor.** In the root `wrangler.toml`, for the
environment you are configuring (top level, or `[[env.<name>.services]]`):

```toml
[[services]]
binding = "CI_EXECUTOR"
service = "stratum-ci-executor"
```

A service binding is the recommended path: the dispatch carries a repository
token, and this keeps it off the public internet. If the executor must live
elsewhere, give it a route and set `CI_EXECUTOR_URL = "https://…"` in Stratum's
`[vars]` instead (https only).

`APP_URL` must also be set on Stratum, as for [check runs](checks.md#self-hosting-notes):
it is the callback origin, and it must equal the executor's `STRATUM_ORIGIN`.

**8. Apply the database migration and deploy Stratum** the way you normally do.
The executor needs migration `077_checks_ci_config_digest.sql`:

```bash
npx wrangler d1 migrations apply stratum --remote
npx wrangler deploy
```

**9. Check it.** Add a `.stratum/ci.yaml` to a test project, open a change, and
watch its checks go `queued` → `running` → `passed`. If they are `errored`
instead, the check's summary names what is missing. `npx wrangler tail` in
`ci-executor/` shows the executor's side.

### Operating notes

- **Cost.** Containers bill for memory and disk while running and for CPU used.
  `CI_MAX_CONCURRENT_JOBS` × `CI_MAX_INSTANCE` × `CI_MAX_JOB_MINUTES` bounds the
  worst case. There are no per-project limits yet: every project on the instance
  shares the executor.
- **Rotating the secret.** Set the new value on the executor and on Stratum.
  Jobs in flight when you rotate report with the old secret and are refused;
  their checks reach their deadline and become `errored`. Re-run them.
- **Changing the image.** Edit `ci-executor/container/Dockerfile` (for example
  `ARG NODE_VERSION`) and deploy the executor again. Running jobs keep the image
  they started with.
- **The executor is at capacity for everyone at once.** It is one queue for the
  whole instance.
- **Isolation.** Each job runs in its own container (a VM-backed Cloudflare
  Container) with no internet. Inside it, every process has root's
  capabilities; the boundary is the container, not the user.

## See also

- [Check runs](checks.md) — the statuses, the callback contract, deadlines and the merge gate this is built on
- [CI Integration (Bring Your Own CI)](ci-integration.md) — run evaluations on your own infrastructure instead
- [Deployments](deployments.md) — publishing the merged tree, with credentials
- [Changes API: check runs](../api/endpoints/changes.md#check-runs)
