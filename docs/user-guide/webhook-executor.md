# Running a Webhook Evaluator Executor Safely

The [webhook evaluator](ci-integration.md#the-webhook-evaluator-contract) hands
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
- **The request itself.** When the policy entry sets `secretRef`, Stratum signs
  the body with HMAC-SHA256 using the named project secret, which lives in
  Stratum's encrypted secret store and not in the repository. A good signature
  then tells you Stratum sent the body. The deprecated literal `secret` field
  does not: it is written in `.stratum/policy.yaml`, so **anyone with read
  access to the repository** — including the code under evaluation, which
  carries a copy of the policy — can compute a valid signature, and a good one
  only tells you the sender knew the repository's contents. Without either
  field, nothing is signed. See
  [the signing secret](ci-integration.md#the-signing-secret).
- **`baseSha`** is meant to be the commit the diff was computed against, but it
  is just a string in the body. Resolve it only in a repository you trust, never
  by fetching from anywhere the payload suggests. Accept it only if it is a full
  object id that exists locally **and is a commit**: check the object type, for
  example with `git cat-file -t`. A tree, blob, or tag id must be rejected, not
  peeled or guessed at.
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
- **A fresh worktree** materialized from your mirror at `baseSha`, **without
  the mirror's `.git`**. Do not mount the mirror into the executor, even
  read-only. Its repository-local config (`remote.*.url` with embedded
  credentials, `http.extraHeader`, `credential.helper`, command-valued settings)
  is readable there and can hand the executor whatever the receiver uses to
  fetch. Export the tree on the trusted side, and export it **exactly**: every
  tracked path, file mode and blob byte at `baseSha`, nothing else. The usual
  shortcuts are not exact. `git archive` honours the commit's own
  `export-ignore` and `export-subst` attributes, so the repository being
  evaluated decides which paths, including tests, are left out and which
  contents are rewritten. `git checkout` / `git worktree` run `.gitattributes`
  filters and line-ending conversion. Instead, write the tree at the object
  level: walk it with `git ls-tree -rz <baseSha>` and write each blob with
  `git cat-file blob <oid>`, or use a Git library's raw tree and blob reads,
  then compare the result against the tree before applying the diff. If the
  executor needs Git, initialize a new repository inside it
  that has no remotes and no credentials. A writable shared object store would
  also let one change plant objects or refs that a later evaluation reads.
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
| When evaluation runs | for `POST /api/projects/:name/changes` and `POST /api/changes/:id/evaluate`, in a queue consumer after the request has returned, or inside the request if `EVALUATION_QUEUE` is unbound or the send fails. A gated `git push` always evaluates inside its own request |
| Ordering | every evaluator in the policy starts **concurrently** (`Promise.all` in `runEvaluation`, `src/services/change-flow.ts`), so the run waits for the slowest one plus overhead. Several webhook entries' timeouts overlap and do not add up. `checks` entries are not part of this: they are not scored evaluators. They are dispatched **after** the verdict is recorded, one entry after another, and each waits only for its endpoint to acknowledge the request, never for the checks to finish. See [Check runs](checks.md) |
| On timeout | Stratum aborts its fetch, and the evaluator returns an external-service error. `runEvaluation` records that as a **failed evaluation** (score 0, reason `Webhook error: <abort message>`) and it counts against the gate like any failing verdict. The recorded reason is Stratum's abort message, not anything your receiver said |
| Retries | none — a re-run is an explicit re-evaluation |
| Cap on the request body Stratum sends | **none** — size is bounded only indirectly (a workspace commit body is capped at 32 MiB, a `git push` request at 50 MiB, and a change can span several commits) |

What that means for the receiver:

- **Cap the body yourself** before reading it fully, at a size your executor can
  handle well within the deadline. Reject larger requests with `413` — any
  non-2xx is recorded as a failed evaluation, which is the right outcome.
- **Set a wall-clock deadline below `timeoutMs`** — leave margin for TLS, the
  checkout, and the response — and when it fires, kill the executor and answer
  `200` with a complete verdict:
  `{"score": 0, "passed": false, "reason": "deadline exceeded"}`. Stratum
  requires a finite numeric `score` and a boolean `passed`. A response missing
  either is treated as unusable and fails closed with a generic reason. A
  timeout on Stratum's side is also recorded as a failure, but its reason is
  only Stratum's abort message. Answering first puts your reason on the change,
  and it means you have stopped the executor rather than leaving it running
  after Stratum has given up.
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
  the executor's environment, not in its filesystem, not through `/proc`. Use
  `secretRef` so the key is stored as a project secret and never appears in the
  repository: then process isolation is what keeps it secret. If the policy
  still uses the deprecated literal `secret`, the evaluated checkout already
  contains it and isolation cannot protect it — move it to `secretRef` and
  rotate it, since the old value remains in git history.

## Git-specific hazards

Applying a diff and building the result involves Git in ways that can execute
code from the repository:

- **Apply the diff inside the executor**, as its unprivileged user, never in the
  receiver. Require a Git release patched for
  [CVE-2023-23946](https://github.com/git/git/security/advisories/GHSA-r87m-v37r-cwfh),
  in which `git apply` could be made to write outside the working tree through a
  symbolic link the patch itself introduces. That means 2.39.2 or later, a
  maintenance release that carries the fix (listed in the advisory), or a
  distribution package whose vendor confirms the backport. Then keep up with
  later Git security releases. `git apply` also refuses paths inside `.git/`.
- **`.gitattributes` filters and drivers.** A repository can declare
  `filter=<name>`, `diff=<name>`, or `merge=<name>` on any path. They run a
  command only if `filter.<name>.smudge`/`clean` (or the matching driver) is
  defined in Git config — and tools define them globally: `git lfs install`
  writes an LFS filter into `~/.gitconfig`. In the executor, set
  `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` and use the fresh
  `HOME` above. These variables disable only the system and global files. Git
  still reads the repository's own `.git/config`, which is why that file must
  be one the executor created and not the mirror's (see
  [Filesystem isolation](#filesystem-isolation-per-evaluation)).
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
  ([ADR 007](../adr/007-sandbox-evaluator-threat-model.md)); do the same unless
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
as the OCI runtime. gVisor puts a user-space kernel between the suite and the
host kernel, which shrinks the host's exposed system-call surface. It is an
additional boundary, **defense in depth**. It does not guarantee that an
exploit stays contained, so the host hardening, unprivileged user, and resource
limits below remain mandatory. The properties to configure, each of which maps to a
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
- [ ] Each evaluation gets a fresh `HOME` and worktree. The tree is exported
      from the mirror without its `.git`, and the mirror is never mounted into
      the executor.
- [ ] Exactly one teardown path kills every executor process and deletes its
      state, on success, failure, and deadline.
- [ ] The receiver caps the body size, enforces a deadline shorter than
      `timeoutMs`, returns a failing verdict when it fires, and rejects with
      `503` when at capacity instead of queueing.
- [ ] The executor has memory, CPU, process-count, disk, and output limits.
- [ ] No receiver-held credentials are present in the executor: no mirror,
      registry, cloud, or reporting credentials, and no copy of the webhook
      secret from the receiver's environment. Cloud metadata endpoints are
      unreachable from it.
- [ ] The policy signs with `secretRef`, not a literal `secret`; any value that
      was ever a literal in `.stratum/policy.yaml` has been rotated.
- [ ] Git in the executor runs with no system or global config; nothing on the
      trusted side runs Git against a tree evaluated code has touched;
      `safe.directory` is not wildcarded; submodules are not fetched.
- [ ] Egress is denied by default, with any exceptions limited to what the suite
      needs, and private ranges always blocked.
- [ ] `baseSha` is resolved only in the mirror of the repository this receiver
      URL is bound to and must be a commit. Requests whose `baseSha` is missing,
      unknown, or not a commit are rejected.
- [ ] The receiver is behind TLS you terminate, and runs with least privilege
      itself.

## See also

- [CI Integration](ci-integration.md) — the webhook evaluator contract and the
  timeout constraint
- [ADR 007: Sandbox Evaluator Threat Model](../adr/007-sandbox-evaluator-threat-model.md)
  — the same problem, for Stratum's own sandbox evaluator
