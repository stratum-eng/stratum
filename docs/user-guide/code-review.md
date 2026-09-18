# Code Review

Stratum's merge gate decides whether a change *may* land. Code review is how
people say whether it *should*. The two are independent: a change can be green
on every evaluator and still sit unapproved, and no amount of approval lets a
change past a failing required evaluator.

Everything here works on a change, from the change page in the web UI or
through the API.

## Comment threads

A comment is either **floating** — attached to the change as a whole — or
**anchored** to a line of the diff.

```bash
# A floating comment on the change
curl -X POST https://app.usestratum.dev/api/changes/chg_123/comments \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"body": "Worth a follow-up issue, not a blocker."}'
```

To anchor a comment to a line, pass `file` and `line` together. `line` is
1-based. `side` (`old` or `new`) picks which half of the diff the line belongs
to, and `commitSha` records the commit the anchor was taken against — both are
accepted only alongside a `file`+`line` anchor.

```bash
curl -X POST https://app.usestratum.dev/api/changes/chg_123/comments \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
        "body": "This retries on a 4xx — the circuit breaker will trip on client errors.",
        "file": "src/github/client.ts",
        "line": 214,
        "side": "new",
        "commitSha": "a1b2c3d4..."
      }'
```

Anyone who can **read** the project may comment — including agents. Comments
are capped at 20,000 characters.

### Replies

Passing `parentCommentId` posts a reply into an existing thread:

- The parent must belong to the same change.
- Replies inherit the thread's anchor, so the anchor fields must be omitted.
- Replies to replies are flattened onto the thread root — threads are one
  level deep, not a tree.

```bash
curl -X POST https://app.usestratum.dev/api/changes/chg_123/comments \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"body": "Good catch — fixed in the next commit.", "parentCommentId": "cmt_456"}'
```

### Resolving a thread

```bash
curl -X POST https://app.usestratum.dev/api/changes/chg_123/comments/cmt_456/resolve \
  -H "Authorization: Bearer stratum_user_xxxxx"
```

`POST .../unresolve` reopens it. Two rules are worth knowing:

- Only **project writers or the comment's author** may resolve a thread, so a
  reader cannot quietly close feedback they received.
- Only a **thread root** can be resolved. Resolving a reply is refused —
  resolution is a property of the conversation, not of an individual message.

Resolving is bookkeeping, not a gate: an unresolved thread does not block a
merge. Use `request_changes` for that.

## Review verdicts

A review is a verdict on the whole change:

```bash
curl -X POST https://app.usestratum.dev/api/changes/chg_123/reviews \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"verdict": "approve", "comment": "Reads well, tests cover the retry path."}'
```

| Verdict | Effect on the change |
|---|---|
| `approve` | Moves the change to `approved`; counts toward `requiredApprovals`. |
| `request_changes` | Moves the change to `needs_changes`; blocks the merge. |
| `comment` | Records the text in the discussion. Status untouched. |

Submitting a verdict requires **write** access to the project — commenting only
needs read access, but a verdict moves the change's state. Only open,
`needs_changes`, `accepted`, or `approved` changes can be reviewed.

### Comment-only reviews

`{"verdict": "comment"}` is for saying something substantive without taking a
position. It requires a `comment` (an empty one is a `400`), and it is
deliberately inert:

- It **never counts toward required approvals** and never blocks a merge.
- It **never replaces an existing verdict** by the same reviewer. If you have
  already approved or requested changes, a later comment-only review leaves
  that verdict standing — a verdict row is only recorded when you have none
  yet.

The body lands in the change's append-only discussion rather than in the
verdict row, which is why it survives alongside a verdict you gave earlier.
It emits `change.commented`, so activity feeds and webhook subscribers see it
like any other comment.

## Reviews are human-only

`POST /api/changes/{id}/reviews` rejects agent tokens on every surface. An
agent can read a diff, comment on it, and anchor those comments to lines — but
it cannot approve, and it cannot clear `requiredApprovals`. This is the
human-approval invariant described in
[Getting Started](getting-started.md#the-human-approval-invariant), and it is
enforced in the route, not in the UI.

Separately, the **change author's own approval never counts** toward
`requiredApprovals` — otherwise a lone writer could open a change, approve it,
and self-merge. For a change an agent created, the excluded author is the
agent's owning user, so an operator cannot approve their own agent's work
either. (Changes created before authorship was recorded have no author to
exclude, so on those every approval counts — including what may in fact be a
self-approval. The strict fail-closed rule applies on the manual
conflict-resolution path when the originating change is unknown.)

## Reviewing in GitHub instead

In layer mode, promoting a change to a GitHub PR moves the conversation to
GitHub, and your team reviews there as usual. Stratum still posts the
evaluation verdict to the PR as a comment (edited in place on re-evaluation)
and as a `stratum/evaluation` commit status. See
[Getting Started](getting-started.md#choose-your-level-of-buy-in-layer-mode-vs-forge-mode).

## Reference

- [Reviews and comments API](../api/endpoints/reviews.md)
- [OpenAPI specification](../api/openapi.yml) — exact schemas and status codes
