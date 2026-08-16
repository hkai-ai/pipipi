#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 14 ]; then
    echo "Expected 14 deployment arguments" >&2
    exit 1
fi

app_root="$1"
revision="$2"
candidate_ci_run_id="$3"
release_run_id="$4"
release_run_attempt="$5"
backup_id="$6"
recovery_actor_id="$7"
image_archive="$8"
base_compose_source="$9"
async_compose_source="${10}"
process_queue_name="${11}"
process_queue_prefix="${12}"
webhook_queue_name="${13}"
webhook_queue_prefix="${14}"

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
valid "$candidate_ci_run_id" '^[1-9][0-9]*$' "candidate CI run ID"
valid "$release_run_id" '^[1-9][0-9]*$' "release run ID"
valid "$release_run_attempt" '^[1-9][0-9]*$' "release run attempt"
valid "$backup_id" '^[A-Za-z0-9._:/@-]+$' "backup ID"
valid "$recovery_actor_id" '^[A-Za-z0-9._:/@-]+$' "recovery actor ID"
if [ "${#backup_id}" -gt 256 ] || [ "${#recovery_actor_id}" -gt 256 ]; then
    echo "Backup ID and recovery actor ID must not exceed 256 characters" >&2
    exit 1
fi
valid "$process_queue_name" '^[A-Za-z0-9_-]{1,128}$' "Process Queue name"
valid "$process_queue_prefix" '^[A-Za-z0-9:_-]{1,128}$' "Process Queue prefix"
valid "$webhook_queue_name" '^[A-Za-z0-9_-]{1,128}$' "Webhook Queue name"
valid "$webhook_queue_prefix" '^[A-Za-z0-9:_-]{1,128}$' "Webhook Queue prefix"

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
evidence_key="$revision-$release_run_id-$release_run_attempt"
evidence_directory="$shared/async-release-evidence/$evidence_key"
evidence_file="$evidence_directory/evidence.json"
precheck_log="$evidence_directory/environment-prechecks.jsonl"
database_audit_log="$evidence_directory/database.json"
migration_log="$evidence_directory/migration.json"
recovery_log="$evidence_directory/recovery.jsonl"
readiness_log="$evidence_directory/readiness.jsonl"
work_root="$shared/.async-release-work"
work_directory="$work_root/$evidence_key"
database_audit_candidate="$work_directory/database.json"
previous_base_compose="$work_directory/previous.compose.yaml"
previous_async_compose="$work_directory/previous.compose.async.yaml"
image="pipipi:$revision"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
failure_gate="preflight"
activation_started="false"
rollback_status="not_required"
previous_shape="unknown"
previous_image=""
previous_revision=""
image_id=""
archive_sha256=""
database_boundary_verified="false"
migration_applied_count="0"
migration_verified="false"
recovery_batch_count="0"
recovery_failed_count="0"
recovery_started_with_empty_cursor="false"
recovery_final_cursor_empty="false"
recovery_verified="false"
roles_verified="false"
release_succeeded="false"
finalization_started="false"

expected_prefix="/tmp/pipipi-async-$release_run_id-$release_run_attempt"
if [ "$image_archive" != "$expected_prefix.image.tar.gz" ] || \
    [ "$base_compose_source" != "$expected_prefix.compose.yaml" ] || \
    [ "$async_compose_source" != "$expected_prefix.compose.async.yaml" ]; then
    echo "Candidate files do not match the release attempt" >&2
    exit 1
fi

mkdir -p "$evidence_directory" "$work_root" "$work_directory"
chmod 700 "$evidence_directory" "$work_root" "$work_directory"
: > "$precheck_log"
: > "$database_audit_log"
: > "$migration_log"
: > "$recovery_log"
: > "$readiness_log"
chmod 600 \
    "$precheck_log" \
    "$database_audit_log" \
    "$migration_log" \
    "$recovery_log" \
    "$readiness_log"

