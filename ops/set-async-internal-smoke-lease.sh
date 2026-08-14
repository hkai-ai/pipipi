#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 5 ]; then
    echo "Expected application root, revision, state, expiry seconds, and control ID" >&2
    exit 1
fi

app_root="$1"
revision="$2"
state="$3"
expiry_seconds="$4"
control_id="$5"

if ! printf '%s' "$app_root" | grep -Eq '^/[A-Za-z0-9._/-]+$' || \
    ! printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || \
    ! printf '%s' "$expiry_seconds" | grep -Eq '^[1-9][0-9]*$' || \
    ! printf '%s' "$control_id" | grep -Eq '^[A-Za-z0-9_.:-]{1,200}$' || \
    [ "$expiry_seconds" -gt 1800 ] || \
    { [ "$state" != "acquired" ] && [ "$state" != "released" ]; }; then
    echo "Invalid async smoke lease request" >&2
    exit 1
fi

shared="$app_root/shared"
control_directory="$shared/async-control"
lease="$control_directory/smoke-lease"
lease_token="$revision:$control_id"

command -v docker >/dev/null
command -v flock >/dev/null
mkdir -p "$shared"
exec 9>"$shared/deployment.lock"
if ! flock -n 9; then
    echo "Another production deployment is active" >&2
    exit 1
fi

install -d -m 755 "$control_directory"
if [ "$state" = "acquired" ]; then
    for container in \
        pipipi \
        pipipi-business-api \
        pipipi-process-dispatcher \
        pipipi-process-worker \
        pipipi-webhook-worker \
        pipipi-retention-cleaner; do
        actual_revision="$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')"
        if [ "$actual_revision" != "$revision" ]; then
            echo "Async smoke lease revision mismatch" >&2
            exit 1
        fi
    done
    api_environment="$(docker inspect pipipi --format '{{range .Config.Env}}{{println .}}{{end}}')"
    if ! printf '%s\n' "$api_environment" | grep -Fxq 'ASYNC_RELEASE_STAGE=internal' || \
        ! printf '%s\n' "$api_environment" | grep -Fxq 'ASYNC_PROCESS_RUNS_ENABLED=true'; then
        echo "Async smoke lease requires the active internal shape" >&2
        exit 1
    fi
    if [ -f "$lease" ] && [ "$(cat "$lease")" != "$lease_token" ]; then
        echo "Async smoke lease is owned by another operation" >&2
        exit 1
    fi
    nohup bash -c '
sleep "$1"
if [ -f "$2" ] && [ "$(cat "$2")" = "$3" ]; then rm -f -- "$2"; fi
' _ "$expiry_seconds" "$lease" "$lease_token" 9>&- >/dev/null 2>&1 &
    temporary="$lease.tmp.$$"
    printf '%s\n' "$lease_token" > "$temporary"
    chmod 644 "$temporary"
    mv "$temporary" "$lease"
else
    if [ -f "$lease" ]; then
        if [ "$(cat "$lease")" != "$lease_token" ]; then
            echo "Async smoke lease is owned by another operation" >&2
            exit 1
        fi
        rm -f -- "$lease"
    fi
fi

printf '{"event":"async_internal_smoke_lease_changed","revision":"%s","state":"%s","expirySeconds":%s,"timestamp":"%s"}\n' \
    "$revision" "$state" "$expiry_seconds" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
