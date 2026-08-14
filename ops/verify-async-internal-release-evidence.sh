#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 4 ]; then
    echo "Expected application root, revision, release run ID, and attempt" >&2
    exit 1
fi

app_root="$1"
revision="$2"
release_run_id="$3"
release_run_attempt="$4"

if ! printf '%s' "$app_root" | grep -Eq '^/[A-Za-z0-9._/-]+$' || \
    ! printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || \
    ! printf '%s' "$release_run_id" | grep -Eq '^[1-9][0-9]*$' || \
    ! printf '%s' "$release_run_attempt" | grep -Eq '^[1-9][0-9]*$'; then
    echo "Invalid async release evidence request" >&2
    exit 1
fi

evidence="$app_root/shared/async-release-evidence/$revision-$release_run_id-$release_run_attempt/evidence.json"
test -f "$evidence"
for container in \
    pipipi \
    pipipi-business-api \
    pipipi-process-dispatcher \
    pipipi-process-worker \
    pipipi-webhook-worker \
    pipipi-retention-cleaner; do
    if [ "$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')" != "$revision" ]; then
        echo "Active async role revision differs from release evidence" >&2
        exit 1
    fi
done

docker run --rm \
    --volume "$evidence:/evidence.json:ro" \
    --entrypoint node "pipipi:$revision" -e '
const fs = require("node:fs");
const [revision, releaseRunId, releaseRunAttempt] = process.argv.slice(1);
const record = JSON.parse(fs.readFileSync("/evidence.json", "utf8"));
if (
  record.candidateCommit !== revision ||
  record.releaseRunId !== Number(releaseRunId) ||
  record.releaseRunAttempt !== Number(releaseRunAttempt) ||
  record.status !== "succeeded" ||
  record.rolesVerified !== true ||
  record.releaseStage !== "internal"
) process.exit(1);
' "$revision" "$release_run_id" "$release_run_attempt"
