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

One fresh container per job, started by a Durable Object, destroyed when the
job ends. Nothing is reused between jobs: no filesystem, no process, no cache
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
  from the change's head, so a change cannot rewrite its own gate. It joins
  `.stratum/policy.yaml` in `PROTECTED_CONFIG_FILES`.
- **Reconstructed, then verified.** The job clones at `baseSha`, applies the
  diff, and checks that the resulting tree is the tree of `headSha` before any
  step runs. A mismatch fails the job. What ran is then exactly what will merge.
- **One check per step.** Each step reports through the #414 callback. A step
  that never reports is caught by the check's deadline, so a hung or killed job
  cannot leave a change mergeable.
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
  for CPU actually used. A hosted instance needs per-project limits before this
  is offered to anyone but the project itself.
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
- Per-project concurrency and monthly usage limits.
