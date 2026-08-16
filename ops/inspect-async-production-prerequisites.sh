#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 7 ]; then
    exit 64
fi

app_root="$1"
active_revision="$2"
candidate_revision="$3"
process_queue_name="$4"
process_queue_prefix="$5"
webhook_queue_name="$6"
webhook_queue_prefix="$7"

if ! [[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    ! [[ "$active_revision" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$candidate_revision" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$process_queue_name" =~ ^[A-Za-z0-9_-]{1,128}$ ]] ||
    ! [[ "$process_queue_prefix" =~ ^[A-Za-z0-9:_-]{1,128}$ ]] ||
    ! [[ "$webhook_queue_name" =~ ^[A-Za-z0-9_-]{1,128}$ ]] ||
    ! [[ "$webhook_queue_prefix" =~ ^[A-Za-z0-9:_-]{1,128}$ ]]; then
    exit 64
fi

shared="$app_root/shared"
shared_env="$shared/.env"
database_ca="$shared/pg-server.crt"
api_env="$shared/async-api.env"
dispatcher_env="$shared/process-dispatcher.env"
worker_env="$shared/process-worker.env"
webhook_env="$shared/webhook-worker.env"
retention_env="$shared/retention-cleaner.env"
image="pipipi:$candidate_revision"

inspection_failure() {
    local reason="$1"
    jq -n --arg failureReason "$reason" '
        {
            schemaVersion: 1,
            event: "async_production_prerequisites_inspected",
            status: "inspection_failed",
            failureReason: $failureReason
        }
    '
    exit 1
}

boolean() {
    if "$@"; then
        printf 'true'
    else
        printf 'false'
    fi
}

file_present() {
    [ -f "$1" ] && [ ! -L "$1" ]
}

file_restricted() {
    file_present "$1" && [ "$(stat -c '%u:%g:%a' "$1" 2>/dev/null)" = "0:0:600" ]
}

key_digest() {
    local file="$1"
    local key="$2"
    file_present "$file" || return 1
    awk -v key="$key" '
        index($0, key "=") == 1 {
            count++
            value = substr($0, length(key) + 2)
        }
        END {
            if (count != 1 || value ~ /^[[:space:]]*$/) exit 1
            printf "%s", value
        }
    ' "$file" | sha256sum | awk '{ print $1 }'
}

redis_loopback_password_configured() {
    local file="$1"
    [ "$candidate_image_verified" = true ] || return 1
    role_environment_isolated "$file" process-dispatcher || return 1
    docker run --rm --network none --env-file "$file" \
        --entrypoint node "$candidate_image_id" -e '
try {
    const redis = new URL(process.env.REDIS_URL ?? "");
    if (
        redis.protocol !== "redis:" ||
        redis.hostname !== "127.0.0.1" ||
        !redis.password
    ) process.exit(1);
} catch {
    process.exit(1);
}
' >/dev/null 2>&1
}

same_key_digest() {
    local key="$1"
    shift
    local expected=""
    local digest=""
    local file=""
    for file in "$@"; do
        digest="$(key_digest "$file" "$key")" || return 1
        if [ -z "$expected" ]; then
            expected="$digest"
        elif [ "$digest" != "$expected" ]; then
            return 1
        fi
    done
}

role_key_allowed() {
    local role="$1"
    local key="$2"
    local allowed=""
    case "$role" in
        api)
            allowed="BUSINESS_API_BASE_URL DATABASE_URL ASYNC_GATEWAY_SHARED_SECRET
                OPENAI_API_KEY OPENAI_BASE_URL OPENAI_API_MODE PI_PROVIDER PI_MODEL
                PI_AGENT_DIR PI_SKILL_DIRECTORY PI_POSTER_SKILL_DIRECTORY PI_CRT_SKILL_DIRECTORY
                PI_PALE_WATERCOLOR_SKILL_DIRECTORY PI_RAW_HUMANISM_SKILL_DIRECTORY
                PI_NARRATIVE_MONUMENT_SKILL_DIRECTORY
                CONTENT_PROCESSING_MODE BUSINESS_API_TIMEOUT_MS POSTER_API_TIMEOUT_MS
                CRT_API_TIMEOUT_MS NEWS_IMAGE_API_TIMEOUT_MS PROCESS_TIMEOUT_MS
                PROCESS_RUN_LOG_LEVEL CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS
                CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS CONTENT_PROCESSING_RETRY_MAX_DELAY_MS
                HTTP_MAX_REQUEST_BODY_BYTES MAX_CONCURRENT_EXECUTIONS TITLED_CONTENT_SEPARATOR
                PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS PROCESS_RUN_RESULT_RETENTION_MS
                PROCESS_RUN_METADATA_RETENTION_MS PROCESS_RUN_RECORD_POOL_MAX
                PROCESS_RUN_OBSERVATION_TIMEOUT_MS PROCESS_RUN_RECORD_RETENTION_DAYS
                CONSOLE_BASE_PATH ASYNC_POSTGRES_POOL_MAX ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS
                ASYNC_RETRY_AFTER_SECONDS ASYNC_GLOBAL_BACKLOG_LIMIT ASYNC_CALLER_BACKLOG_LIMIT
                ASYNC_BACKLOG_RETRY_AFTER_SECONDS ASYNC_STUCK_RUN_AGE_MS ASYNC_MAX_STUCK_RUNS
                ASYNC_MAX_OUTBOX_LAG_MS ASYNC_RECOVERY_MAX_AGE_MS ASYNC_OPERATIONS_RECENT_WINDOW_MS"
            ;;
        process-dispatcher)
            allowed="DATABASE_URL REDIS_URL ASYNC_POSTGRES_POOL_MAX
                ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS ASYNC_REDIS_CONNECTION_TIMEOUT_MS
                RUNTIME_ROLE_READINESS_TIMEOUT_MS OUTBOX_DISPATCH_INTERVAL_MS
                OUTBOX_DISPATCH_BATCH_SIZE OUTBOX_CLAIM_LEASE_MS
                PROCESS_RUN_RECONCILE_INTERVAL_MS PROCESS_RUN_RECONCILE_QUEUED_AGE_MS
                PROCESS_RUN_RECONCILE_BATCH_SIZE"
            ;;
        process-worker)
            allowed="BUSINESS_API_BASE_URL DATABASE_URL REDIS_URL OPENAI_API_KEY OPENAI_BASE_URL
                OPENAI_API_MODE PI_PROVIDER PI_MODEL PI_AGENT_DIR PI_SKILL_DIRECTORY
                PI_POSTER_SKILL_DIRECTORY PI_CRT_SKILL_DIRECTORY CONTENT_PROCESSING_MODE
                PI_PALE_WATERCOLOR_SKILL_DIRECTORY PI_RAW_HUMANISM_SKILL_DIRECTORY
                PI_NARRATIVE_MONUMENT_SKILL_DIRECTORY
                BUSINESS_API_TIMEOUT_MS POSTER_API_TIMEOUT_MS CRT_API_TIMEOUT_MS
                NEWS_IMAGE_API_TIMEOUT_MS PROCESS_TIMEOUT_MS PROCESS_RUN_LOG_LEVEL
                CONTENT_PROCESSING_RETRY_MAX_ATTEMPTS CONTENT_PROCESSING_RETRY_INITIAL_DELAY_MS
                CONTENT_PROCESSING_RETRY_MAX_DELAY_MS PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS
                PROCESS_RUN_RESULT_RETENTION_MS PROCESS_RUN_METADATA_RETENTION_MS
                PROCESS_RUN_RECORD_POOL_MAX PROCESS_RUN_OBSERVATION_TIMEOUT_MS
                PROCESS_RUN_RECORD_RETENTION_DAYS ASYNC_POSTGRES_POOL_MAX
                ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS ASYNC_REDIS_CONNECTION_TIMEOUT_MS
                PROCESS_RUN_CLAIM_LEASE_MS RUNTIME_ROLE_READINESS_TIMEOUT_MS
                PROCESS_WORKER_NAME PROCESS_WORKER_CONCURRENCY PROCESS_WORKER_SHUTDOWN_GRACE_MS
                PROCESS_WORKER_LOCK_DURATION_MS PROCESS_WORKER_STALLED_INTERVAL_MS
                PROCESS_WORKER_MAX_STALLED_COUNT"
            ;;
        webhook-worker)
            allowed="DATABASE_URL REDIS_URL WEBHOOK_SECRET_ENCRYPTION_KEY
                ASYNC_POSTGRES_POOL_MAX ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS
                ASYNC_REDIS_CONNECTION_TIMEOUT_MS RUNTIME_ROLE_READINESS_TIMEOUT_MS
                WEBHOOK_REQUEST_TIMEOUT_MS WEBHOOK_DELIVERY_CLAIM_LEASE_MS
                WEBHOOK_OUTBOX_DISPATCH_INTERVAL_MS WEBHOOK_OUTBOX_DISPATCH_BATCH_SIZE
                WEBHOOK_OUTBOX_CLAIM_LEASE_MS WEBHOOK_WORKER_NAME WEBHOOK_WORKER_CONCURRENCY
                WEBHOOK_WORKER_SHUTDOWN_GRACE_MS WEBHOOK_WORKER_LOCK_DURATION_MS
                WEBHOOK_WORKER_STALLED_INTERVAL_MS WEBHOOK_WORKER_MAX_STALLED_COUNT
                WEBHOOK_DELIVERY_MAX_ATTEMPTS WEBHOOK_DELIVERY_INITIAL_BACKOFF_MS
                WEBHOOK_DELIVERY_MAX_BACKOFF_MS WEBHOOK_DELIVERY_MAX_RETRY_AFTER_MS
                WEBHOOK_DELIVERY_HORIZON_MS WEBHOOK_DELIVERY_JITTER_PERCENT"
            ;;
        retention-cleaner)
            allowed="DATABASE_URL ASYNC_POSTGRES_POOL_MAX ASYNC_POSTGRES_CONNECTION_TIMEOUT_MS
                RUNTIME_ROLE_READINESS_TIMEOUT_MS WEBHOOK_DELIVERY_HISTORY_RETENTION_MS
                RETENTION_CLEANUP_INTERVAL_MS RETENTION_CLEANUP_BATCH_SIZE
                RETENTION_CLEANUP_MAX_BATCHES_PER_SWEEP"
            ;;
        *) return 1 ;;
    esac
    local candidate=""
    for candidate in $allowed; do
        if [ "$candidate" = "$key" ]; then
            return 0
        fi
    done
    return 1
}

