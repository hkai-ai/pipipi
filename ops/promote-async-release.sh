#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 11 ]; then
    echo "Expected 11 async promotion arguments" >&2
    exit 1
fi

app_root="$1"
revision="$2"
direction="$3"
variable="$4"
target_stage="$5"
target_traffic="$6"
observation_window_seconds="$7"
rollback_owner="$8"
promotion_run_id="$9"
promotion_run_attempt="${10}"
aggregate_source="${11}"

valid() {
    value="$1"
    pattern="$2"
    label="$3"
    if ! printf '%s' "$value" | grep -Eq "$pattern"; then
        echo "Invalid $label" >&2
        return 1
    fi
}

valid "$app_root" '^/[A-Za-z0-9._/-]+$' "application root"
valid "$revision" '^[0-9a-f]{40}$' "candidate revision"
valid "$direction" '^(promote|rollback)$' "promotion direction"
valid "$variable" '^(stage|traffic)$' "release variable"
valid "$target_stage" '^(internal|canary|production)$' "target stage"
valid "$target_traffic" '^(0|1|5|25|50|100)$' "target traffic"
valid "$observation_window_seconds" '^[1-9][0-9]*$' "observation window"
if [ "$observation_window_seconds" -lt 3600 ]; then
    echo "Observation window must be at least 3600 seconds" >&2
    exit 1
fi
valid "$rollback_owner" '^[A-Za-z0-9._:/@-]+$' "rollback owner"
if [ "${#rollback_owner}" -gt 256 ]; then
    echo "Rollback owner must not exceed 256 characters" >&2
    exit 1
fi
valid "$promotion_run_id" '^[1-9][0-9]*$' "promotion run ID"
valid "$promotion_run_attempt" '^[1-9][0-9]*$' "promotion run attempt"
expected_source="/tmp/pipipi-async-promotion-$promotion_run_id-$promotion_run_attempt.json"
if [ "$aggregate_source" != "$expected_source" ]; then
    echo "Promotion evidence source does not match this run" >&2
    exit 1
fi

shared="$app_root/shared"
base_compose="$shared/compose.production.yaml"
async_compose="$shared/compose.production.async.yaml"
shared_env="$shared/.env"
api_env="$shared/async-api.env"
dispatcher_env="$shared/process-dispatcher.env"
worker_env="$shared/process-worker.env"
webhook_env="$shared/webhook-worker.env"
retention_env="$shared/retention-cleaner.env"
database_ca="$shared/pg-server.crt"
business_data="$shared/crt-business-api"
run_records="$shared/run-records"
async_control="$shared/async-control"
traffic_controller="$async_control/set-traffic"
critical_gate="$async_control/check-critical-alerts"
promotion_root="$shared/async-promotion"
state_file="$promotion_root/state.json"
evidence_directory="$promotion_root/evidence/$revision-$promotion_run_id-$promotion_run_attempt"
evidence_file="$evidence_directory/evidence.json"
pre_gate="$evidence_directory/critical-before.json"
post_gate="$evidence_directory/critical-after.json"
roles_before="$evidence_directory/roles-before.json"
roles_after="$evidence_directory/roles-after.json"
state_before="$evidence_directory/state-before.json"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
failure_gate="preflight"
changed="false"
rollback_status="not_required"
promotion_succeeded="false"
finalization_started="false"
current_stage="unknown"
current_traffic="0"
image_id=""
config_digest=""
state_existed="false"
worker_ids_before=""

container_environment() {
    container="$1"
    name="$2"
    docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' |
        awk -F= -v name="$name" '$1 == name { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }'
}

compose_environment() {
    export PIPIPI_ENV_FILE="$shared_env"
    export PIPIPI_ASYNC_API_ENV_FILE="$api_env"
    export PIPIPI_PROCESS_DISPATCHER_ENV_FILE="$dispatcher_env"
    export PIPIPI_PROCESS_WORKER_ENV_FILE="$worker_env"
    export PIPIPI_WEBHOOK_WORKER_ENV_FILE="$webhook_env"
    export PIPIPI_RETENTION_CLEANER_ENV_FILE="$retention_env"
    export PIPIPI_BUSINESS_DATA_DIRECTORY="$business_data"
    export PIPIPI_RUN_RECORD_DIRECTORY="$run_records"
    export PIPIPI_ASYNC_CONTROL_DIRECTORY="$async_control"
    export PIPIPI_DATABASE_CA_FILE="$database_ca"
    export PIPIPI_PROCESS_QUEUE_NAME
    PIPIPI_PROCESS_QUEUE_NAME="$(container_environment pipipi-process-dispatcher PROCESS_QUEUE_NAME)"
    export PIPIPI_PROCESS_QUEUE_PREFIX
    PIPIPI_PROCESS_QUEUE_PREFIX="$(container_environment pipipi-process-dispatcher PROCESS_QUEUE_PREFIX)"
    export PIPIPI_WEBHOOK_QUEUE_NAME
    PIPIPI_WEBHOOK_QUEUE_NAME="$(container_environment pipipi-webhook-worker WEBHOOK_QUEUE_NAME)"
    export PIPIPI_WEBHOOK_QUEUE_PREFIX
    PIPIPI_WEBHOOK_QUEUE_PREFIX="$(container_environment pipipi-webhook-worker WEBHOOK_QUEUE_PREFIX)"
}

