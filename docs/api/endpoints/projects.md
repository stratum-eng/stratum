# Projects API

## List Projects
`GET /api/projects`

## Create Project
`POST /api/projects`

## Get Project
`GET /api/projects/{namespace}/{slug}`

## Import from GitHub
`POST /api/projects/{namespace}/{slug}/import`

## Delete Project
`DELETE /api/projects/{namespace}/{slug}`

Permanently deletes a project and **all** associated data (repo + workspace
forks, changes, issues, events, metrics, webhooks). **Owner-only.** The request
body must confirm the exact path:

```json
{ "confirm": "@namespace/slug" }
```

Returns `202 Accepted` with `{ "status": "deleting", "jobId": "del_…" }` — the
cascade runs asynchronously and is idempotent/resumable. A mismatched `confirm`
returns `400`; a non-owner returns `404`.