write_evidence() {
    status="$1"
    completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    temporary="$evidence_file.tmp"
    printf '%s\n' \
        '{' \
        "  \"schemaVersion\": 1," \
        "  \"status\": \"$status\"," \
        "  \"failedGate\": \"$failure_gate\"," \
        "  \"candidateCommit\": \"$revision\"," \
        "  \"candidateCiRunId\": $candidate_ci_run_id," \
        "  \"releaseRunId\": $release_run_id," \
        "  \"releaseRunAttempt\": $release_run_attempt," \
        "  \"backupId\": \"$backup_id\"," \
        "  \"imageId\": \"$image_id\"," \
        "  \"imageArchiveSha256\": \"$archive_sha256\"," \
        "  \"previousShape\": \"$previous_shape\"," \
        "  \"previousRevision\": \"$previous_revision\"," \
        '  "releaseStage": "internal",' \
        "  \"processQueueName\": \"$process_queue_name\"," \
        "  \"processQueuePrefix\": \"$process_queue_prefix\"," \
        "  \"webhookQueueName\": \"$webhook_queue_name\"," \
        "  \"webhookQueuePrefix\": \"$webhook_queue_prefix\"," \
        "  \"databaseBoundaryVerified\": $database_boundary_verified," \
        "  \"migrationAppliedCount\": $migration_applied_count," \
        "  \"migrationVerified\": $migration_verified," \
        "  \"recoveryStartedWithEmptyCursor\": $recovery_started_with_empty_cursor," \
        "  \"recoveryBatchCount\": $recovery_batch_count," \
        "  \"recoveryFailedCount\": $recovery_failed_count," \
        "  \"recoveryFinalCursorEmpty\": $recovery_final_cursor_empty," \
        "  \"recoveryVerified\": $recovery_verified," \
        "  \"rolesVerified\": $roles_verified," \
        "  \"rollbackStatus\": \"$rollback_status\"," \
        "  \"startedAt\": \"$started_at\"," \
        "  \"completedAt\": \"$completed_at\"" \
        '}' > "$temporary"
    chmod 600 "$temporary"
    mv "$temporary" "$evidence_file"
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
    export PIPIPI_PROCESS_QUEUE_NAME="$process_queue_name"
    export PIPIPI_PROCESS_QUEUE_PREFIX="$process_queue_prefix"
    export PIPIPI_WEBHOOK_QUEUE_NAME="$webhook_queue_name"
    export PIPIPI_WEBHOOK_QUEUE_PREFIX="$webhook_queue_prefix"
    export PIPIPI_ASYNC_RELEASE_STAGE="internal"
}

compose_up_async() {
    PIPIPI_IMAGE="$1" PIPIPI_REVISION="$2" \
        docker compose --project-name pipipi \
        --env-file /dev/null \
        --file "$base_compose" \
        --file "$async_compose" \
        up -d --force-recreate --no-build --wait --wait-timeout 180 "${@:3}"
}

compose_up_sync() {
    PIPIPI_IMAGE="$1" PIPIPI_REVISION="$2" \
        docker compose --project-name pipipi \
        --env-file /dev/null \
        --file "$base_compose" \
        up -d --force-recreate --no-build --remove-orphans \
        --wait --wait-timeout 180
}

container_environment() {
    container="$1"
    name="$2"
    docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' |
        awk -F= -v name="$name" '$1 == name { sub(/^[^=]*=/, ""); print; found = 1 } END { if (!found) exit 1 }'
}

rollback_deployment() {
    if [ ! -f "$previous_base_compose" ]; then
        return 1
    fi
    install -m 600 "$previous_base_compose" "$base_compose" || return 1
    if [ "$previous_shape" = "async" ]; then
        if [ ! -f "$previous_async_compose" ]; then
            return 1
        fi
        install -m 600 "$previous_async_compose" "$async_compose" || return 1
        compose_up_async "$previous_image" "$previous_revision" || return 1
        return 0
    fi
    rm -f "$async_compose" || return 1
    compose_up_sync "$previous_image" "$previous_revision" || return 1
}

finalize_release() {
    exit_code="$1"
    if [ "$finalization_started" = "true" ]; then
        return
    fi
    finalization_started="true"
    trap - ERR EXIT HUP INT TERM
    set +e
    if [ "$exit_code" -ne 0 ] && [ "$activation_started" = "true" ]; then
        if rollback_deployment; then
            rollback_status="succeeded"
        else
            rollback_status="failed"
        fi
    fi
    if [ "$release_succeeded" != "true" ]; then
        write_evidence "failed"
        echo "Async internal release failed at gate: $failure_gate" >&2
    fi
    rm -f -- \
        "$image_archive" \
        "$base_compose_source" \
        "$async_compose_source" \
        "$database_audit_candidate" \
        "$previous_base_compose" \
        "$previous_async_compose"
    rmdir "$work_directory" "$work_root" 2>/dev/null || true
    exit "$exit_code"
}

