---
title: "Running a Webhook Evaluator Executor Safely"
description: "Run a webhook evaluator's executor safely: process, filesystem, and network isolation, resource and time bounds, credential hygiene, Git hazards, and reference setups."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/webhook-executor.md"
---

The [webhook evaluator](/guides/ci-integration/#the-webhook-evaluator-contract) hands
your endpoint a diff and a base commit and asks for a verdict. Producing that
verdict usually means checking out the base, applying the diff, and running a
build or test suite. **That is executing code chosen by whoever authored the
change** — an agent, or anyone who can push to a workspace — before any human
has reviewed it. This page covers how to do that without handing the author your
receiver, your credentials, or your other evaluations.

It is architecture guidance, not a receiver you can paste. That is deliberate:
an earlier version of the CI guide shipped a copyable Node receiver, and five
review rounds found that the safety problems lived in the process, filesystem,
and network boundaries around it, which a snippet cannot carry. The checklist at
the end is the part to hold your implementation to.

## The threat model

Treat every part of an evaluation request as attacker-controlled:

- **The diff** is arbitrary file content at arbitrary paths. Applying it is a
  file-write primitive; running the result is code execution.
- **The request itself.** When the policy sets a `secret`, Stratum signs the
  body with HMAC-SHA256 — but the `secret` is a literal in
  `.stratum/policy.yaml`, so anyone who can read the repository can compute a
  valid signature. A good signature tells you the sender knew the repository's
  contents, not that Stratum sent it. Without a `secret`, nothing is signed.
- **`baseSha`** selects which commit to build. It can name any object, so it must
  be resolved against a repository you trust, never fetched from anywhere the
  payload suggests.
- **`policy`** is parsed from the repository. Any field your receiver reads from
  it — a command, a timeout — is chosen by people who can edit that file.

The payload also carries **no project identity**: the body is `diff`, `policy`,
and `baseSha` only. Bind each receiver URL (or a path segment in it) to exactly
one repository, and resolve `baseSha` only in that repository's mirror.

## Split the receiver from the executor

Run two things with different privileges:

```text
             HTTPS (TLS terminated in front)
Stratum ───────────────────────────────▶  Receiver  (trusted, long-lived)
                                           • verifies signature, size, baseSha
                                           • holds the webhook secret + mirror creds
                                           • enforces deadline and concurrency
                                           • spawns one executor per request
                                                │  inputs: base tree + diff, nothing else
                                                ▼
                                          Executor  (untrusted, disposable)
                                           • own user, PID, mount, network namespaces
                                           • fresh HOME and worktree
                                           • no credentials, restricted egress
                                           • destroyed after one evaluation
                                                │  output: exit status + capped log
                                                ▼
                                          Receiver answers {score, passed, reason}
```

The receiver never runs the change's code and never touches the executor's
filesystem after the change's code has run. The executor never sees anything
the receiver holds.

## Process isolation

**Run the executor as a different user, in a separate PID namespace.** The
specific failure this prevents: a test suite running as the receiver's user can
read `/proc/<receiver-pid>/environ` and recover `STRATUM_WEBHOOK_SECRET` and
every other variable the receiver was started with. The same access exposes
`/proc/<pid>/cmdline`, open file descriptors under `/proc/<pid>/fd`, and — where
`ptrace` is allowed — the receiver's memory.

**An environment allowlist for the child does not fix this.** Clearing the
child's environment controls what the child *inherits*; it does nothing about
what the child can *read* from its parent through `/proc`. Only a boundary does:

- a different, unprivileged UID — `/proc/<pid>/environ` is readable only by the
  process owner — and
- a separate PID namespace, so the receiver's processes are not visible at all.

Then close the rest of the gap a namespace leaves open:

- **Filesystem.** Secrets in files are as reachable as secrets in the
  environment. Do not mount the receiver's working directory, `.env` files, or
  home directory (`~/.git-credentials`, `~/.npmrc`, `~/.docker/config.json`,
  `~/.config/gh`, cloud CLI profiles) into the executor.
- **Privilege.** Drop all capabilities, set `no_new_privs`, and keep the default
  seccomp profile (or stricter). Never run the executor as root, and never give
  it the container runtime socket.
- **Network namespace.** If the executor shares the receiver's network
  namespace it can reach anything bound to `localhost` — admin ports, metrics,
  a local Docker API. Give it its own.

## Filesystem isolation per evaluation

Every request gets its own state, and nothing survives it:

- **A fresh `HOME`** — an empty, size-limited tmpfs, so tool configuration,
  caches, and credentials from a previous run (or from the host) are not
  inherited, and nothing a change writes there is seen by the next one.
- **A fresh worktree** checked out from your mirror at `baseSha`. If the mirror
  is shared between evaluations, mount it **read-only** into the executor or
  copy from it; a writable shared object store lets one change plant objects or
  refs that a later evaluation reads.
- **Unique names.** Create per-request directories with random names, not
  names derived from the request, so two concurrent evaluations cannot collide
  and a crafted request cannot point at another's directory.
- **Once-only cleanup.** Give exactly one code path ownership of teardown — a
  `--rm` container, a destroyed VM, or a single `finally` — and make it
  idempotent. It must run on success, failure, *and* deadline, and it must kill
  every process in the sandbox (the whole cgroup or VM, not one PID) **before**
  removing files. A test that forks a background process must not outlive its
  evaluation and wait for the next one.

## Resource and time bounds

The verdict has to arrive inside Stratum's request window, so bounds are a
correctness requirement as well as a safety one. The numbers on Stratum's side
(`src/evaluation/webhook-evaluator.ts`, `src/evaluation/policy-loader.ts`):

| Fact | Value |
|------|-------|
| Default `timeoutMs` | 10,000 ms |
| Allowed `timeoutMs` | clamped to 1,000–120,000 ms |
| When evaluation runs | synchronously, inside the request that triggered it — for example `POST /api/projects/:name/changes`, `POST /api/changes/:id/evaluate`, and a gated `git push` |
| Ordering | evaluators run **one after another** in that request, so two webhook entries' timeouts add up, alongside any other evaluators |
| On timeout | Stratum aborts the request; the evaluation errors (it is not recorded as your verdict) |
| Retries | none — a re-run is an explicit re-evaluation |
| Cap on the request body Stratum sends | **none** — size is bounded only indirectly (a workspace commit body is capped at 32 MiB, a `git push` request at 50 MiB, and a change can span several commits) |

What that means for the receiver:

- **Cap the body yourself** before reading it fully, at a size your executor can
  handle well within the deadline. Reject larger requests with `413` — any
  non-2xx is recorded as a failed evaluation, which is the right outcome.
- **Set a wall-clock deadline below `timeoutMs`** — leave margin for TLS, the
  checkout, and the response — and when it fires, kill the executor and answer
  `200` with `"passed": false` and a reason such as `"deadline exceeded"`. A
  verdict you return is recorded and readable on the change; a request Stratum
  had to abort is only an error.
- **Bound concurrency, and reject rather than queue.** Hold a fixed number of
  executor slots. When they are all busy, answer `503` immediately. A queued
  request would spend its window waiting and time out anyway; an immediate
  failure is visible, and a re-evaluation clears it once capacity frees up.
- **Limit the executor's resources**: memory, CPU, a process count (a fork bomb
  is one line of test code), disk via a size-limited tmpfs, and output — read
  at most a fixed number of bytes of its log into `reason`.
