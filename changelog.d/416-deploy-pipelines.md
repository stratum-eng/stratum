### Added
- **Deploy pipelines: build, migrate, and deploy to staged environments (#416).**
  A project can now declare a `deploy:` section in `.stratum/ci.yaml`: an
  ordered list of environments, each with its own steps — install, apply
  database migrations, deploy, smoke test. When a change merges, Stratum's CI
  executor checks out the merged commit and runs the first environment's steps;
  each later environment is deployed only after the one before it succeeded,
  and an environment marked `requiresApproval: true` waits for a person first.
  A step that fails stops the pipeline: nothing after it runs and nothing is
  promoted. Deployments of one environment never run at the same time, and a
  later merge is never overtaken by an earlier one. See the *Deployments* guide.
- **Deploy credentials for a pipeline are never stored in Stratum.** They live
  in the CI executor's own secret store, are scoped to one project, one
  environment and one hostname, and are attached to a deploy job's requests
  outside the job's container — the job, and Stratum's database, never hold
  them. A CI job, which runs unreviewed code, cannot obtain them.
- **Rollback.** Every successful deployment records the **version** it put
  live (for a Cloudflare Worker, its version id), and its page has a *Roll back
  to this deploy* action, also at `POST /api/deployments/:id/rollback`. It is
  restricted to the people who may approve a deployment, asks for confirmation
  on a page that works without JavaScript, is recorded in the audit log, and
  waits its turn like any other deployment. **A rollback redeploys an earlier
  version; it does not undo a database migration** — migrations are
  forward-only. Rollback works for the existing static `deploys:` targets too,
  where it publishes the earlier commit again.
- A pipeline deployment's full step log is available to project writers from
  its page and at `GET /api/deployments/:id/log`.
- Deployments gain two fields in the API: `version` and `rollbackOf`, and a new
  `target` value, `pipeline`.
- Self-hosters: pipelines need the **CI executor** (`ci-executor/`) redeployed
  from this release, with a `DEPLOY_TARGETS` variable naming each project and
  environment it may deploy and a Wrangler secret per credential
  (`DEPLOY_CRED_…`). The *Deployments* guide lists every step. Stratum itself
  needs migration `079_deployment_pipelines.sql` (two nullable columns and one
  index), `APP_URL`, and the deploy queue it already uses. An instance that
  does none of this behaves as before; the existing static `deploys:` targets
  are unchanged.

### Changed
- **A batch merge now deploys.** `POST /api/projects/:name/changes/merge-batch`
  used to deploy nothing. It now triggers one deploy for the whole batch, of
  the commit the batch left the default branch at, recorded against the last
  change that landed. This applies to static `deploys:` targets as well as
  pipelines; a project that batch-merges and has deploys configured will see
  deployments it did not get before.
- A `.stratum/ci.yaml` may contain a `deploy:` section. A file with a `deploy:`
  section and no `steps` is accepted and declares no CI steps.
