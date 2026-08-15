#!/usr/bin/env bash

set -Eeuo pipefail

emit_invalid_request() {
    printf '%s\n' '{"schemaVersion":1,"event":"async_production_environment_provisioned","status":"failed","mode":null,"activeRevision":null,"candidateRevision":null,"changeReference":null,"candidateVerified":false,"applied":false,"rollbackStatus":"not_required","cleanupStatus":"not_required","databaseConfigurationSource":"not_observed","redisConfigurationSource":"not_observed","failureReason":"invalid_request"}'
}

if [ "$#" -ne 9 ]; then
    emit_invalid_request
    exit 64
fi

app_root="$1"
active_revision="$2"
candidate_revision="$3"
mode="$4"
process_queue_name="$5"
process_queue_prefix="$6"
webhook_queue_name="$7"
webhook_queue_prefix="$8"
change_reference="$9"
wrapped="/${app_root#/}/"

if ! [[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    [ "$app_root" = / ] ||
    [[ "$app_root" == *//* ]] ||
    [[ "$wrapped" == */./* ]] ||
    [[ "$wrapped" == */../* ]] ||
    [[ "$app_root" == */ ]] ||
    ! [[ "$active_revision" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$candidate_revision" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$mode" =~ ^(plan|apply)$ ]] ||
    ! [[ "$process_queue_name" =~ ^[A-Za-z0-9_-]{1,128}$ ]] ||
    ! [[ "$process_queue_prefix" =~ ^[A-Za-z0-9:_-]{1,128}$ ]] ||
    ! [[ "$webhook_queue_name" =~ ^[A-Za-z0-9_-]{1,128}$ ]] ||
    ! [[ "$webhook_queue_prefix" =~ ^[A-Za-z0-9:_-]{1,128}$ ]] ||
    ! [[ "$change_reference" =~ ^issue-[1-9][0-9]{0,9}$ ]]; then
    emit_invalid_request
    exit 64
fi

shared="$app_root/shared"
shared_env="$shared/.env"
database_ca="$shared/pg-server.crt"
image="pipipi:$candidate_revision"
api_env="$shared/async-api.env"
dispatcher_env="$shared/process-dispatcher.env"
worker_env="$shared/process-worker.env"
webhook_env="$shared/webhook-worker.env"
retention_env="$shared/retention-cleaner.env"
targets=("$api_env" "$dispatcher_env" "$worker_env" "$webhook_env" "$retention_env")
work_directory=""
candidates=()
applied=false
completed=false
success_ready=false
failure_reason=""
database_configuration_source="not_observed"
redis_configuration_source="not_observed"

emit_result() {
    local status="$1"
    local rollback_status="$2"
    local cleanup_status="$3"
    jq -n \
        --arg activeRevision "$active_revision" \
        --arg candidateRevision "$candidate_revision" \
        --arg changeReference "$change_reference" \
        --arg cleanupStatus "$cleanup_status" \
        --arg databaseConfigurationSource "$database_configuration_source" \
        --arg failureReason "$failure_reason" \
        --arg mode "$mode" \
        --arg redisConfigurationSource "$redis_configuration_source" \
        --arg rollbackStatus "$rollback_status" \
        --arg status "$status" \
        --argjson applied "$applied" '
        {
            schemaVersion: 1,
            event: "async_production_environment_provisioned",
            status: $status,
            mode: $mode,
            activeRevision: $activeRevision,
            candidateRevision: $candidateRevision,
            changeReference: $changeReference,
            candidateVerified: ($status == "succeeded"),
            applied: $applied,
            rollbackStatus: $rollbackStatus,
            cleanupStatus: $cleanupStatus,
            databaseConfigurationSource: $databaseConfigurationSource,
            redisConfigurationSource: $redisConfigurationSource
        }
        + if $status == "failed" then { failureReason: $failureReason } else {} end
    '
}

cleanup() {
    local exit_code="$1"
    local index=0
    local rollback_status="not_required"
    local cleanup_status="succeeded"
    local target=""
    local candidate=""
    trap - ERR EXIT HUP INT TERM
    set +e
    set +u
    if [ "$completed" != true ]; then
        for index in 0 1 2 3 4; do
            target="${targets[$index]}"
            candidate="${candidates[$index]:-}"
            if [ -n "$work_directory" ] && [ -n "$candidate" ] &&
                [ "$target" -ef "$candidate" ]; then
                if [ "$rollback_status" = not_required ]; then
                    rollback_status="succeeded"
                fi
                rm -f -- "$target" >/dev/null 2>&1
                if [ "$target" -ef "$candidate" ]; then
                    rollback_status="failed"
                fi
            fi
        done
    fi
    if [ -n "$work_directory" ] && [ -e "$work_directory" ]; then
        rm -f -- "$work_directory"/* 2>/dev/null
        rmdir -- "$work_directory" 2>/dev/null
        if [ -e "$work_directory" ]; then
            cleanup_status="failed"
        fi
    fi
    if [ "$exit_code" -ne 0 ] || [ "$success_ready" != true ] ||
        [ "$rollback_status" = failed ] || [ "$cleanup_status" = failed ]; then
        if [ -z "$failure_reason" ]; then
            if [ "$rollback_status" = failed ]; then
                failure_reason="rollback_failed"
            elif [ "$cleanup_status" = failed ]; then
                failure_reason="cleanup_failed"
            else
                failure_reason="unexpected_failure"
            fi
        fi
        if ! emit_result failed "$rollback_status" "$cleanup_status"; then
            exit_code=1
        fi
        if [ "$exit_code" -eq 0 ]; then
            exit_code=1
        fi
    else
        if ! emit_result succeeded "$rollback_status" "$cleanup_status"; then
            exit_code=1
        fi
    fi
    exit "$exit_code"
}

unexpected_failure() {
    local exit_code="$?"
    trap - ERR
    if [ -z "$failure_reason" ]; then
        failure_reason="unexpected_failure"
    fi
    exit "$exit_code"
}

provision_failure() {
    trap - ERR
    failure_reason="$1"
    exit 1
}

on_signal() {
    local signal="$1"
    local exit_code="$2"
    trap - ERR
    failure_reason="interrupted_$signal"
    exit "$exit_code"
}

trap unexpected_failure ERR
trap 'cleanup $?' EXIT
trap 'on_signal HUP 129' HUP
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

database_url=""
redis_url=""
if ! IFS= read -r -d '' database_url || ! IFS= read -r -d '' redis_url; then
    provision_failure "invalid_secret_payload"
fi
if [[ "$database_url" == *$'\n'* ]] || [[ "$database_url" == *$'\r'* ]] ||
    [[ "$redis_url" == *$'\n'* ]] || [[ "$redis_url" == *$'\r'* ]]; then
    provision_failure "invalid_secret_payload"
fi
if [ -n "$database_url" ]; then
    database_configuration_source="protected_override"
fi
if [ -n "$redis_url" ]; then
    redis_configuration_source="protected_override"
fi

file_restricted() {
    [ -f "$1" ] && [ ! -L "$1" ] &&
        [ "$(stat -c '%u:%g:%a' "$1" 2>/dev/null)" = "0:0:600" ]
}

container_running_at_revision() {
    local container="$1"
    docker inspect "$container" 2>/dev/null | jq -e --arg revision "$active_revision" '
        length == 1 and
        .[0].State.Running == true and
        .[0].Config.Labels["com.pipipi.revision"] == $revision
    ' >/dev/null
}

api_sync_intake_disabled() {
    docker inspect pipipi 2>/dev/null | jq -e --arg revision "$active_revision" '
        length == 1 and
        .[0].State.Running == true and
        .[0].Config.Labels["com.pipipi.revision"] == $revision and
        ([
            .[0].Config.Env[] |
            select(startswith("ASYNC_PROCESS_RUNS_ENABLED="))
        ] == ["ASYNC_PROCESS_RUNS_ENABLED=false"])
    ' >/dev/null
}

if ! file_restricted "$shared_env" ||
    [ ! -f "$database_ca" ] || [ -L "$database_ca" ]; then
    provision_failure "shared_production_inputs_invalid"
fi
if ! command -v flock >/dev/null 2>&1; then
    provision_failure "deployment_lock_unavailable"
fi
exec 9>"$shared/deployment.lock"
if ! flock -n 9; then
    provision_failure "deployment_lock_unavailable"
fi
if ! file_restricted "$shared_env" ||
    [ ! -f "$database_ca" ] || [ -L "$database_ca" ]; then
    provision_failure "shared_production_inputs_changed"
fi
shared_env_identity="$(stat -c '%d:%i' "$shared_env" 2>/dev/null || true)"
shared_env_digest="$(sha256sum "$shared_env" 2>/dev/null | awk 'NR == 1 { print $1 }')"
if ! [[ "$shared_env_identity" =~ ^[0-9]+:[0-9]+$ ]] ||
    ! [[ "$shared_env_digest" =~ ^[0-9a-f]{64}$ ]]; then
    provision_failure "shared_production_inputs_invalid"
fi

shared_environment_unchanged() {
    local current_identity=""
    local current_digest=""
    if ! file_restricted "$shared_env"; then
        return 1
    fi
    current_identity="$(stat -c '%d:%i' "$shared_env" 2>/dev/null || true)"
    current_digest="$(sha256sum "$shared_env" 2>/dev/null | awk 'NR == 1 { print $1 }')"
    [ "$current_identity" = "$shared_env_identity" ] &&
        [ "$current_digest" = "$shared_env_digest" ]
}

standard_connection_defined_once() {
    local key="$1"
    awk -v key="$key" '
        index($0, key "=") == 1 {
            count++
        }
        END {
            if (count != 1) exit 1
        }
    ' "$shared_env"
}

if ! api_sync_intake_disabled || ! container_running_at_revision pipipi-business-api; then
    provision_failure "current_sync_shape_invalid"
fi
for container in \
    pipipi-process-dispatcher \
    pipipi-process-worker \
    pipipi-webhook-worker \
    pipipi-retention-cleaner; do
    if docker inspect "$container" >/dev/null 2>&1; then
        provision_failure "current_sync_shape_invalid"
    fi
done
for target in "${targets[@]}"; do
    if [ -e "$target" ] || [ -L "$target" ]; then
        provision_failure "role_environment_already_exists"
    fi
done

candidate_image_id=""
if ! candidate_image_id="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" ||
    ! [[ "$candidate_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    provision_failure "candidate_image_invalid"
fi

if ! work_directory="$(mktemp -d "$shared/.async-environment-provision.XXXXXX")" ||
    ! [[ "$work_directory" == "$shared/.async-environment-provision."* ]]; then
    provision_failure "candidate_workspace_failed"
fi
chmod 700 "$work_directory"

if [ -z "$database_url" ] || [ -z "$redis_url" ]; then
    connection_probe="$work_directory/connection-probe.compose.yaml"
    resolved_connections="$work_directory/resolved-connections.json"
    printf '%s\n' \
        'services:' \
        '  connection-probe:' \
        "    image: \"$candidate_image_id\"" \
        '    env_file:' \
        "      - \"$shared_env\"" > "$connection_probe"
    chmod 600 "$connection_probe"
    if ! docker compose --project-name pipipi-async-environment-probe \
        --env-file /dev/null \
        --file "$connection_probe" \
        config --format json > "$resolved_connections" 2>/dev/null; then
        provision_failure "standard_connection_resolution_failed"
    fi
    chmod 600 "$resolved_connections"
    if [ -z "$database_url" ]; then
        if ! standard_connection_defined_once DATABASE_URL ||
            ! database_url="$(jq -er '.services["connection-probe"].environment.DATABASE_URL | select(type == "string" and length > 0)' "$resolved_connections" 2>/dev/null)"; then
            provision_failure "standard_database_url_unavailable"
        fi
        database_configuration_source="shared_environment"
    fi
    if [ -z "$redis_url" ]; then
        if ! standard_connection_defined_once REDIS_URL ||
            ! redis_url="$(jq -er '.services["connection-probe"].environment.REDIS_URL | select(type == "string" and length > 0)' "$resolved_connections" 2>/dev/null)"; then
            provision_failure "standard_redis_url_unavailable"
        fi
        redis_configuration_source="shared_environment"
    fi
    if [[ "$database_url" == *$'\n'* ]] || [[ "$database_url" == *$'\r'* ]] ||
        [[ "$redis_url" == *$'\n'* ]] || [[ "$redis_url" == *$'\r'* ]]; then
        provision_failure "standard_connection_resolution_failed"
    fi
fi

api_candidate="$work_directory/async-api.env"
dispatcher_candidate="$work_directory/process-dispatcher.env"
worker_candidate="$work_directory/process-worker.env"
webhook_candidate="$work_directory/webhook-worker.env"
retention_candidate="$work_directory/retention-cleaner.env"
shared_candidate="$work_directory/shared.env"
candidates=(
    "$api_candidate"
    "$dispatcher_candidate"
    "$worker_candidate"
    "$webhook_candidate"
    "$retention_candidate"
    "$shared_candidate"
)
for candidate in "${candidates[@]}"; do
    : > "$candidate"
    chmod 600 "$candidate"
done

replace_database_url() {
    local source="$1"
    local destination="$2"
    local line=""
    local count=0
    : > "$destination"
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" == DATABASE_URL=* ]]; then
            count=$((count + 1))
            printf '%s\n' "DATABASE_URL=$database_url" >> "$destination"
        else
            printf '%s\n' "$line" >> "$destination"
        fi
    done < "$source"
    [ "$count" -eq 1 ]
}

if ! replace_database_url "$shared_env" "$shared_candidate"; then
    provision_failure "shared_database_url_invalid"
fi

append_owned_key() {
    local source="$1"
    local key="$2"
    local destination="$3"
    awk -v key="$key" '
        index($0, key "=") == 1 { count++; value = $0 }
        END {
            if (count > 1) exit 2
            if (count == 1) print value
        }
    ' "$source" >> "$destination"
}

agent_keys=(
    BUSINESS_API_BASE_URL
    OPENAI_API_KEY
    OPENAI_BASE_URL
    OPENAI_API_MODE
    PI_PROVIDER
    PI_MODEL
    PI_AGENT_DIR
    PI_SKILL_DIRECTORY
    PI_POSTER_SKILL_DIRECTORY
    PI_CRT_SKILL_DIRECTORY
    PI_PALE_WATERCOLOR_SKILL_DIRECTORY
    PI_RAW_HUMANISM_SKILL_DIRECTORY
    PI_NARRATIVE_MONUMENT_SKILL_DIRECTORY
    CONTENT_PROCESSING_MODE
    BUSINESS_API_TIMEOUT_MS
    POSTER_API_TIMEOUT_MS
    CRT_API_TIMEOUT_MS
    NEWS_IMAGE_API_TIMEOUT_MS
    PROCESS_TIMEOUT_MS
    PROCESS_RUN_LOG_LEVEL
    TITLED_CONTENT_SEPARATOR
    PROCESS_RUN_RECORD_POOL_MAX
    PROCESS_RUN_OBSERVATION_TIMEOUT_MS
    PROCESS_RUN_RECORD_RETENTION_DAYS
    CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS
    CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS
    CONTENT_PROCESSING_RETRY_MAX_DELAY_MS
)
for key in "${agent_keys[@]}"; do
    append_owned_key "$shared_env" "$key" "$api_candidate"
    append_owned_key "$shared_env" "$key" "$worker_candidate"
done

gateway_secret="$(openssl rand -base64 48 | tr -d '\n')"
webhook_secret="$(openssl rand -base64 32 | tr -d '\n')"
printf '%s\n' \
    "DATABASE_URL=$database_url" \
    "ASYNC_GATEWAY_SHARED_SECRET=$gateway_secret" \
    'PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS=86400000' \
    'PROCESS_RUN_RESULT_RETENTION_MS=604800000' \
    'PROCESS_RUN_METADATA_RETENTION_MS=2592000000' \
    'ASYNC_GLOBAL_BACKLOG_LIMIT=1000' \
    'ASYNC_CALLER_BACKLOG_LIMIT=100' \
    'ASYNC_BACKLOG_RETRY_AFTER_SECONDS=5' >> "$api_candidate"
printf '%s\n' \
    "DATABASE_URL=$database_url" \
    "REDIS_URL=$redis_url" >> "$dispatcher_candidate"
printf '%s\n' \
    "DATABASE_URL=$database_url" \
    "REDIS_URL=$redis_url" \
    'PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS=86400000' \
    'PROCESS_RUN_RESULT_RETENTION_MS=604800000' \
    'PROCESS_RUN_METADATA_RETENTION_MS=2592000000' >> "$worker_candidate"
printf '%s\n' \
    "DATABASE_URL=$database_url" \
    "REDIS_URL=$redis_url" \
    "WEBHOOK_SECRET_ENCRYPTION_KEY=$webhook_secret" >> "$webhook_candidate"
printf '%s\n' "DATABASE_URL=$database_url" >> "$retention_candidate"

for candidate in "${candidates[@]}"; do
    if ! file_restricted "$candidate"; then
        provision_failure "candidate_environment_invalid"
    fi
done

if ! docker run --rm --network none --env-file "$dispatcher_candidate" \
    --entrypoint node "$candidate_image_id" -e '
const database = new URL(process.env.DATABASE_URL ?? "");
const redis = new URL(process.env.REDIS_URL ?? "");
const exactly = (url, key, value) => {
    const values = url.searchParams.getAll(key);
    return values.length === 1 && values[0] === value;
};
if (!["postgres:", "postgresql:"].includes(database.protocol)) process.exit(1);
if (!database.username || !database.password || !database.hostname) process.exit(1);
const databaseName = decodeURIComponent(database.pathname.slice(1));
if (!databaseName || databaseName.includes("/")) process.exit(1);
const allowedDatabaseParameters = new Set(["uselibpqcompat", "sslmode", "sslrootcert"]);
for (const key of database.searchParams.keys()) {
    if (!allowedDatabaseParameters.has(key)) process.exit(1);
}
if (!exactly(database, "uselibpqcompat", "true")) process.exit(1);
if (!exactly(database, "sslmode", "verify-ca")) process.exit(1);
if (!exactly(database, "sslrootcert", "/etc/pipipi/pg-server.crt")) process.exit(1);
if (redis.protocol !== "rediss:" || !redis.hostname || !redis.password) process.exit(1);
' >/dev/null 2>&1; then
    provision_failure "connection_contract_invalid"
fi

database_audit="$work_directory/database-audit.json"
if ! docker run --rm --network host --env-file "$dispatcher_candidate" \
    --volume "$database_ca:/etc/pipipi/pg-server.crt:ro" \
    --entrypoint npm "$candidate_image_id" \
    run --silent audit:production-database \
    > "$database_audit" 2>/dev/null ||
    ! jq -e '
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
    ' "$database_audit" >/dev/null 2>&1; then
    provision_failure "database_boundary_invalid"
fi

run_preflight() {
    local role="$1"
    local env_file="$2"
    shift 2
    docker run --rm --network none --env-file "$env_file" "$@" \
        --entrypoint node "$candidate_image_id" \
        dist/bin/check-deployment-environment.js "$role" \
        >/dev/null 2>&1
}

if ! run_preflight api "$api_candidate" \
    --env ASYNC_PROCESS_RUNS_ENABLED=true \
    --env ASYNC_RELEASE_STAGE=internal \
    --env CONSOLE_ENABLED=true \
    --env PROCESS_RUN_RECORD_STORE=postgres \
    --env CRT_BUSINESS_API_BASE_URL=http://127.0.0.1:4400; then
    provision_failure "api_preflight_failed"
fi
if ! run_preflight process-dispatcher "$dispatcher_candidate" \
    --env PROCESS_QUEUE_NAME="$process_queue_name" \
    --env PROCESS_QUEUE_PREFIX="$process_queue_prefix"; then
    provision_failure "dispatcher_preflight_failed"
fi
if ! run_preflight process-worker "$worker_candidate" \
    --env CRT_BUSINESS_API_BASE_URL=http://127.0.0.1:4400 \
    --env PROCESS_QUEUE_NAME="$process_queue_name" \
    --env PROCESS_QUEUE_PREFIX="$process_queue_prefix" \
    --env PROCESS_RUN_RECORD_STORE=postgres \
    --env PROCESS_RUN_RECORD_CONTENT=accepted-input-and-output; then
    provision_failure "worker_preflight_failed"
fi
if ! run_preflight webhook-worker "$webhook_candidate" \
    --env WEBHOOK_QUEUE_NAME="$webhook_queue_name" \
    --env WEBHOOK_QUEUE_PREFIX="$webhook_queue_prefix"; then
    provision_failure "webhook_preflight_failed"
fi
if ! run_preflight retention-cleaner "$retention_candidate"; then
    provision_failure "retention_preflight_failed"
fi

if [ "$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true)" != "$candidate_image_id" ]; then
    provision_failure "candidate_image_changed"
fi
if ! shared_environment_unchanged; then
    provision_failure "shared_environment_changed"
fi

if [ "$mode" = apply ]; then
    if ! api_sync_intake_disabled || ! container_running_at_revision pipipi-business-api; then
        provision_failure "current_sync_shape_changed"
    fi
    for container in \
        pipipi-process-dispatcher \
        pipipi-process-worker \
        pipipi-webhook-worker \
        pipipi-retention-cleaner; do
        if docker inspect "$container" >/dev/null 2>&1; then
            provision_failure "current_sync_shape_changed"
        fi
    done
    for target in "${targets[@]}"; do
        if [ -e "$target" ] || [ -L "$target" ]; then
            provision_failure "role_environment_changed"
        fi
    done
    for index in 0 1 2 3 4; do
        if ! ln -- "${candidates[$index]}" "${targets[$index]}"; then
            provision_failure "atomic_install_failed"
        fi
    done
    shared_install="$work_directory/shared.install"
    if ! ln -- "$shared_candidate" "$shared_install"; then
        provision_failure "atomic_install_failed"
    fi
    if [ "$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true)" != "$candidate_image_id" ]; then
        provision_failure "candidate_image_changed"
    fi
    if ! shared_environment_unchanged; then
        provision_failure "shared_environment_changed"
    fi
    trap '' HUP INT TERM
    if ! mv -f -- "$shared_install" "$shared_env"; then
        trap 'on_signal HUP 129' HUP
        trap 'on_signal INT 130' INT
        trap 'on_signal TERM 143' TERM
        provision_failure "atomic_install_failed"
    fi
    applied=true
    completed=true
    trap 'on_signal HUP 129' HUP
    trap 'on_signal INT 130' INT
    trap 'on_signal TERM 143' TERM
fi

if [ "$mode" = plan ]; then
    completed=true
fi
success_ready=true