- **Spawn asynchronously.** The receiver must keep serving (and keep its own
  deadline timers running) while executors work; one slow evaluation must not
  stall another's response.

## Credential hygiene

- **No ambient credentials in the executor.** No environment variables, files,
  instance roles, or mounted sockets that grant anything. If your mirror needs
  credentials to fetch, the receiver fetches; the executor only ever sees a
  checked-out tree.
- **No reachable cloud metadata endpoint.** Block `169.254.169.254`,
  `fd00:ec2::254`, and `metadata.google.internal` at the network layer for the
  executor. On a cloud VM, a process that can reach the metadata service can
  usually obtain the instance's role credentials.
- **The webhook secret must never be reachable from evaluated code** — not in
  the executor's environment, not in its filesystem, not through `/proc`. Be
  clear about what this does and does not buy today: because the `secret` is a
  literal in `.stratum/policy.yaml`, the evaluated checkout already contains it.
  Process isolation protects *everything else* the receiver holds (mirror
  credentials, any tokens it uses to report or fetch) and keeps your design
  correct for when the secret moves out of the policy file. Do not let the
  secret's current exposure become a reason to relax the boundary.

## Git-specific hazards

Applying a diff and building the result involves Git in ways that can execute
code from the repository:

- **Apply the diff inside the executor**, as its unprivileged user, never in the
  receiver. Use a current Git: `git apply` refuses paths inside `.git/`, and
  current releases also refuse to write through a symbolic link the patch
  itself introduces (CVE-2023-23946 was exactly that escape).
