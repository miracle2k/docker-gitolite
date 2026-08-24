#!/usr/bin/env bash

set -euo pipefail

# Print an immutable release tag derived from the pinned Gitolite and Ubuntu
# versions. Re-running for an already released commit reuses its existing tag.
dockerfile="${DOCKERFILE:-Dockerfile}"
release_date="${RELEASE_DATE:-$(date -u +%Y%m%d)}"
release_commit="${RELEASE_COMMIT:-HEAD}"

if [[ ! "$release_date" =~ ^[0-9]{8}$ ]]; then
  echo "RELEASE_DATE must use YYYYMMDD format, got: $release_date" >&2
  exit 1
fi

gitolite_version="$(sed -nE 's/^ARG GITOLITE_VERSION=(v[0-9][^[:space:]]*)$/\1/p' "$dockerfile" | head -n 1)"
ubuntu_version="$(sed -nE 's/^FROM[[:space:]]+ubuntu:([0-9]+\.[0-9]+)(@[^[:space:]]+)?$/\1/p' "$dockerfile" | head -n 1)"

if [[ -z "$gitolite_version" || -z "$ubuntu_version" ]]; then
  echo "Could not determine the Gitolite or Ubuntu version from $dockerfile" >&2
  exit 1
fi

release_commit="$(git rev-parse "${release_commit}^{commit}")"
family_prefix="${gitolite_version}-ubuntu-${ubuntu_version}-"
existing_tag=""
best_date=""
best_sequence=0

# Preserve a tag already assigned to this source commit, including when a
# release workflow is re-run on a later date.
while IFS= read -r candidate; do
  remainder="${candidate#"$family_prefix"}"
  candidate_date="${remainder%%.*}"
  candidate_sequence="${remainder#*.}"

  if [[ "$candidate_date" =~ ^[0-9]{8}$ && "$candidate_sequence" =~ ^[1-9][0-9]*$ ]]; then
    if [[ -z "$existing_tag" || "$candidate_date" > "$best_date" ]] \
      || { [[ "$candidate_date" == "$best_date" ]] && (( 10#$candidate_sequence > best_sequence )); }; then
      existing_tag="$candidate"
      best_date="$candidate_date"
      best_sequence=$((10#$candidate_sequence))
    fi
  fi
done < <(git tag --points-at "$release_commit" --list "${family_prefix}*")

if [[ -n "$existing_tag" ]]; then
  printf '%s\n' "$existing_tag"
  exit 0
fi

max_sequence=0
while IFS= read -r candidate; do
  remainder="${candidate#"$family_prefix"}"
  candidate_date="${remainder%%.*}"
  candidate_sequence="${remainder#*.}"

  if [[ "$candidate_date" == "$release_date" && "$candidate_sequence" =~ ^[1-9][0-9]*$ ]] \
    && (( 10#$candidate_sequence > max_sequence )); then
    max_sequence=$((10#$candidate_sequence))
  fi
done < <(git tag --list "${family_prefix}${release_date}.*")

printf '%s%s.%d\n' "$family_prefix" "$release_date" "$((max_sequence + 1))"