role_environment_isolated() {
    local file="$1"
    local role="$2"
    local line=""
    local key=""
    local seen=$'\n'
    file_restricted "$file" || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^[[:space:]]*$ ]] || [[ "$line" =~ ^[[:space:]]*# ]]; then
            continue
        fi
        if ! [[ "$line" =~ ^([A-Z][A-Z0-9_]*)= ]]; then
            return 1
        fi
        key="${BASH_REMATCH[1]}"
        if [[ "$seen" == *$'\n'"$key"$'\n'* ]] || ! role_key_allowed "$role" "$key"; then
            return 1
        fi
        seen+="$key"$'\n'
    done < "$file"
}

run_preflight() {
    local role="$1"
    local env_file="$2"
    shift 2
    [ "$candidate_image_verified" = true ] || return 1
    role_environment_isolated "$env_file" "$role" || return 1
    docker run --rm --network none \
        --env-file "$env_file" \
        "$@" \
        --entrypoint node "$candidate_image_id" \
        dist/bin/check-deployment-environment.js "$role" \
        >/dev/null 2>&1
}

secret_shape_valid() {
    local env_file="$1"
    local kind="$2"
    [ "$candidate_image_verified" = true ] || return 1
    file_restricted "$env_file" || return 1
    if [ "$kind" = gateway ]; then
        role_environment_isolated "$env_file" api || return 1
    else
        role_environment_isolated "$env_file" webhook-worker || return 1
    fi
    docker run --rm --network none --env-file "$env_file" \
        --env SECRET_KIND="$kind" \
        --entrypoint node "$candidate_image_id" -e '
const kind = process.env.SECRET_KIND;
if (kind === "gateway") {
    const value = process.env.ASYNC_GATEWAY_SHARED_SECRET ?? "";
    if (Buffer.byteLength(value, "utf8") < 32) process.exit(1);
} else if (kind === "webhook") {
    const value = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ?? "";
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) process.exit(1);
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== value) process.exit(1);
} else {
    process.exit(1);
}
' >/dev/null 2>&1
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