on_signal() {
    signal="$1"
    exit_code="$2"
    failure_gate="interrupted_$signal"
    exit "$exit_code"
}

trap 'finalize_release $?' EXIT
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

failure_gate="preflight"
command -v docker >/dev/null
docker compose version >/dev/null
command -v flock >/dev/null
command -v jq >/dev/null
for required_file in \
    "$image_archive" \
    "$base_compose_source" \
    "$async_compose_source" \
    "$shared_env" \
    "$api_env" \
    "$dispatcher_env" \
    "$worker_env" \
    "$webhook_env" \
    "$retention_env" \
    "$database_ca"; do
    if [ ! -f "$required_file" ]; then
        echo "Missing required release file" >&2
        false
    fi
done
mkdir -p "$business_data" "$run_records" "$async_control"
chmod 700 "$business_data" "$run_records"
chmod 755 "$async_control"
compose_environment

lock_file="$shared/deployment.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
    echo "Another production deployment is active" >&2
    false
fi
if [ -f "$async_control/smoke-lease" ]; then
    echo "An async internal smoke is active" >&2
    false
fi

if ! docker inspect pipipi >/dev/null 2>&1; then
    echo "A current API deployment is required for rollback" >&2
    false
fi
previous_image="$(docker inspect pipipi --format '{{.Config.Image}}')"
previous_revision="$(docker inspect pipipi --format '{{index .Config.Labels "com.pipipi.revision"}}')"
valid "$previous_revision" '^[0-9a-f]{40}$' "previous revision"
cp -p "$base_compose" "$previous_base_compose"

async_role_count="0"
for container in \
    pipipi-process-dispatcher \
    pipipi-process-worker \
    pipipi-webhook-worker \
    pipipi-retention-cleaner; do
    if docker inspect "$container" >/dev/null 2>&1; then
        async_role_count="$((async_role_count + 1))"
    fi
done
if [ "$async_role_count" -eq 0 ]; then
    previous_shape="sync"
elif [ "$async_role_count" -eq 4 ] && [ -f "$async_compose" ]; then
    previous_shape="async"
    cp -p "$async_compose" "$previous_async_compose"
    for container in \
        pipipi \
        pipipi-business-api \
        pipipi-process-dispatcher \
        pipipi-process-worker \
        pipipi-webhook-worker \
        pipipi-retention-cleaner; do
        if [ "$(docker inspect "$container" --format '{{.Config.Image}}')" != "$previous_image" ] || \
            [ "$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')" != "$previous_revision" ]; then
            echo "Existing async deployment revisions are inconsistent" >&2
            false
        fi
    done
    if [ "$(container_environment pipipi-process-dispatcher PROCESS_QUEUE_NAME)" != "$process_queue_name" ] || \
        [ "$(container_environment pipipi-process-dispatcher PROCESS_QUEUE_PREFIX)" != "$process_queue_prefix" ] || \
        [ "$(container_environment pipipi-process-worker PROCESS_QUEUE_NAME)" != "$process_queue_name" ] || \
        [ "$(container_environment pipipi-process-worker PROCESS_QUEUE_PREFIX)" != "$process_queue_prefix" ] || \
        [ "$(container_environment pipipi-webhook-worker WEBHOOK_QUEUE_NAME)" != "$webhook_queue_name" ] || \
        [ "$(container_environment pipipi-webhook-worker WEBHOOK_QUEUE_PREFIX)" != "$webhook_queue_prefix" ]; then
        echo "Candidate Queue configuration differs from the active async shape" >&2
        false
    fi
    if [ "$(container_environment pipipi ASYNC_RELEASE_STAGE)" != "internal" ] || \
        [ "$(container_environment pipipi ASYNC_PROCESS_RUNS_ENABLED)" != "true" ]; then
        echo "Async internal release cannot replace another release stage" >&2
        false
    fi
else
    echo "Existing async deployment shape is incomplete" >&2
    false
fi

failure_gate="candidate_image"
archive_sha256="$(sha256sum "$image_archive" | cut -d ' ' -f 1)"
gzip -dc "$image_archive" | docker load >/dev/null
image_id="$(docker image inspect "$image" --format '{{.Id}}')"
valid "$image_id" '^sha256:[0-9a-f]{64}$' "candidate image ID"

