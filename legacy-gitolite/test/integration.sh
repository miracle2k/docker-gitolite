#!/usr/bin/env bash

set -euo pipefail

image="${1:-docker-gitolite:test}"
workdir="$(mktemp -d)"
container_id=""

# shellcheck disable=SC2317 # Invoked by the EXIT trap below.
cleanup() {
  local status=$?

  if [[ -n "$container_id" ]]; then
    if (( status != 0 )); then
      docker logs "$container_id" >&2 || true
    fi
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$workdir/admin-key"
container_id="$(docker run --detach \
  --publish 127.0.0.1::2222 \
  --env SSH_KEY="$(<"$workdir/admin-key.pub")" \
  "$image")"

for _ in {1..30}; do
  port="$(docker port "$container_id" 2222/tcp | awk -F: 'NR == 1 { print $NF }')"
  if [[ -n "$port" ]] && output="$(ssh \
    -i "$workdir/admin-key" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -p "$port" \
    git@127.0.0.1 info 2>&1)"; then
    if grep -Fq 'gitolite version' <<<"$output"; then
      printf '%s\n' "$output"
      exit 0
    fi
  fi
  sleep 1
done

echo "Gitolite did not become available over SSH" >&2
exit 1