candidate_image_id=""
candidate_image_verified=false
if candidate_image_id="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" &&
    [[ "$candidate_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    candidate_image_verified=true
fi

current_sync_shape_verified=false
if api_sync_intake_disabled && container_running_at_revision pipipi-business-api; then
    current_sync_shape_verified=true
    for container in \
        pipipi-process-dispatcher \
        pipipi-process-worker \
        pipipi-webhook-worker \
        pipipi-retention-cleaner; do
        if docker inspect "$container" >/dev/null 2>&1; then
            current_sync_shape_verified=false
        fi
    done
fi

api_file_present="$(boolean file_present "$api_env")"
dispatcher_file_present="$(boolean file_present "$dispatcher_env")"
worker_file_present="$(boolean file_present "$worker_env")"
webhook_file_present="$(boolean file_present "$webhook_env")"
retention_file_present="$(boolean file_present "$retention_env")"
api_file_restricted="$(boolean file_restricted "$api_env")"
dispatcher_file_restricted="$(boolean file_restricted "$dispatcher_env")"
worker_file_restricted="$(boolean file_restricted "$worker_env")"
webhook_file_restricted="$(boolean file_restricted "$webhook_env")"
retention_file_restricted="$(boolean file_restricted "$retention_env")"
api_environment_isolated="$(boolean role_environment_isolated "$api_env" api)"
dispatcher_environment_isolated="$(boolean role_environment_isolated "$dispatcher_env" process-dispatcher)"
worker_environment_isolated="$(boolean role_environment_isolated "$worker_env" process-worker)"
webhook_environment_isolated="$(boolean role_environment_isolated "$webhook_env" webhook-worker)"
retention_environment_isolated="$(boolean role_environment_isolated "$retention_env" retention-cleaner)"

database_ca_present="$(boolean file_present "$database_ca")"
database_url_consistent="$(boolean same_key_digest DATABASE_URL \
    "$shared_env" "$api_env" "$dispatcher_env" "$worker_env" "$webhook_env" "$retention_env")"
redis_url_consistent="$(boolean same_key_digest REDIS_URL \
    "$dispatcher_env" "$worker_env" "$webhook_env")"
redis_loopback_password_configured="$(boolean redis_loopback_password_configured "$dispatcher_env")"

api_preflight_passed="$(boolean run_preflight api "$api_env" \
    --env ASYNC_PROCESS_RUNS_ENABLED=true \
    --env ASYNC_RELEASE_STAGE=internal \
    --env CONSOLE_ENABLED=true \
    --env PROCESS_RUN_RECORD_STORE=postgres \
    --env CRT_BUSINESS_API_BASE_URL=http://127.0.0.1:4400)"
dispatcher_preflight_passed="$(boolean run_preflight process-dispatcher "$dispatcher_env" \
    --env PROCESS_QUEUE_NAME="$process_queue_name" \
    --env PROCESS_QUEUE_PREFIX="$process_queue_prefix")"
worker_preflight_passed="$(boolean run_preflight process-worker "$worker_env" \
    --env CRT_BUSINESS_API_BASE_URL=http://127.0.0.1:4400 \
    --env PROCESS_QUEUE_NAME="$process_queue_name" \
    --env PROCESS_QUEUE_PREFIX="$process_queue_prefix" \
    --env PROCESS_RUN_RECORD_STORE=postgres \
    --env PROCESS_RUN_RECORD_CONTENT=accepted-input-and-output)"
webhook_preflight_passed="$(boolean run_preflight webhook-worker "$webhook_env" \
    --env WEBHOOK_QUEUE_NAME="$webhook_queue_name" \
    --env WEBHOOK_QUEUE_PREFIX="$webhook_queue_prefix")"
retention_preflight_passed="$(boolean run_preflight retention-cleaner "$retention_env")"
gateway_secret_configured="$(boolean secret_shape_valid "$api_env" gateway)"
webhook_secret_configured="$(boolean secret_shape_valid "$webhook_env" webhook)"

if [ "$candidate_image_verified" = true ] &&
    [ "$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null || true)" != "$candidate_image_id" ]; then
    inspection_failure "candidate_image_changed"
fi

jq -n \
    --arg activeRevision "$active_revision" \
    --arg candidateRevision "$candidate_revision" \
    --argjson apiFilePresent "$api_file_present" \
    --argjson apiFileRestricted "$api_file_restricted" \
    --argjson apiEnvironmentIsolated "$api_environment_isolated" \
    --argjson apiPreflightPassed "$api_preflight_passed" \
    --argjson candidateImageVerified "$candidate_image_verified" \
    --argjson currentSyncShapeVerified "$current_sync_shape_verified" \
    --argjson databaseCaPresent "$database_ca_present" \
    --argjson databaseUrlConsistent "$database_url_consistent" \
    --argjson dispatcherFilePresent "$dispatcher_file_present" \
    --argjson dispatcherFileRestricted "$dispatcher_file_restricted" \
    --argjson dispatcherEnvironmentIsolated "$dispatcher_environment_isolated" \
    --argjson dispatcherPreflightPassed "$dispatcher_preflight_passed" \
    --argjson gatewaySecretConfigured "$gateway_secret_configured" \
    --argjson redisLoopbackPasswordConfigured "$redis_loopback_password_configured" \
    --argjson redisUrlConsistent "$redis_url_consistent" \
    --argjson retentionFilePresent "$retention_file_present" \
    --argjson retentionFileRestricted "$retention_file_restricted" \
    --argjson retentionEnvironmentIsolated "$retention_environment_isolated" \
    --argjson retentionPreflightPassed "$retention_preflight_passed" \
    --argjson webhookFilePresent "$webhook_file_present" \
    --argjson webhookFileRestricted "$webhook_file_restricted" \
    --argjson webhookEnvironmentIsolated "$webhook_environment_isolated" \
    --argjson webhookPreflightPassed "$webhook_preflight_passed" \
    --argjson webhookSecretConfigured "$webhook_secret_configured" \
    --argjson workerFilePresent "$worker_file_present" \
    --argjson workerFileRestricted "$worker_file_restricted" \
    --argjson workerEnvironmentIsolated "$worker_environment_isolated" \
    --argjson workerPreflightPassed "$worker_preflight_passed" '
    {
        schemaVersion: 1,
        event: "async_production_prerequisites_inspected",
        status: "succeeded",
        activeRevision: $activeRevision,
        candidateRevision: $candidateRevision,
        candidateImageVerified: $candidateImageVerified,
        currentSyncShapeVerified: $currentSyncShapeVerified,
        databaseCaPresent: $databaseCaPresent,
        databaseUrlConsistent: $databaseUrlConsistent,
        redisUrlConsistent: $redisUrlConsistent,
        redisLoopbackPasswordConfigured: $redisLoopbackPasswordConfigured,
        gatewaySecretConfigured: $gatewaySecretConfigured,
        webhookSecretConfigured: $webhookSecretConfigured,
        roles: {
            api: {
                environmentIsolated: $apiEnvironmentIsolated,
                filePresent: $apiFilePresent,
                fileRestricted: $apiFileRestricted,
                preflightPassed: $apiPreflightPassed
            },
            dispatcher: {
                environmentIsolated: $dispatcherEnvironmentIsolated,
                filePresent: $dispatcherFilePresent,
                fileRestricted: $dispatcherFileRestricted,
                preflightPassed: $dispatcherPreflightPassed
            },
            worker: {
                environmentIsolated: $workerEnvironmentIsolated,
                filePresent: $workerFilePresent,
                fileRestricted: $workerFileRestricted,
                preflightPassed: $workerPreflightPassed
            },
            webhook: {
                environmentIsolated: $webhookEnvironmentIsolated,
                filePresent: $webhookFilePresent,
                fileRestricted: $webhookFileRestricted,
                preflightPassed: $webhookPreflightPassed
            },
            retention: {
                environmentIsolated: $retentionEnvironmentIsolated,
                filePresent: $retentionFilePresent,
                fileRestricted: $retentionFileRestricted,
                preflightPassed: $retentionPreflightPassed
            }
        }
    }
'
