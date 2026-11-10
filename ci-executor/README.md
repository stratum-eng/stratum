# Stratum CI executor

Stratum's first-party CI executor ([#415](https://github.com/stratum-eng/stratum/issues/415),
[ADR 012](../docs/adr/012-ci-executor-runtime.md)): a Cloudflare Worker that
runs each job from a project's `.stratum/ci.yaml` in a fresh
[Cloudflare Container](https://developers.cloudflare.com/containers/) and
reports every step back to Stratum as a check run.

It is a **separate Worker from Stratum on purpose**. It runs code from changes
nobody has reviewed yet, so it is deployed with nothing worth stealing: no D1,
no KV, no Artifacts binding, no deploy credential, and no binding back to
Stratum. It holds one shared secret, one R2 bucket for logs, and its own two
Durable Object classes.

- **Using it** (the `.stratum/ci.yaml` format, what a job can and cannot do):
  [docs/user-guide/ci.md](../docs/user-guide/ci.md)
- **Deploying it** (every command, secret and binding, in order):
  [docs/user-guide/ci.md#self-hosting-deploy-the-executor](../docs/user-guide/ci.md#self-hosting-deploy-the-executor)

Licensed AGPL-3.0-or-later, like the Stratum server it is part of (see
[LICENSING.md](../LICENSING.md)).

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | The Worker: `POST /jobs`, `GET /logs/:checkRunId`, `GET /health` |
| `src/signature.ts` | HMAC-SHA256 sign and constant-time verify |
| `src/dispatch.ts` | Validation of a job dispatch against this deployment's limits |
| `src/admission.ts`, `src/coordinator.ts` | The concurrency cap and bounded queue: pure rules, and the one Durable Object that applies them |
| `src/job.ts`, `src/job-object.ts` | One job's state machine, and the Durable Object that owns its container |
| `src/egress.ts` | The two intercept handlers: everything a container can reach |
| `src/logs.ts`, `src/report.ts` | Serving logs to Stratum; reporting steps to Stratum |
| `container/` | The job image: `Dockerfile`, the in-container supervisor (`agent.mjs`) and the checkout script (`prepare.sh`) |

## Working on it

```bash
npm install
npm run typecheck
npm test
npm run lint
```

The suite needs `git` and `bash` on the PATH: `tests/container.test.ts` runs
the real `agent.mjs` and `prepare.sh` against a fixture repository.

To run it locally you need Docker running:

```bash
echo 'CI_EXECUTOR_SECRET=<32+ characters>' > .dev.vars
npx wrangler dev --var STRATUM_ORIGIN:http://localhost:8787
```

Wrangler is pinned to an exact version. The `durable_object` Containers
scheduling policy this Worker depends on is in public beta; upgrade Wrangler
deliberately, and re-run a job under `wrangler dev` when you do.

## What is not tested here

The unit suite runs the job state machine against a fake `ctx.container`
written from Cloudflare's documented API (`tests/helpers/fake-container.ts`),
and the intercept handlers against requests built in the test. That proves the
logic, not the platform. Not covered by any automated test:

- a real container started by a deployed executor, and its limits;
- HTTPS interception as Cloudflare performs it (the trust store, DNS for
  intercepted hosts, the `Host`-versus-SNI behaviour the handlers defend
  against);
- a fetch from a real Artifacts repository through the proxy;
- R2 and Durable Object behaviour under load, eviction or deploy.
