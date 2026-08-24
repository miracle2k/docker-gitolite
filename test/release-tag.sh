#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workdir="$(mktemp -d)"

cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

mkdir -p "$workdir/scripts"
cp "$root/Dockerfile" "$workdir/Dockerfile"
cp "$root/scripts/release-tag.sh" "$workdir/scripts/release-tag.sh"
chmod 0755 "$workdir/scripts/release-tag.sh"

cd "$workdir"
git init -q
git config user.name 'Release tag test'
git config user.email 'release-tag-test@example.invalid'
git add Dockerfile scripts/release-tag.sh
git commit -qm 'Initial source'

first_tag="$(RELEASE_DATE=20260824 ./scripts/release-tag.sh)"
[[ "$first_tag" == 'v3.6.15-ubuntu-26.04-20260824.1' ]]

git tag -a "$first_tag" -m "Release $first_tag"
[[ "$(RELEASE_DATE=20260825 ./scripts/release-tag.sh)" == "$first_tag" ]]

printf 'next release\n' > release-marker
git add release-marker
git commit -qm 'Next source'
[[ "$(RELEASE_DATE=20260824 ./scripts/release-tag.sh)" == 'v3.6.15-ubuntu-26.04-20260824.2' ]]