- **`.gitattributes` filters and drivers.** A repository can declare
  `filter=<name>`, `diff=<name>`, or `merge=<name>` on any path. They run a
  command only if `filter.<name>.smudge`/`clean` (or the matching driver) is
  defined in Git config — and tools define them globally: `git lfs install`
  writes an LFS filter into `~/.gitconfig`. Run Git in the executor with an
  empty config: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and the
  fresh `HOME` above.
- **Hooks and `core.hooksPath`.** A dependency's install step can point
  `core.hooksPath` at a directory in the repository (husky does exactly this in
  `prepare`), after which any `git commit` in that tree runs repository-controlled
  scripts. Inside the executor that is just more untrusted code. The danger is
  the next point.
- **After untrusted code has run, the worktree and its `.git` are hostile.**
  The suite can rewrite `.git/config` to set `core.fsmonitor` (runs on
  `git status`), `core.pager`, `core.sshCommand`, `core.editor`, aliases, or
  hooks. The receiver must never run Git — or any tool that shells out to Git —
  against that directory to collect results. Take the exit status and capped
  output, then destroy it.
- **`safe.directory`.** Git refuses to operate on a repository owned by another
  user. The fix is to run Git as the user that owns the tree, inside the
  executor — not to set `safe.directory = *` on the trusted side, which turns off
  the protection that stops the previous hazard.
- **Submodules.** Do not recurse into submodules. `.gitmodules` URLs are
  repository-controlled and can name internal hosts, `file://` paths, or
  transports such as `ext::`; leave `protocol.allow` at its restrictive
  defaults.

## Network egress

Default to **no network** for the executor, then add only what the suite
genuinely needs:

- **Dependencies.** The diff can change the lockfile, so "install what the
  lockfile says" is attacker-directed fetching. Either run offline against a
  read-only dependency cache built from the base (and fail changes that alter
  dependencies, with a reason that says so), or allow egress only to a
  registry proxy you control that enforces an allowlist.