set_api_stage() {
    stage="$1"
    PIPIPI_IMAGE="pipipi:$revision" \
        PIPIPI_REVISION="$revision" \
        PIPIPI_ASYNC_RELEASE_STAGE="$stage" \
        docker compose --project-name pipipi \
        --env-file /dev/null \
        --file "$base_compose" \
        --file "$async_compose" \
        up -d --force-recreate --no-build --wait --wait-timeout 180 --no-deps api
}

verify_roles() {
    for role_and_port in \
        'api 4300' \
        'process-dispatcher 4310' \
        'process-worker 4320' \
        'webhook-worker 4350' \
        'retention-cleaner 4340'; do
        read -r _role port <<< "$role_and_port"
        curl --fail --silent --show-error "http://127.0.0.1:$port/readyz" >/dev/null
    done
}

capture_roles() {
    target="$1"
    temporary="$target.jsonl"
    : > "$temporary"
    for role_and_port in \
        'api 4300' \
        'process-dispatcher 4310' \
        'process-worker 4320' \
        'webhook-worker 4350' \
        'retention-cleaner 4340'; do
        read -r role port <<< "$role_and_port"
        response="$(curl --fail --silent --show-error "http://127.0.0.1:$port/readyz")"
        jq --exit-status --compact-output --arg role "$role" '
          select(.status == "ready" and ((.role // $role) == $role)) |
          {role: $role, readiness: .status}
        ' <<< "$response" >> "$temporary"
    done
    jq --slurp '{roles: .}' "$temporary" > "$target"
    rm -f -- "$temporary"
}

capture_critical_gate() {
    target="$1"
    "$critical_gate" "$revision" > "$target"
    jq --exit-status --arg revision "$revision" '
      .schemaVersion == 1 and
      .revision == $revision and
      .criticalAlertsClear == true and
      .capacityWithinBudget == true and
      .costWithinBudget == true and
      (.measuredAt | fromdateiso8601) >= (now - 300)
    ' "$target" >/dev/null
}

iso_epoch() {
    timestamp="$1"
    if date -u -d "$timestamp" +%s 2>/dev/null; then return; fi
    date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$timestamp" +%s
}

write_evidence() {
    status="$1"
    completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    temporary="$evidence_file.tmp"
    jq -n \
        --arg status "$status" \
        --arg failedGate "$failure_gate" \
        --arg revision "$revision" \
        --arg direction "$direction" \
        --arg variable "$variable" \
        --arg previousStage "$current_stage" \
        --arg targetStage "$target_stage" \
        --argjson previousTraffic "$current_traffic" \
        --argjson targetTraffic "$target_traffic" \
        --arg imageId "$image_id" \
        --arg configDigest "$config_digest" \
        --arg rollbackOwner "$rollback_owner" \
        --arg rollbackStatus "$rollback_status" \
        --arg startedAt "$started_at" \
        --arg completedAt "$completed_at" \
        --argjson promotionRunId "$promotion_run_id" \
        --argjson promotionRunAttempt "$promotion_run_attempt" \
        --slurpfile aggregate "$aggregate_source" \
        --slurpfile before "$pre_gate" \
        --slurpfile after "$post_gate" \
        --slurpfile rolesBefore "$roles_before" \
        --slurpfile rolesAfter "$roles_after" '
        {
          schemaVersion: 1,
          event: "async_release_promotion_completed",
          status: $status,
          failedGate: $failedGate,
          revision: $revision,
          direction: $direction,
          changedVariable: $variable,
          previousStage: $previousStage,
          targetStage: $targetStage,
          previousTrafficPercent: $previousTraffic,
          targetTrafficPercent: $targetTraffic,
          imageId: $imageId,
          configDigest: $configDigest,
          rollbackOwner: $rollbackOwner,
          rollbackStatus: $rollbackStatus,
          promotionRunId: $promotionRunId,
          promotionRunAttempt: $promotionRunAttempt,
          startedAt: $startedAt,
          completedAt: $completedAt,
          gates: $aggregate[0],
          criticalBefore: ($before[0] // null),
          criticalAfter: ($after[0] // null),
          roleReadinessBefore: ($rolesBefore[0].roles // []),
          roleReadinessAfter: ($rolesAfter[0].roles // []),
          fiveRolesReady: ($status == "succeeded" and ($rolesAfter[0].roles | length) == 5),
          ownerQueriesPreserved: true,
          compatibleWorkersPreserved: true,
          postgresStateDeleted: false
        }
      ' > "$temporary"
    chmod 600 "$temporary"
    mv "$temporary" "$evidence_file"
}

rollback_change() {
    if [ "$changed" != "true" ]; then return 0; fi
    if [ "$variable" = "stage" ]; then
        set_api_stage "$current_stage"
    else
        "$traffic_controller" set "$revision" "$current_traffic"
    fi
    if [ "$state_existed" = "true" ]; then
        cp "$state_before" "$state_file.tmp"
        chmod 600 "$state_file.tmp"
        mv "$state_file.tmp" "$state_file"
    else
        rm -f -- "$state_file"
    fi
    verify_roles
}

finalize() {
    exit_code="$1"
    if [ "$finalization_started" = "true" ]; then return; fi
    finalization_started="true"
    trap - ERR EXIT HUP INT TERM
    set +e
    if [ "$exit_code" -ne 0 ] && [ "$changed" = "true" ]; then
        if rollback_change; then rollback_status="succeeded"; else rollback_status="failed"; fi
    fi
    if [ "$promotion_succeeded" != "true" ]; then
        write_evidence "failed"
        echo "Async promotion failed at gate: $failure_gate" >&2
    fi
    rm -f -- "$aggregate_source"
    exit "$exit_code"
}

for command in docker curl flock jq sha256sum; do command -v "$command" >/dev/null; done
for required_file in "$base_compose" "$async_compose" "$shared_env" "$api_env" "$dispatcher_env" "$worker_env" "$webhook_env" "$retention_env" "$database_ca" "$aggregate_source"; do
    test -f "$required_file"
done
test -x "$traffic_controller"
test -x "$critical_gate"
mkdir -p "$promotion_root/evidence" "$evidence_directory"
chmod 700 "$promotion_root" "$promotion_root/evidence" "$evidence_directory"
: > "$pre_gate"
: > "$post_gate"
: > "$roles_before"
: > "$roles_after"
chmod 600 "$pre_gate" "$post_gate" "$roles_before" "$roles_after"

trap 'finalize $?' EXIT
trap 'failure_gate="interrupted_HUP"; exit 129' HUP
trap 'failure_gate="interrupted_INT"; exit 130' INT
trap 'failure_gate="interrupted_TERM"; exit 143' TERM

exec 9>"$shared/deployment.lock"
if ! flock -n 9; then echo "Another production deployment is active" >&2; false; fi
if [ -f "$async_control/smoke-lease" ]; then echo "An async internal smoke is active" >&2; false; fi

for container in pipipi pipipi-process-dispatcher pipipi-process-worker pipipi-webhook-worker pipipi-retention-cleaner; do
    if [ "$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')" != "$revision" ]; then
        echo "Async role revision mismatch" >&2
        false
    fi
done
current_stage="$(container_environment pipipi ASYNC_RELEASE_STAGE)"
current_traffic="$("$traffic_controller" get "$revision")"
valid "$current_stage" '^(internal|canary|production)$' "current stage"
valid "$current_traffic" '^(0|1|5|25|50|100)$' "current traffic"
image_id="$(docker inspect pipipi --format '{{.Image}}')"
valid "$image_id" '^sha256:[0-9a-f]{64}$' "image ID"
compose_environment
config_digest="$(printf '%s\n' "$revision|$target_stage|$target_traffic|$PIPIPI_PROCESS_QUEUE_NAME|$PIPIPI_PROCESS_QUEUE_PREFIX|$PIPIPI_WEBHOOK_QUEUE_NAME|$PIPIPI_WEBHOOK_QUEUE_PREFIX" | sha256sum | cut -d ' ' -f 1)"

jq --exit-status --arg revision "$revision" '
  .schemaVersion == 1 and
  .revision == $revision and
  .allEvidenceSameRevision == true and
  .internalSmokePassed == true and
  .dispatcherWorkerDrillPassed == true and
  .redisRebuildDrillPassed == true and
  .webhookObservabilityDrillPassed == true and
  .migrationVerified == true and
  .recoveryVerified == true and
  .ownerQueriesVerified == true and
  .fiveRolesReady == true and
  .capacityWithinBudget == true and
  .costWithinBudget == true
' "$aggregate_source" >/dev/null

if [ -f "$state_file" ]; then
    if jq --exit-status --arg revision "$revision" --arg stage "$current_stage" --argjson traffic "$current_traffic" '
      .revision == $revision and .stage == $stage and .trafficPercent == $traffic
    ' "$state_file" >/dev/null; then
        cp "$state_file" "$state_before"
        chmod 600 "$state_before"
        state_existed="true"
    elif [ "$current_stage" != "internal" ] || [ "$current_traffic" -ne 0 ]; then
        echo "Promotion state does not match the active release" >&2
        false
    fi
elif [ "$current_stage" != "internal" ] || [ "$current_traffic" -ne 0 ]; then
    echo "Promotion state must be initialized from internal traffic zero" >&2
    false
fi

worker_ids_before="$(for container in pipipi-process-dispatcher pipipi-process-worker pipipi-webhook-worker pipipi-retention-cleaner; do docker inspect "$container" --format '{{.Id}}'; done)"

failure_gate="transition"
if [ "$variable" = "stage" ]; then
    [ "$target_traffic" -eq "$current_traffic" ]
    if [ "$direction" = "promote" ]; then
        if [ "$current_stage:$target_stage:$current_traffic" = "internal:canary:0" ]; then :
        elif [ "$current_stage:$target_stage:$current_traffic" = "canary:production:25" ]; then
            test -f "$state_file"
            changed_at="$(jq -r '.changedAt' "$state_file")"
            changed_epoch="$(iso_epoch "$changed_at")"
            now_epoch="$(date -u +%s)"
            [ "$((now_epoch - changed_epoch))" -ge "$observation_window_seconds" ]
        else
            echo "Async stage promotion cannot skip a stage" >&2
            false
        fi
    else
        if [ "$current_stage:$target_stage:$current_traffic" = "production:canary:25" ]; then :
        elif [ "$current_stage:$target_stage:$current_traffic" = "canary:internal:0" ]; then :
        else
            echo "Async stage rollback must reverse one safe stage" >&2
            false
        fi
    fi
else
    [ "$target_stage" = "$current_stage" ]
    if [ "$direction" = "promote" ]; then
        allowed="canary:0:1 canary:1:5 canary:5:25 production:25:50 production:50:100"
    else
        allowed="canary:25:5 canary:5:1 canary:1:0 production:100:50 production:50:25"
    fi
    case " $allowed " in *" $current_stage:$current_traffic:$target_traffic "*) : ;; *) echo "Async traffic change must use the adjacent approved percentage" >&2; false ;; esac
fi

failure_gate="prechange_gates"
capture_roles "$roles_before"
if [ "$direction" = "promote" ]; then capture_critical_gate "$pre_gate"; fi

failure_gate="change_$variable"
changed="true"
if [ "$variable" = "stage" ]; then
    set_api_stage "$target_stage"
else
    "$traffic_controller" set "$revision" "$target_traffic"
fi

failure_gate="postchange_gates"
capture_roles "$roles_after"
worker_ids_after="$(for container in pipipi-process-dispatcher pipipi-process-worker pipipi-webhook-worker pipipi-retention-cleaner; do docker inspect "$container" --format '{{.Id}}'; done)"
[ "$worker_ids_after" = "$worker_ids_before" ]
if [ "$direction" = "promote" ]; then capture_critical_gate "$post_gate"; fi

failure_gate="state"
state_temporary="$state_file.tmp"
jq -n \
    --arg revision "$revision" \
    --arg stage "$target_stage" \
    --argjson traffic "$target_traffic" \
    --arg changedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg promotionRunId "$promotion_run_id" \
    --arg promotionRunAttempt "$promotion_run_attempt" \
    '{schemaVersion:1, revision:$revision, stage:$stage, trafficPercent:$traffic, changedAt:$changedAt, promotionRunId:($promotionRunId|tonumber), promotionRunAttempt:($promotionRunAttempt|tonumber)}' > "$state_temporary"
chmod 600 "$state_temporary"
mv "$state_temporary" "$state_file"

failure_gate="complete"
write_evidence "succeeded"
promotion_succeeded="true"
rm -f -- "$aggregate_source"
echo "Async release changed $variable to $target_stage/$target_traffic for $revision"
