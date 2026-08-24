#!/usr/bin/env bash

set -euo pipefail

image="${1:-docker-gitolite:test}"
workdir="$(mktemp -d)"
container_id=""
last_ssh_output=""

# shellcheck disable=SC2317 # Invoked by the EXIT trap below.
cleanup() {
  local status=$?

  if [[ -n "$container_id" ]]; then
    if (( status != 0 )); then
      docker inspect --format 'container state: {{.State.Status}} (exit {{.State.ExitCode}}): {{.State.Error}}' "$container_id" >&2 || true
      docker logs "$container_id" >&2 || true
    fi
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT

# Force the legacy ssh-rsa signature algorithm so this verifies the compatibility
# setting retained for older RSA-only clients.
ssh-keygen -q -t rsa -b 3072 -N '' -f "$workdir/admin-key"
container_id="$(docker run --detach \
  --publish 127.0.0.1::2222 \
  --env SSH_KEY="$(<"$workdir/admin-key.pub")" \
  "$image")"

for _ in {1..30}; do
  port="$(docker port "$container_id" 2222/tcp | awk -F: 'NR == 1 { print $NF }')"
  if [[ -n "$port" ]]; then
    # Gitolite's `info` command returns a non-zero status despite producing a
    # successful response, so inspect its output rather than SSH's status.
    output="$(ssh \
      -i "$workdir/admin-key" \
      -o BatchMode=yes \
      -o PubkeyAcceptedAlgorithms=ssh-rsa \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -p "$port" \
      git@127.0.0.1 info 2>&1 || true)"
    if grep -Eq 'gitolite(3)? v[0-9]' <<<"$output"; then
      printf '%s\n' "$output"
      exit 0
    fi
  fi
  last_ssh_output="${output:-}"
  sleep 1
done

echo "Gitolite did not become available over SSH" >&2
printf 'Last SSH attempt:\n%s\n' "${last_ssh_output:-no connection attempt}" >&2
exit 1