- **Install scripts.** Package lifecycle scripts are code from the dependency
  tree. Stratum's own sandbox evaluator installs with `--ignore-scripts` by
  default for this reason
  ([ADR 007](https://github.com/stratum-eng/stratum/blob/main/docs/adr/007-sandbox-evaluator-threat-model.md)); do the same unless
  the build needs them.
- **Always block** private ranges (RFC 1918, loopback, link-local, CGNAT), the
  metadata addresses above, internal DNS names, and the receiver's own host.
  Stratum applies the same class of filter to the URL it calls you on.

## Reference setups

Any of these can satisfy the checklist below; each lists what you still have to
supply.

### A CI system you already trust for untrusted builds

The receiver does validation, then triggers a job on CI infrastructure you
already operate for untrusted contributions — ephemeral, single-use runners
that are destroyed after each job — and waits for the result.

- **You inherit** the runner's isolation, cleanup, and egress policy, which
  someone has presumably already reviewed.
- **You supply** the synchronous bridge: the receiver must trigger, poll, and
  answer within `timeoutMs`. Hosted CI queue and boot times usually exceed the
  10 s default, so raise `timeoutMs` toward its 120 s ceiling and keep a pool of
  pre-warmed runners.
- **Check** that the job receives no repository or deploy secrets — CI systems
  often grant them to jobs by default — and that runners really are single-use.

### A rootless container per request, under a user-space kernel

One container per evaluation, run by a rootless runtime with gVisor (`runsc`)
as the OCI runtime, so a kernel exploit from the suite lands in gVisor's kernel
rather than the host's. The properties to configure, each of which maps to a
flag in Docker or Podman:

| Property | Setting |
|----------|---------|
| User-space kernel | `--runtime=runsc` |
| Own PID, mount, IPC, UTS namespaces | container defaults — do not pass `--pid=host`, `--ipc=host`, or `--network=host` |
| Unprivileged user | `--user` set to a non-root UID; rootless runtime on the host |
| No privileges | `--cap-drop=ALL`, `--security-opt=no-new-privileges` |
| Read-only image, tmpfs scratch | `--read-only`, size-limited `--tmpfs` for `HOME` and the worktree |
| Resource limits | `--memory`, `--cpus`, `--pids-limit` |
| Network | `--network=none`, or a dedicated network whose egress is filtered as above |
| Disposal | `--rm`, plus a receiver-side kill of the container at the deadline |
| No credentials | no `-e` secrets, no `-v` mounts of host config, no runtime socket |

Pre-pull the image and keep it small; container start time comes out of the
same `timeoutMs` budget as the suite.

### A microVM per request

Firecracker (directly, or via Kata Containers or firecracker-containerd) gives
each evaluation its own guest kernel behind a hardware virtualization boundary.
Snapshot-restore a booted VM with the toolchain installed to keep start-up
inside the deadline. You still supply everything above that is not about the
kernel: the empty Git config, a guest with no credentials, an egress policy on
the VM's tap device, and teardown on deadline.

### Not a reference setup

A process spawned directly by the receiver, as the receiver's user, with a
trimmed environment. It fails the first requirement on this page, and
everything after it inherits that failure.

## Deployment shape

- **TLS terminated in front** of the receiver by a proxy or load balancer you
  control, and an `https://` URL in the policy. Stratum accepts `http://`, but
  the body carries the diff.
- **The receiver itself is least-privileged:** an ephemeral container or VM
  with only the secret, read access to the mirror, and the ability to start
  executors. It should not hold deploy keys or broad cloud credentials, because
  it parses attacker-supplied input.
- **One receiver URL per repository**, since the payload does not say which
  project it is about.

## Checklist

Before pointing a policy's `webhook` evaluator at your executor:

- [ ] Evaluated code runs as a different UID, in its own PID, mount, and network
      namespaces — not merely with a filtered environment.
- [ ] Nothing the receiver holds (environment, files, sockets, `localhost`
      services) is reachable from the executor.
- [ ] Each evaluation gets a fresh `HOME` and worktree; a shared mirror is
      read-only to the executor.
- [ ] Exactly one teardown path kills every executor process and deletes its
      state, on success, failure, and deadline.
- [ ] The receiver caps the body size, enforces a deadline shorter than
      `timeoutMs`, returns a failing verdict when it fires, and rejects with
      `503` when at capacity instead of queueing.
- [ ] The executor has memory, CPU, process-count, disk, and output limits.
- [ ] No credentials are present in the executor, and cloud metadata endpoints
      are unreachable from it.
- [ ] Git in the executor runs with no system or global config; nothing on the
      trusted side runs Git against a tree evaluated code has touched;
      `safe.directory` is not wildcarded; submodules are not fetched.
- [ ] Egress is denied by default, with any exceptions limited to what the suite
      needs, and private ranges always blocked.
- [ ] `baseSha` is resolved only in the mirror of the repository this receiver
      URL is bound to, and requests whose `baseSha` is missing or unknown are
      rejected.
- [ ] The receiver is behind TLS you terminate, and runs with least privilege
      itself.

## See also

- [CI Integration](/guides/ci-integration/) — the webhook evaluator contract and the
  timeout constraint
- [ADR 007: Sandbox Evaluator Threat Model](https://github.com/stratum-eng/stratum/blob/main/docs/adr/007-sandbox-evaluator-threat-model.md)
  — the same problem, for Stratum's own sandbox evaluator
