# Reviews and Comments API

Comment threads and human review verdicts on a change. See the
[Code Review user guide](../../user-guide/code-review.md) for the concepts, and
the [OpenAPI specification](../openapi.yml) for exact schemas.

## Add a Comment
`POST /api/changes/{id}/comments`

Read access to the project is enough — users **and agents** may comment.
`body` max 20,000 chars.

```json
{ "body": "…", "file": "src/x.ts", "line": 214, "side": "new", "commitSha": "a1b2…" }
```

- `file` and `line` must be passed **together** to anchor the comment to a diff
  line. `line` is 1-based.
- `side` (`old` | `new`) and `commitSha` are accepted **only** alongside a
  `file`+`line` anchor.
- `parentCommentId` posts a reply into an existing thread. The parent must
  belong to the same change, replies inherit the thread's anchor (so anchor
  fields must be omitted), and a reply to a reply is flattened onto the thread
  root.

## List Comments
`GET /api/changes/{id}/comments`

## Resolve a Thread
`POST /api/changes/{id}/comments/{commentId}/resolve`

## Unresolve a Thread
`POST /api/changes/{id}/comments/{commentId}/unresolve`

Allowed for **project writers or the comment's author**. Only a thread *root*
can be resolved — resolving a reply is refused. Resolution is bookkeeping and
does not gate a merge.

## Submit a Review
`POST /api/changes/{id}/reviews`

**Users only** — agent tokens are refused, on every surface. Requires **write**
access to the project. Valid on changes in `open`, `needs_changes`,
`accepted`, or `approved`.

```json
{ "verdict": "approve", "comment": "…" }
```

| `verdict` | Effect |
|---|---|
| `approve` | Change → `approved`; counts toward `requiredApprovals` |
| `request_changes` | Change → `needs_changes` |
| `comment` | Comment-only; status untouched |

A `comment` verdict **requires** a non-empty `comment` (else `400`). It never
counts toward required approvals, never blocks a merge, and never replaces an
existing `approve`/`request_changes` verdict by the same reviewer — a verdict
row is recorded only if that reviewer has none yet. Its text is written to the
change's discussion and emits `change.commented`.

The response carries `changeStatus`: the new status after an
`approve`/`request_changes`, or the unchanged status after a `comment`.

The **change author's own approval never counts** toward `requiredApprovals`;
for an agent-created change the excluded author is the agent's owning user.

## List Reviews
`GET /api/changes/{id}/reviews`
