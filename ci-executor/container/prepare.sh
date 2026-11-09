#!/usr/bin/env bash
# Build the checkout a job's steps run in, and prove it is the evaluated one.
#
# A change's head lives in a workspace repository the job has no access to. The
# job gets the BASE commit (fetched through a hostname the executor intercepts,
# which attaches the read credential outside this container) and the change's
# diff. Applying one to the other must produce exactly the tree Stratum
# evaluated; if it does not, the steps would be testing something nobody
# reviewed, so nothing runs.
#
# A deploy job (STRATUM_JOB_PROFILE=deploy, #416) is simpler: it runs a commit
# that is already on the default branch, so there is no diff to apply and no
# tree to reproduce — git's own object ids are the proof that the checkout is
# the commit that was asked for. Everything about the diff below is skipped,
# and only in that mode: a CI job without HEAD_TREE_SHA still refuses to run.
#
# Exit codes: 0 ready; 3 the tree could not be reproduced; anything else, the
# checkout could not be built at all.
set -euo pipefail

PROFILE="${STRATUM_JOB_PROFILE:-ci}"
: "${BASE_SHA:?}"
if [ "$PROFILE" != "deploy" ]; then : "${HEAD_TREE_SHA:?}"; fi
REMOTE="${STRATUM_GIT_REMOTE:-https://git.stratum.internal/repo.git}"
WORKSPACE="${STRATUM_WORKSPACE:-/workspace}"
DIFF="${STRATUM_DIFF:-/job/change.diff}"

if [ -x /opt/stratum/trust-ca.sh ]; then /opt/stratum/trust-ca.sh; fi

mkdir -p "$WORKSPACE"
cd "$WORKSPACE"
git init --quiet .
git config advice.detachedHead false

# One commit is all a job needs. Not every server lets a client ask for a
# commit by id, so a refusal falls back to fetching the branches.
if ! git fetch --quiet --depth=1 "$REMOTE" "$BASE_SHA" 2>/dev/null; then
  echo "prepare: fetching by commit id was refused; fetching all branches instead"
  git fetch --quiet "$REMOTE" '+refs/heads/*:refs/remotes/origin/*'
fi
if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  echo "prepare: base commit $BASE_SHA is not in the repository"
  exit 4
fi
git checkout --quiet --detach "$BASE_SHA"

if [ "$PROFILE" = "deploy" ]; then
  if [ "$(git rev-parse HEAD)" != "$BASE_SHA" ]; then
    echo "prepare: the checkout is not commit $BASE_SHA"
    exit 4
  fi
  echo "prepare: checkout ready at commit $BASE_SHA"
  exit 0
fi

# An empty diff is a change identical to its base; `git apply` refuses one.
if [ -s "$DIFF" ]; then
  if ! git apply --index --whitespace=nowarn "$DIFF"; then
    echo "prepare: the change's diff does not apply to base commit $BASE_SHA"
    exit 3
  fi
fi

TREE="$(git write-tree)"
if [ "$TREE" != "$HEAD_TREE_SHA" ]; then
  echo "prepare: tree mismatch: base + diff gives $TREE, the evaluated tree is $HEAD_TREE_SHA"
  exit 3
fi

# The base commit under a name a step can rely on, whatever the project calls
# its default branch (`git diff refs/stratum/base`, or pointing a tool that
# expects `origin/main` at it).
git update-ref refs/stratum/base "$BASE_SHA"

# Commit it, so a step that asks git what it is looking at gets a clean tree.
git -c user.name=stratum -c user.email=ci@stratum.invalid \
  commit --quiet --no-verify --allow-empty -m "Change under test"
echo "prepare: checkout ready at tree $TREE"
