#!/usr/bin/env bash
# Prints the What's New file for <tag> (vX.Y.Z), for the Release workflow to
# bake into the app as WhatsNew.md (main/whats-new.ts): that release's notes
# plus the nine before it, each under "# vX.Y.Z", newest first. Every merge is
# its own release, so an update that skips a few would otherwise show only the
# last PR. The release for <tag> must already exist. Needs GH_TOKEN.
set -euo pipefail
tag=$1

printf '# %s\n' "$tag"
gh release view "$tag" --json body -q .body
# Not <tag> itself: it's already first.
for t in $(gh release list --limit 10 --json tagName \
             -q ".[] | select(.tagName != \"$tag\") | .tagName" | head -n 9); do
  printf '\n# %s\n' "$t"
  gh release view "$t" --json body -q .body
done
