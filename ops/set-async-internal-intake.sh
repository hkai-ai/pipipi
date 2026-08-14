#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 5 ]; then
    echo "Expected application root, revision, state, auto-restore seconds, and control ID" >&2
    exit 1
fi

app_root="$1"
revision="$2"
state="$3"
auto_restore_seconds="$4"
control_id="$5"

if ! printf '%s' "$app_root" | grep -Eq '^/[A-Za-z0-9._/-]+$' || \
    ! printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || \
    ! printf '%s' "$auto_restore_seconds" | grep -Eq '^[1-9][0-9]*$' || \
    ! printf '%s' "$control_id" | grep -Eq '^[A-Za-z0-9_.:-]{1,200}$' || \
    [ "$auto_restore_seconds" -gt 900 ] || \
    { [ "$state" != "closed" ] && [ "$state" != "open" ]; }; then
    echo "Invalid async intake control request" >&2
    exit 1
fi

shared="$app_root/shared"
control_directory="$shared/async-control"
marker="$control_directory/intake-disabled"
lock_file="$shared/deployment.lock"

command -v docker >/dev/null
command -v flock >/dev/null
mkdir -p "$shared"
exec 9>"$lock_file"
if ! flock -n 9; then
    echo "Another production deployment is active" >&2
    exit 1
fi

for container in \
    pipipi \
    pipipi-business-api \
    pipipi-process-dispatcher \
    pipipi-process-worker \
    pipipi-webhook-worker \
    pipipi-retention-cleaner; do
    actual_revision="$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')"
    if [ "$actual_revision" != "$revision" ]; then
        echo "Async intake revision mismatch" >&2
        exit 1
    fi
done

container_environment() {
    name="$1"
    docker inspect pipipi --format '{{range .Config.Env}}{{println .}}{{end}}' |
        awk -F= -v name="$name" '$1 == name { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }'
}

if [ "$(container_environment ASYNC_RELEASE_STAGE)" != "internal" ] || \
    [ "$(container_environment ASYNC_PROCESS_RUNS_ENABLED)" != "true" ] || \
    [ "$(container_environment ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE)" != "/var/lib/pipipi-async-control/intake-disabled" ]; then
    echo "Async intake control is only available for the internal shape" >&2
    exit 1
fi

install -d -m 755 "$control_directory"
marker_token="$revision:$control_id"
smoke_lease="$control_directory/smoke-lease"
if [ -f "$smoke_lease" ] && [ "$(cat "$smoke_lease")" != "$marker_token" ]; then
    echo "Async intake control conflicts with an active smoke lease" >&2
    exit 1
fi
if [ "$state" = "closed" ]; then
    if [ -f "$marker" ] && [ "$(cat "$marker")" != "$marker_token" ]; then
        echo "Async intake is controlled by another operation" >&2
        exit 1
    fi
    nohup bash -c '
sleep "$1"
if [ -f "$2" ] && [ "$(cat "$2")" = "$3" ]; then rm -f -- "$2"; fi
' _ "$auto_restore_seconds" "$marker" "$marker_token" 9>&- >/dev/null 2>&1 &
    temporary="$marker.tmp.$$"
    printf '%s\n' "$marker_token" > "$temporary"
    chmod 644 "$temporary"
    mv "$temporary" "$marker"
    status="$(docker exec pipipi node -e '
const response = await fetch("http://127.0.0.1:4300/process-runs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": "intake-control-verification",
    "x-pipipi-caller-id": "async-intake-control",
    "x-pipipi-gateway-token": process.env.ASYNC_GATEWAY_SHARED_SECRET
  },
  body: "{}"
});
process.stdout.write(String(response.status));
')"
    if [ "$status" != "503" ]; then
        rm -f -- "$marker"
        echo "Async intake did not close" >&2
        exit 1
    fi
else
    if [ -f "$marker" ]; then
        if [ "$(cat "$marker")" != "$marker_token" ]; then
            echo "Async intake is controlled by another operation" >&2
            exit 1
        fi
        rm -f -- "$marker"
    fi
fi

curl --fail --silent --show-error http://127.0.0.1:4300/healthz >/dev/null
curl --fail --silent --show-error http://127.0.0.1:4300/readyz >/dev/null
printf '{"event":"async_internal_intake_changed","revision":"%s","state":"%s","autoRestoreSeconds":%s,"timestamp":"%s"}\n' \
    "$revision" "$state" "$auto_restore_seconds" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
