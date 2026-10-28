#!/usr/bin/env bash
# Upload into the release for <tag> whichever of <files> it lacks, by name.
# electron-builder uploads its own builds into the draft, but skips a release
# that's already published, as one rebuilt by hand is (CONTRIBUTING.md#releases).
#
#   GH_TOKEN=… bash scripts/release-upload.sh <tag> <files>…
set -euo pipefail
tag=$1
shift
id=$(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=30" \
  --jq "[.[] | select(.tag_name == \"$tag\")][0].id")
[ -n "$id" ] && [ "$id" != "null" ] || { echo "no release for $tag"; exit 1; }
have=$(gh api "repos/$GITHUB_REPOSITORY/releases/$id/assets?per_page=100" --jq '.[].name')
for file in "$@"; do
  name=$(basename "$file")
  if ! grep -qx "$name" <<<"$have"; then
    echo "uploading missing $name"
    gh release upload "$tag" "$file" --repo "$GITHUB_REPOSITORY"
  fi
done
