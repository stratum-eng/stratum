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
  runs. Stratum's own project has to make this choice before it gates on the
  executor.
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
    path that moves the default branch. There are three, and they differ: the
    plain merge goes through a per-project Durable Object, where the comparison
    can move inside the serialized step; a squash merge does not go through
    that object; and a batch merge compares each of its changes with the head
    it read at the start, so every change after the first is judged against a
    head the batch has itself already moved. Until all three are covered the
    window exists.
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
- Making the fresh-base comparison atomic with the ref update on all three
  merge paths: plain, squash, and each item of a batch.
- Whether to test the proposed merge tree (base tip plus the change) instead
  of the change's head, which would remove the dependence on
  `requireFreshBase`.