failure_gate="compose_shape"
PIPIPI_IMAGE="$image" PIPIPI_REVISION="$revision" \
    docker compose --project-name pipipi \
    --env-file /dev/null \
    --file "$base_compose_source" \
    --file "$async_compose_source" config --quiet

failure_gate="environment_prechecks"
: > "$precheck_log"
docker run --rm --env-file "$shared_env" \
    --env IMAGE_PROVIDER=fal \
    --env OBJECT_STORAGE_PROVIDER=aliyun-oss \
    --entrypoint node "$image_id" \
    dist/bin/check-deployment-environment.js crt-business-api >> "$precheck_log"
docker run --rm --env-file "$api_env" \
    --env ASYNC_PROCESS_RUNS_ENABLED=true \
    --env ASYNC_RELEASE_STAGE=internal \
    --env CONSOLE_ENABLED=true \
    --env PROCESS_RUN_RECORD_STORE=postgres \
    --env CRT_BUSINESS_API_BASE_URL=http://127.0.0.1:4400 \
    --entrypoint node "$image_id" \
    dist/bin/check-deployment-environment.js api >> "$precheck_log"
docker run --rm --env-file "$dispatcher_env" \
    --env PROCESS_QUEUE_NAME="$process_queue_name" \
    --env PROCESS_QUEUE_PREFIX="$process_queue_prefix" \
    --entrypoint node "$image_id" \
    dist/bin/check-deployment-environment.js process-dispatcher >> "$precheck_log"
docker run --rm --env-file "$worker_env" \
    --env CRT_BUSINESS_API_BASE_URL=http://127.0.0.1:4400 \
    --env PROCESS_QUEUE_NAME="$process_queue_name" \
    --env PROCESS_QUEUE_PREFIX="$process_queue_prefix" \
    --env PROCESS_RUN_RECORD_STORE=postgres \
    --env PROCESS_RUN_RECORD_CONTENT=accepted-input-and-output \
    --entrypoint node "$image_id" \
    dist/bin/check-deployment-environment.js process-worker >> "$precheck_log"
docker run --rm --env-file "$webhook_env" \
    --env WEBHOOK_QUEUE_NAME="$webhook_queue_name" \
    --env WEBHOOK_QUEUE_PREFIX="$webhook_queue_prefix" \
    --entrypoint node "$image_id" \
    dist/bin/check-deployment-environment.js webhook-worker >> "$precheck_log"
docker run --rm --env-file "$retention_env" \
    --entrypoint node "$image_id" \
    dist/bin/check-deployment-environment.js retention-cleaner >> "$precheck_log"

failure_gate="database_boundary"
docker run --rm --network host --env-file "$dispatcher_env" \
    --volume "$database_ca:/etc/pipipi/pg-server.crt:ro" \
    --entrypoint npm "$image_id" \
    run --silent audit:production-database \
    > "$database_audit_candidate" 2>/dev/null
jq --exit-status '
    type == "object" and
    (keys | sort) == ([
        "event", "databaseIdentitySha256", "tlsVerified",
        "dedicatedDatabaseVerified", "nonSuperuserVerified",
        "administrativePrivilegesAbsent", "otherDatabaseAccessAbsent",
        "roleMembershipAbsent", "roleSwitchingAbsent"
    ] | sort) and
    .event == "production_database_identity_verified" and
    (.databaseIdentitySha256 | test("^[0-9a-f]{64}$")) and
    .tlsVerified == true and
    .dedicatedDatabaseVerified == true and
    .nonSuperuserVerified == true and
    .administrativePrivilegesAbsent == true and
    .otherDatabaseAccessAbsent == true and
    .roleMembershipAbsent == true and
    .roleSwitchingAbsent == true
' "$database_audit_candidate" >/dev/null
install -m 600 -- "$database_audit_candidate" "$database_audit_log"
database_boundary_verified="true"

failure_gate="database_migration"
docker run --rm --network host --env-file "$dispatcher_env" \
    --volume "$database_ca:/etc/pipipi/pg-server.crt:ro" \
    --entrypoint node "$image_id" \
    dist/bin/migrate-and-verify.js > "$migration_log"
migration_summary="$(docker run --rm -i --entrypoint node "$image_id" -e '
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (record.event !== "database_migration_verified" || record.verificationCount !== 0) process.exit(1);
process.stdout.write(String(record.appliedCount));
' < "$migration_log")"
valid "$migration_summary" '^[0-9]+$' "migration summary"
migration_applied_count="$migration_summary"
migration_verified="true"

