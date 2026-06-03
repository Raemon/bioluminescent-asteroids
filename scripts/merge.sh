#!/usr/bin/env bash
# Ships the current branch to main, then (separately) generates a Dev Log
# entry from the just-shipped commits and merges that as a follow-up.
#
# Order matters: the code merge goes first so players see new content
# ASAP — Dev Log generation is best-effort and must never block the ship.
#
# Steps:
#   1. capture pre-merge main SHA (the diff baseline for the LLM)
#   2. checkout main, merge branch, push  ← visible to players now
#   3. checkout branch, run devlog-gen against the pre-merge SHA
#   4. if devlog.json changed: commit it, merge to main (fast-forward), push
#
# The devlog generator itself never invokes `yarn merge`, so there's no
# recursion risk.

set -euo pipefail

branch=$(git branch --show-current)
if [ -z "$branch" ] || [ "$branch" = "main" ]; then
  echo "[merge] refusing to merge: current branch is '$branch'." >&2
  exit 1
fi

# Make sure local main reflects the remote before we use its SHA as the
# devlog baseline — otherwise we'd compare against a stale main and the
# LLM would summarize commits that have already shipped.
git fetch origin main --quiet
pre_main=$(git rev-parse origin/main)

echo "[merge] shipping '$branch' → main (baseline $pre_main)"
git checkout main
git merge "$branch"
git push origin main
git checkout "$branch"

echo "[merge] code is live. Generating Dev Log entry…"
# DEVLOG_BASE pins the diff to pre-merge main so the LLM sees the
# real code changes, not the merge artifact.
DEVLOG_BASE="$pre_main" node scripts/devlog-gen.mjs || {
  echo "[merge] devlog-gen failed; merge is already complete." >&2
  exit 0
}

if git diff --cached --quiet; then
  echo "[merge] no devlog changes to commit. Done."
  exit 0
fi

git commit -m "devlog: auto-generated entry"
git checkout main
git merge "$branch"
git push origin main
git checkout "$branch"
echo "[merge] Dev Log entry shipped."
