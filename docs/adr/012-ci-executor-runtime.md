# ADR 012: Runtime for the First-Party CI Executor

## Status

Accepted. Decides the runtime and trust boundaries for #415. Decided with the
project owner on 2026-11-09. The implementation follows in its own PR.

## Context

Stratum has no CI runner. "Tests gate the merge" works today only if a project
hosts its own webhook receiver, or enables the `sandbox` evaluator, whose
binding is commented out in `wrangler.toml`. Hosting Stratum's own development
on Stratum (#423) needs lint, typecheck, tests and the package suites to run on
a stock instance.

A CI job runs code chosen by whoever authored the change, before a person has
reviewed it. `docs/user-guide/webhook-executor.md` and ADR 007 set out what that
requires: the job must hold no credential worth stealing, must not choose its
own gate, and must not be able to reach anything it has no reason to reach.

Check runs (#414) give the executor something to report to: a dispatch carrying
`{diff, baseSha, headSha, checkRunIds, callbackUrl}`, and a signed callback per
check.

Three runtimes were on the table: Cloudflare Containers, an external runner
behind the existing webhook contract, and `@cloudflare/computer`.

## Decision

### Jobs run in Cloudflare Containers

One fresh container per job, destroyed when the job ends. A Durable Object
owns exactly one container, so each job gets its own Durable Object, addressed
by the job's id, and that object starts, drives and destroys the job's
container. Nothing is reused between jobs: no filesystem, no process, no cache
that a previous job could have written.

Containers meet the three requirements that could have ruled them out. Each was
checked against Cloudflare's documentation on 2026-11-09:

- **Egress can be denied by default.** A container started with
  `enableInternet: false` reaches only the hostnames the Durable Object has
  registered an intercept for (`ctx.container.interceptOutboundHttps`), and
  only on ports 80 and 443. Every other DNS lookup times out. A job reaches
  the package registries its project needs and nothing else. A container has
  128 intercept entries, which bounds the allowlist.
- **A job need not hold a credential.** The intercepts are Worker entrypoints
  that run outside the container and can attach a token to a request as it
  leaves. The job clones through a hostname the Worker intercepts. It never
  sees the read token, so there is nothing for a dependency's install script
  to send anywhere. This is stronger than the read-only job token #415 asked
  for. Intercepting HTTPS requires the image to trust Cloudflare's
  interception CA.

  An intercept is matched on the TLS server name, and the request inside can
  name a different host. So the handler never forwards the container's URL
  with a credential attached. It checks that the request's scheme is HTTPS and
  that its hostname is exactly the one the credential is for, builds the
  upstream request itself, and does not follow redirects: a redirect is
  returned to the job without the credential.
- **Self-hosters can run it.** Containers are included in the Workers Paid
  plan, which is the plan self-hosters are on. They have been generally
  available since April 2026.

### The `durable_object` scheduling policy

A Container application has a scheduling policy, and it cannot be changed after
the application is created. The executor uses `durable_object`.

- **`default` is deprecated.** Cloudflare's documentation marked it deprecated
  in November 2026 and directs new applications to `durable_object`. Moving
  later means a replacement application, a new Durable Object class and
  namespace, and no transfer of instances. Starting on `default` would be
  choosing that migration.
- **It fits the job model.** The Durable Object passes the image and instance
  size to `ctx.container.start()` for each job. That lets the CI and deploy
  profiles below use different images, and lets a project's `.stratum/ci.yaml`
  ask for a larger instance, without a deploy of the executor. Instances have
  independent lifecycles, which is what one-container-per-job means.
- **It supports snapshots**, which `default` does not. That is the route to
  faster starts if cold-start cost turns out to matter.

Two costs come with it:

- **It is in public beta** (since 30 September 2026). The API may change
  under us. That is accepted: the alternative is building on a policy already
  marked for removal.
- **The `Container` helper class does not support it.** The executor uses the
  Durable Object Container API (`ctx.container`) directly, and so does not get
  the helper's `allowedHosts` and `outboundByHost` properties. The egress
  rules above are written against the direct API for that reason.
- **The platform no longer caps instances for us.** `max_instances` is a
  `default`-policy setting and is rejected under `durable_object`. Nothing but
  the account's own limits stops a burst of dispatches from starting a
  container each.

So the executor enforces its own cap, in every deployment, self-hosted
included. One coordinating Durable Object admits jobs and starts none itself.
It holds the set of admitted jobs and tells a job's own Durable Object to
start only while that set is smaller than an executor-wide limit, which has a
conservative default and is a required setting with no "unlimited" value. A
job over the limit waits in the coordinator's queue with its checks still
`queued`; the queue is bounded too, and a dispatch that does not fit is
refused, which the check's deadline turns into `errored`.

A slot is held until the job's container is confirmed gone, not until the job
is believed to be over. When a job finishes, or its wall-clock timeout fires,
its Durable Object destroys the container and reports back only once
`ctx.container.running` is false. A timeout that fired while the container was
still stopping therefore does not free a slot early, and repeated timeouts
cannot push the number of live containers past the cap. If destruction fails,
the slot stays held and the job object retries on an alarm. The coordinator
also reconciles on an alarm: it asks each job it believes is running for its
state, so a job object that was lost, or never reported, is found and its slot
freed only after its container is known to be gone. Per-project limits sit on
top of this cap and cannot raise it.

### The executor is its own Worker

The container belongs to a separate Worker, deployed and bound on its own, not
to the main Stratum Worker.

An outbound handler has every binding its Worker has. If the container hung off
the main Worker, the code that decides what untrusted jobs may reach would sit
next to D1, the Artifacts binding and the session store. The acceptance
criterion "the job environment holds no credential that can write to Stratum or
deploy anything" would then rest on that handler never having a bug.

As a separate Worker, the executor holds only:

- the secret that verifies a dispatch came from Stratum and signs its callbacks;
- a narrowly scoped means to read one repository at one commit, for the length
  of one job;
- an object-storage bucket for logs.

It holds no D1 binding, no session store, and no deploy credential.

### What a job is

- **Defined in the repository, read from the base.** `.stratum/ci.yaml` lists
  named steps with commands and timeouts. It is read from the base tree, never
  from the change's head, and joins `.stratum/policy.yaml` in
  `PROTECTED_CONFIG_FILES`. A change therefore cannot remove a step, rename
  it, shorten its timeout, widen the network allowlist or drop a required
  check.

  This protects the list of steps, not what a step does. A step that runs
  `npm test` runs the `test` script of the tree under test, and a change can
  make that script a no-op. That is true of any CI that tests a change's own
  code, and reading `ci.yaml` from the base does not alter it. What covers it
  is review. The control that exists today is `merge.requiredApprovals`,
  which requires a person to approve every change; a project that gates on the
  executor and has agents authoring changes sets it, and Stratum's own project
  will. The merge policy has no path-specific approval rule, so "require
  approval only when `package.json` or the test configuration changes" cannot
  be expressed yet. That rule is the better fit and is listed below as a
  follow-up.

  `requiredApprovals` needs a second person. Stratum records an agent's owner
  as the author of the agent's change and does not count the author's own
  approval. A project with one writer, whose agents author its changes, can
  therefore merge nothing once `requiredApprovals` is set: the only person
  able to approve is the one whose approval is excluded. Such a project either
  adds a second reviewer with write access, or runs without
  `requiredApprovals` and accepts that a change can alter what its own gate
  runs.

  The second option does not remove the need for a second reviewer. It only
  removes it for ordinary changes. A change that touches protected config
  always needs one independent approval, whatever `requiredApprovals` says,
  and `.stratum/ci.yaml` becomes protected config. So a single-writer project
  cannot add `ci.yaml`, or ever edit it, without someone else to approve the
  change. In practice a project that uses the executor needs a second person
  with write access, at least for those changes. Stratum's own project has to
  arrange that before it gates on the executor.
- **Reconstructed, then verified.** The job clones at `baseSha`, applies the
  diff, and checks that the resulting tree is the head's tree before any step
  runs. A mismatch fails the job. The executor reads one repository at one
  commit, the base, and cannot look the head commit up, so the signed dispatch
  carries the head's **tree id** alongside `headSha`. The executor compares
  against that. The dispatch payload from #414 gains this field.
- **What ran is the change's head, which is not always what merges.** If the
  project's default branch advances after the checks ran, a merge combines the
  tested tree with newer commits, and Stratum refuses that only when the policy
  sets `requireFreshBase`. A project that gates merges on the executor sets
  `requireFreshBase`. That refuses a stale change with `STALE_BASE`. It does
  not re-evaluate it: the author rebases and asks for a new evaluation, and
  the checks run again against the new base. Three limits on that protection
  are stated here so that nobody reads more into it:

  - **It can be skipped today.** The merge route skips the check when the
    project's head cannot be resolved, or when the change has no recorded
    base, and the merge proceeds unverified. The executor's implementation
    closes this, so that under `requireFreshBase` an unresolvable head or a
    missing base refuses the merge.
  - **It is a check before the merge, not part of it.** The head is read, and
    then the merge runs. A second merge landing between the two is not caught.
    The fix is to make the comparison atomically with the ref update, on every
    path that moves the default branch. There are four, and they differ: the
    plain merge goes through a per-project Durable Object, where the comparison
    can move inside the serialized step; a squash merge does not go through
    that object; a batch merge compares each of its changes with the head it
    read at the start, so every change after the first is judged against a
    head the batch has itself already moved; and resolving a sync conflict
    with "accept workspace" commits the workspace as it is at that moment,
    pinned to neither a base nor an evaluated revision, so it can write a
    version that was never evaluated at all. That last path needs more than a
    freshness check: it has to write only a revision whose checks passed, or
    be refused when required checks are configured. Until all four are covered
    the window exists.
  - **A force merge bypasses it**, like every other protection, where the
    policy sets `allowForce`. A project that gates on the executor leaves
    `allowForce` off. Testing the proposed merge tree instead is the
  better long-term answer and is left open below.
- **One check per step, and every step is required.** Each step reports
  through the #414 callback. The steps declared in the base `ci.yaml` are
  required checks by default: the merge gate takes the required names from
  that file, in addition to anything in `merge.requiredChecks`, and a step
  opts out only by being marked optional there. If the checks dispatched for
  a revision do not match the steps the base declares, the gate fails closed.
  A step that never reports is caught by its check's deadline, so a hung or
  killed job cannot leave a change mergeable.
- **Bounded.** CPU and memory by instance type, wall-clock by a timeout the
  Durable Object enforces from outside the container, log size by a cap. Logs
  go to object storage and are linked from the check.

### Deploy credentials are a separate profile

Deploy pipelines (#416) and package publishing (#422) need real credentials.
Those jobs run under a different profile from CI jobs: a different container
class, started only for a merge that has already passed its gates, with
credentials injected by the outbound handler for specific hostnames. A CI job
on an unreviewed change never runs under that profile.

Changes that originate outside the project's trust boundary, such as a fork
pull request brought in from a mirror (#420), run under the CI profile with the
registry allowlist and nothing else.

## Alternatives considered

### An external runner behind the webhook contract

Keep the executor out of Stratum and document how to run one. This is what
exists today, and it stays supported. It is not enough on its own: every
project would have to build and secure a receiver before its first gated merge,
and the earlier attempt to ship a copyable one found that the safety problems
live in the process, filesystem and network boundaries, which a snippet cannot
carry.

### `@cloudflare/computer`

An agent runtime, in early preview since August 2026, that chooses between
Dynamic Workers and Containers per task. Rejected for CI:

- CI steps are shell commands that need a filesystem, child processes and
  native binaries. Cloudflare's own guidance names `npm test` as work that
  needs Linux. The choice would resolve to a container every time.
- The backend is chosen by a model. A merge gate has to run the same way every
  time.
- Its filesystem lives in Durable Object SQLite and is mounted into the
  container through FUSE. CI wants a fresh clone that is thrown away.
- A preview API is the wrong thing to build the untrusted-code boundary on.

It is a good fit for a different feature: giving an agent a workspace to read,
edit and run light commands in. Revisit it for that once it leaves preview.

### The existing `sandbox` evaluator

It runs a command and returns a score inside the evaluation request. It has no
per-step results, no logs to link, and no room for a job that takes minutes.
Check runs exist because that model does not fit CI. The evaluator stays for
what it is good at.

## Consequences

- **A size ceiling.** An instance tops out at 4 vCPU, 12 GiB of memory and
  20 GB of disk. That should be comfortable for Stratum's own suites, which has
  not been measured yet, and is a real limit for projects with heavy builds.
  Those projects keep the external-runner path.
- **Cold starts.** A fresh container per job pays image start-up on every job.
  That is the price of sharing nothing between jobs. Measure it before
  optimizing. A snapshot taken by Stratum from a known-clean image, never from
  a container a job has run in, is the option if it matters.
- **A beta dependency.** The scheduling policy the executor needs is in public
  beta. Pin the Wrangler version the executor deploys with, and expect to
  follow API changes until it is generally available.
- **A second deployable.** Self-hosters who want first-party CI deploy the
  executor Worker as well, which needs Docker at deploy time to build the
  image. Stratum without the executor keeps working exactly as it does now.
- **Usage is metered.** Containers bill for memory and disk while running and
  for CPU actually used. The executor-wide cap bounds the worst case for any
  deployment. A hosted instance also needs per-project limits before this is
  offered to anyone but the project itself.
- **Registry access is still access.** A dependency can send what it can read
  to a registry it is allowed to reach. The job holds no credential and sees
  only one repository's content, which bounds the loss to that content. This is
  inherent to running an install step and is the reason the job holds nothing
  else.

## Open questions for the implementation

- Which hosts the default allowlist contains, and whether a project may extend
  it from `.stratum/ci.yaml` (read from the base, so a change cannot widen it).
- How the read path for one repository at one commit is scoped: a short-lived
  token injected by the outbound handler, or a service binding back to Stratum
  that serves exactly that bundle.
- The default for the executor-wide concurrency cap, and the shape of the
  per-project concurrency and monthly usage limits that sit under it.
- Path-specific approval rules in the merge policy, so that a change touching
  gate-defining files needs approval without requiring it for every change.
- Making the fresh-base comparison atomic with the ref update on all four
  paths that move the default branch: plain merge, squash, each item of a
  batch, and sync conflict resolution.
- Whether to test the proposed merge tree (base tip plus the change) instead
  of the change's head, which would remove the dependence on
  `requireFreshBase`.

## Implementation notes

Added with the first implementation (#415). These record what was decided
where this ADR left a question open, and where the implementation is narrower
than the text above. Nothing here reverses a decision.

### Open questions, as decided

- **Default allowlist.** `registry.npmjs.org`, `registry.yarnpkg.com` and
  `nodejs.org`: what a Node project needs to install, and nothing a job could
  be told to fetch code from. Notably not `github.com` — a dependency on a git
  URL needs its host added.
- **Extending it.** A project may add up to 16 exact hostnames under
  `network.allow` in `.stratum/ci.yaml`, read from the base. No globs, ports or
  IP addresses. The executor's operator can turn this off
  (`CI_ALLOW_PROJECT_HOSTS = "false"`), in which case a job that asks for more
  is refused rather than run with less.
- **The read path.** A short-lived token, not a service binding back to
  Stratum. Stratum mints a one-hour, read-only Artifacts token for the
  project's repository and sends it in the signed dispatch. The executor puts
  it in the props of the intercept handler for `git.stratum.internal`, a
  hostname that exists only inside the job's network; the handler serves the
  two requests a `git fetch` makes and builds the upstream request itself. A
  binding back to Stratum would have made the executor a caller of the main
  Worker, which is the coupling "its own Worker" exists to avoid. Two things
  narrow the token further than "for the length of one job": the proxy is
  replaced with one that refuses everything as soon as the checkout is
  verified, and the token is deleted from the job's storage at the same moment,
  so steps run with no path to the repository at all.

  The token reads the whole repository, not "one commit": Artifacts tokens are
  scoped to a repository. A job could, during the seconds the checkout is being
  prepared, fetch other branches — but no step is running then, only the
  executor's own script.
- **The concurrency cap.** `CI_MAX_CONCURRENT_JOBS` is required and has no
  default in code; the shipped `wrangler.toml` sets `2`. `CI_MAX_QUEUED_JOBS`
  defaults to `10`. **Per-project concurrency and monthly usage limits are not
  implemented**; the executor is one queue for the whole instance. That is
  acceptable while the only project is Stratum's own and must be built before
  the executor is offered to anyone else.

### Decisions this ADR did not ask for

- **One secret for the instance.** `CI_EXECUTOR_SECRET` signs the dispatch, the
  executor's callbacks and Stratum's requests for logs. A first-party check run
  is verified against it and only it; a project's own runner key cannot report
  one, and it cannot report a project runner's check. Rows are told apart by a
  new nullable column, `checks.ci_config_digest` (migration 077).
- **"Do not match" means the digest, not the names.** The merge gate fails
  closed unless every step the base declares has, as its newest run on the
  evaluated revision, a run dispatched under a `ci.yaml` with the same SHA-256
  digest as the base's current one. The digest covers names, commands,
  timeouts, optionality, instance and allowlist. A comparison of names alone
  would pass a change tested under `run: npm test` after the base changed it to
  something else — and could not see a removed step at all, since a check run
  for a name stays the "newest" for its revision forever.
- **A re-run re-runs the job.** Steps share a checkout, so one step cannot be
  re-run alone.
- **Who reads logs.** Logs live in an R2 bucket bound to the executor, with no
  public access. The executor serves a log only to a request signed with the
  shared secret, valid for five minutes and one check run. Stratum's
  `GET /api/changes/:id/checks/:checkId/log` makes that request after
  authorizing the caller: exactly those who can read the project.
- **Stratum reaches the executor over a service binding** (`CI_EXECUTOR`), so
  the dispatch and its token do not cross the public internet; the executor
  reports to Stratum's public callback URL, with
  `global_fetch_strictly_public` so that a same-zone callback reaches the
  Worker. A URL (`CI_EXECUTOR_URL`) is supported for an executor that lives
  elsewhere.
- **Status mapping.** A step that exits non-zero or outlives its own timeout is
  `failed`. Anything that prevented a step from producing a result — tree
  mismatch, unbuildable checkout, the job's wall-clock limit, a lost container,
  no capacity — is `errored`.
- **The profile is a field.** A job carries `profile: "ci"`, and the image,
  allowlist and (absent) injected credentials hang off it, so the deploy and
  publish profiles (#416, #422) are additions rather than rewrites.
- **`requireFreshBase` fails closed.** As this ADR required: under
  `requireFreshBase`, a change with no recorded base is refused (`STALE_BASE`),
  and an unresolvable project head is refused (`503 BASE_UNVERIFIABLE`), on the
  single and the batch merge. The non-atomic window described above is
  unchanged.

### Changes from outside the trust boundary (#420)

Added with pull requests from the mirror. The decision above — such a change
runs under the CI profile and nothing else — is held in three places:

- **No job before a maintainer acts.** A pull request is recorded as a change in
  status `external`, which is never evaluated and so never has checks
  dispatched. Importing it is a person's action, and so is importing each later
  version of it. This is stricter than the decision requires. The reason is the
  capacity note above: the executor is one small queue for the instance, with
  no per-project limit yet, and a job runs the pull request's own scripts.
- **The dispatch says where the change came from.** `job.origin` is `project`
  or `external`. Stratum marks a job `external` when the change has a pull
  request record, and also when that lookup fails.
- **The executor enforces it by itself.** Before it looks at which profiles it
  implements, it refuses an `external` job whose profile is not `ci`. Today
  that refuses nothing the profile check would not, because `ci` is the only
  profile. It is there so that adding a deploy or publish profile cannot make
  one reachable from a stranger's pull request by omission.

### Where the implementation is narrower

- **Slots and the coordinator.** A job keeps its slot until its container is
  confirmed gone: a failed teardown is retried and the slot is not released
  while the container still runs. The coordinator does not ask jobs for their
  state, as the decision above describes. It takes a slot back on its own
  clock, when the job's wall-clock limit plus a grace period has passed. That
  bounds a lost job object, but it is a timer and not a confirmation, so a
  container that outlives both its limit and its teardown can briefly run
  beside its replacement.
- **Non-text files.** The change diff is built from files decoded as UTF-8, so
  a change that adds or modifies a binary file cannot be reconstructed. Its
  tree does not verify and its checks are `errored`. Fails closed, as intended,
  but it means such a change cannot pass first-party CI until the dispatch can
  carry binary content. The diff builder was otherwise fixed to be applicable
  byte for byte (final newlines, empty files, modes, symlinks), which the job's
  verification depends on.
- **Nothing in the container is a boundary.** With the `durable_object`
  scheduling policy every process in the container has root's capabilities, so
  the in-container supervisor that runs steps can be killed or impersonated by
  the code it supervises. Limits are therefore enforced by the Durable Object:
  it destroys the container when a step outlives its timeout plus a grace
  period, and when the job outlives its wall clock. What a step can do to its
  own result, or a later step's, it could already do by editing the checkout —
  the trust model is the one stated under "What a job is".
- **Read failures.** A `ci.yaml` that cannot be read while the same repository
  answers for the policy file blocks merges. Only git's own "not in the tree"
  counts as the file being absent; any other failed read is a failure. If no file can be read at all, the
  loader cannot tell "no config" from "repository unavailable" — an empty
  repository fails its clone too and has to stay usable — so it still falls
  back to the default policy, as it always has for the policy file. For CI that
  fallback is bounded: the policy is marked unverified, and while it is, the
  merge gate refuses every change of a project that has ever dispatched a
  first-party check run. So neither a failed step nor a change opened during
  the outage can merge because a read failed. A project that has never run
  first-party CI is unaffected — which is also every empty repository. The
  policy file's own `merge:` rules are still lost to a total read failure, as
  before this change; closing that needs a way to tell an empty repository from
  an unreachable one, and is not attempted here.

## The deploy profile, as built (#416)

Added with deploy pipelines. It implements "Deploy credentials are a separate
profile" above, and it changes one sentence of this ADR: the executor Worker
**does** now hold deploy credentials, when its operator configures deploy
targets. "It holds no … deploy credential" remains true of an executor with no
`DEPLOY_TARGETS`, which is the default.

### What was built

- **A second Durable Object class and container application.** `DeployRunner`
  beside `JobRunner`, each with its own `[[containers]]` entry and image
  (`deploy` adds `curl` and `jq` to the CI image). The dispatch's event picks
  the class: `checks.requested` can only produce a `ci` job and goes to
  `JobRunner`; `deploy.requested` can only produce a `deploy` job and goes to
  `DeployRunner`. Each class refuses a job of the other profile.
- **Stratum sends "deploy commit X to environment Y" and the steps.** The
  steps come from the `deploy:` section of `.stratum/ci.yaml` at the merged
  commit. The body carries no credential for the deploy target; the only
  credential in it is the read-only repository token a CI job also gets.
- **The executor decides which credential applies.** `DEPLOY_TARGETS` maps a
  project id and environment name to hosts and the NAMES of Wrangler secrets
  (`DEPLOY_CRED_*`). A pair with no entry is refused. The prefix is enforced so
  configuration cannot point at `CI_EXECUTOR_SECRET`.
- **The credential is attached by a third intercept handler**,
  `DeployCredentialProxy`, under the rules this ADR set for the repository
  proxy: scheme and exact hostname checked on the request itself, the upstream
  URL built from the configured host, any credential the container sent
  dropped, redirects neither followed nor passed back. Its props hold the
  secret's name; the value is read from the Worker's environment inside the
  handler, per request. So the value is never in a job, in Durable Object
  storage, in a dispatch, in a report or in a log.
- **A deploy job stops at its first failing step and reports once.** A CI job
  runs every step and reports each as a check. A deployment is one row in
  Stratum, so its job sends one signed report to `/api/deploy-reports/<id>`
  with each step's outcome, the recorded version and URL, and a log tail.
- **A deploy job checks out a commit, not a base plus a diff.** `prepare.sh`
  has a deploy mode that skips the diff and the tree comparison; git's own
  object ids are the proof that the checkout is the commit asked for. The mode
  is explicit, so a CI job without a tree id still refuses to run.

### Admission: priority, not a reservation

Deploy jobs go through the same coordinator, count against the same cap, and
hold a slot until their container is confirmed gone. The question was whether a
deploy may be queued behind CI jobs or needs its own slot. Neither:

- **Queued behind CI is wrong for the case that matters.** A rollback during an
  incident would wait behind every queued CI job, each up to the job limit.
  And a full CI queue would refuse a deploy outright.
- **A reserved slot is wrong for the common case.** The default cap is 2. A
  slot held for deploys halves CI's capacity all day for something that
  happens a few times a day, and raising the cap to compensate raises the
  operator's worst-case bill.

So a waiting deploy job takes the next slot that frees, ahead of waiting CI
jobs, and waits in its own bounded queue (`DEPLOY_MAX_QUEUED_JOBS`). The cap is
never exceeded and nothing is held idle. The cost is that a deploy can wait for
a running job to finish: at most the time left on the shortest one. Priority
cannot starve CI in practice, because Stratum serializes deploys per
environment and only a merge or a person starts one. An operator for whom that
wait is too long raises the cap by one, which is the reservation, chosen
knowingly.

### What separates a CI job from a deploy credential, and what does not

Stated exactly, because "separate profile" could be read as more than it is.

- **A CI job's container cannot reach a deploy credential.** No intercept
  registered for a CI job is the credentialed one: the machine that runs a CI
  job is built by `egressFor("ci")`, which has no factory for it, and the
  machine additionally refuses any job that names a credential unless the job's
  own profile is `deploy`. The tests assert both, against the job machine with
  a fake container, not by reading the code.
- **The two profiles are separate container applications and Durable Object
  classes, in ONE Worker.** Wrangler secrets are the Worker's, not a class's:
  `env.DEPLOY_CRED_*` is readable by any code in the executor Worker,
  including the code that serves CI jobs. The separation between the CI path
  and the credential is therefore the structure of this Worker's code, not a
  platform boundary. That is the same kind of statement this ADR made about
  the main Worker when it moved the executor out of it, and it is weaker than
  a separate Worker. It was chosen for #416 because the credential's exposure
  is to this Worker's own code, which no job can change, and not to anything a
  job runs.
- **The stronger form is a second deployment of this same Worker for
  deploys**, with `DEPLOY_TARGETS` and the `DEPLOY_CRED_*` secrets, and none on
  the one that runs CI. The executor needs no change for that. Stratum does: it
  reaches one executor today (`CI_EXECUTOR`), and would need a second binding
  for deploy dispatches. Not built; listed as a follow-up.
- **A deploy job's own steps act with the credential's authority.** They
  cannot read the token, but they can make any request to the credentialed
  host and it will be authorized. What a pipeline does is controlled by what
  merges, which is why the pipeline is read from the merged commit and
  `.stratum/ci.yaml` is protected configuration.

### Not verified

Everything here was tested against a fake `ctx.container` and against requests
built in tests. `wrangler deploy --dry-run` accepts the two-application
configuration and builds both images. Not run: a deploy job on a deployed
executor; HTTPS interception of a real Wrangler session against the Cloudflare
API (which hosts Wrangler contacts during `deploy` and `d1 migrations apply`
besides `api.cloudflare.com` is not documented in one place, and a host not on
the allowlist will fail there first); `wrangler rollback` through the
intercept.