failure_gate="queue_recovery"
recovery_started_with_empty_cursor="true"
docker run --rm --network host --env-file "$dispatcher_env" \
    --env PROCESS_QUEUE_NAME="$process_queue_name" \
    --env PROCESS_QUEUE_PREFIX="$process_queue_prefix" \
    --env PROCESS_RECOVERY_ACTOR_ID="$recovery_actor_id" \
    --volume "$database_ca:/etc/pipipi/pg-server.crt:ro" \
    --entrypoint node "$image_id" \
    dist/bin/recover.js --dry-run --mode=all > "$recovery_log"
recovery_summary="$(docker run --rm -i --entrypoint node "$image_id" -e '
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const reports = Buffer.concat(chunks).toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
if (reports.length === 0) process.exit(1);
if (reports.some((report) => report.event !== "process_queue_recovery_batch_completed" || report.trigger !== "manual" || report.mode !== "all" || report.dryRun !== true)) process.exit(1);
const failed = reports.reduce((total, report) => total + report.failed, 0);
if (failed !== 0 || reports.at(-1).nextCursor !== undefined) process.exit(1);
process.stdout.write(`${reports.length} ${failed}`);
' < "$recovery_log")"
read -r recovery_batch_count recovery_failed_count <<< "$recovery_summary"
valid "$recovery_batch_count" '^[1-9][0-9]*$' "recovery batch count"
if [ "$recovery_failed_count" -ne 0 ]; then
    echo "Queue Recovery reported failed items" >&2
    false
fi
recovery_final_cursor_empty="true"
recovery_verified="true"

failure_gate="background_activation"
activation_started="true"
install -m 600 "$base_compose_source" "$base_compose"
install -m 600 "$async_compose_source" "$async_compose"
compose_up_async "$image" "$revision" \
    business-api retention-cleaner process-dispatcher process-worker webhook-worker

failure_gate="api_activation"
compose_up_async "$image" "$revision" --no-deps api

failure_gate="role_verification"
: > "$readiness_log"
for role_and_port in \
    'api 4300' \
    'process-dispatcher 4310' \
    'process-worker 4320' \
    'webhook-worker 4350' \
    'retention-cleaner 4340'; do
    read -r role port <<< "$role_and_port"
    curl --fail --silent --show-error \
        "http://127.0.0.1:$port/readyz" >> "$readiness_log"
    printf '\n' >> "$readiness_log"
done

for container in \
    pipipi \
    pipipi-business-api \
    pipipi-process-dispatcher \
    pipipi-process-worker \
    pipipi-webhook-worker \
    pipipi-retention-cleaner; do
    actual_image_id="$(docker inspect "$container" --format '{{.Image}}')"
    actual_revision="$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')"
    if [ "$actual_image_id" != "$image_id" ] || [ "$actual_revision" != "$revision" ]; then
        echo "Runtime role revision mismatch" >&2
        false
    fi
done

if [ "$(container_environment pipipi ASYNC_RELEASE_STAGE)" != "internal" ] || \
    [ "$(container_environment pipipi ASYNC_PROCESS_RUNS_ENABLED)" != "true" ] || \
    [ "$(container_environment pipipi-process-dispatcher PROCESS_QUEUE_NAME)" != "$process_queue_name" ] || \
    [ "$(container_environment pipipi-process-dispatcher PROCESS_QUEUE_PREFIX)" != "$process_queue_prefix" ] || \
    [ "$(container_environment pipipi-process-worker PROCESS_QUEUE_NAME)" != "$process_queue_name" ] || \
    [ "$(container_environment pipipi-process-worker PROCESS_QUEUE_PREFIX)" != "$process_queue_prefix" ] || \
    [ "$(container_environment pipipi-webhook-worker WEBHOOK_QUEUE_NAME)" != "$webhook_queue_name" ] || \
    [ "$(container_environment pipipi-webhook-worker WEBHOOK_QUEUE_PREFIX)" != "$webhook_queue_prefix" ]; then
    echo "Runtime role stage or Queue configuration mismatch" >&2
    false
fi
roles_verified="true"

failure_gate="complete"
rollback_status="not_required"
write_evidence "succeeded"
release_succeeded="true"
echo "Async internal release completed for revision $revision"
