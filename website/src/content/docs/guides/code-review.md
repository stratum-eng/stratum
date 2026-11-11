---
title: "Code Review"
description: "Line-anchored comment threads, replies, resolve/unresolve, and the three review verdicts."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/code-review.md"
---

Stratum's merge gate decides whether a change *may* land. Code review is how
people say whether it *should*. The two are independent: a change can be green
on every evaluator and still sit unapproved, and no amount of approval lets a
change past a failing required evaluator.

Everything here works on a change, from the change page in the web UI or
through the API.

## Reading the change page

The change page is built to answer two questions before you give a verdict:
what is this change, and what did the gates look at.

- **The heading** is the change's title, and its description follows. Both come
  from whoever opened the change. A change opened without a title is headed by
  the subject of its first commit instead. The change id, who opened it and the
  agent that wrote it are on the line beneath.
- **Files changed** gives the totals, lists the commits the workspace adds, and
  shows the diff. The diff is what the workspace changed since it forked from
  the project. If the project has moved on since, the page says how many commits
  the workspace is behind and which commit the diff starts from; those newer
  commits are not part of the change.
- **Evaluator evidence** shows the latest evaluation: when it ran, which
  revision it judged, and each evaluator's verdict and findings. Earlier
  evaluations of the same change are folded away beneath it, since a newer one
  replaces them. The exception is an evaluator the latest evaluation did not
  run: merging is decided on each evaluator's newest result, so that earlier
  result still counts, and it stays in view under "Still counted from an
  earlier evaluation".
- **Checks**, where the project declares any, are the results its runner
  reported for that same revision.

Once a change has been promoted to a GitHub pull request the page says so and
links to it: review and merging then happen on GitHub (see
[Reviewing in GitHub instead](#reviewing-in-github-instead)). The diff stays
visible here so the page still says what the change is.

Promotion opens the pull request as a draft. While it is one, the page's button
is **Mark ready for review**, which takes it out of draft on GitHub without
leaving Stratum. Once the pull request is ready, whichever side that happened
on, the button becomes **Open GitHub PR**. The text above it links to the pull
request in both states.

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
[Getting Started](/guides/getting-started/#the-human-approval-invariant), and it is
enforced in the route, not in the UI.

**Approvals are made by a signed-in human.** The same goes for credentials
that act *for* a human: an `approve` verdict sent with a scoped API token or
an OAuth grant (an MCP client, `stratum login` in the CLI) is refused with
`403 SESSION_REQUIRED`, because those are exactly the credentials an agent
ends up holding. Approve on the change page in the browser. Those credentials
can still request changes and comment, which can only block a merge.

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
[Getting Started](/guides/getting-started/#choose-your-level-of-buy-in-layer-mode-vs-forge-mode).

### Who the pull request is opened as

GitHub records whoever's credential created a pull request as its author. By
default that is the Stratum GitHub App, so a promoted pull request is authored
by a bot. Tools that look at the author treat it accordingly: a review tool may
skip it or ask for a seat for the bot, and the person whose agent wrote the code
can approve it themselves.

To have your promotions opened as you, connect your GitHub account under
**Settings → GitHub**. After that:

- a pull request **you** promote is opened as you;
- nobody else's promotion is ever opened as you. When a teammate promotes a
  change you opened, the pull request is theirs, or the app's if they have not
  connected.

GitHub then applies its own rules to you as the author. In particular you
cannot approve your own pull request.

Connecting stores an authorization for your GitHub account, encrypted. Stratum
uses it for one thing, opening the pull request at promotion, and through it
can act as you only where the Stratum app is installed and you already have
access. The branch is still pushed by the app. Disconnect at any time from the
same settings card, or by revoking the app in your GitHub settings; pull
requests already opened as you stay yours.

Stratum falls back to the app, and the promotion still succeeds, when you are
not connected, when your authorization has lapsed (connect again), or when
GitHub will not let you open a pull request on that repository. The promote
response says which happened: see
[Promote to a GitHub PR](/reference/endpoints/#promote-to-a-github-pr).

The account you authorize must be the GitHub account you sign in to Stratum
with. The card is absent when the instance's operator has not turned the
feature on.

## Reference

- [Reviews and comments API](/reference/endpoints/)
- [OpenAPI specification](/reference/openapi/) — exact schemas and status codes
