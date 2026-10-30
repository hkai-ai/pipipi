#!/usr/bin/env bash
# 在生产发布锁内更新已有异步部署，保留阶段、队列与角色配置。
set -Eeuo pipefail

app_root="$1"
revision="$2"
image_archive="$3"
base_source="$4"
async_source="$5"
shared="$app_root/shared"
base="$shared/compose.production.yaml"
overlay="$shared/compose.production.async.yaml"
control="$shared/async-control"
image="pipipi:$revision"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
# 调用方必须持有同一文件的锁；继承的描述符不会释放父进程锁。
flock -n 9
test ! -f "$control/smoke-lease"

environment_value() {
    docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' |
        awk -F= -v name="$2" '$1 == name {sub(/^[^=]*=/, ""); print; found=1} END {if (!found) exit 1}'
}

containers=(pipipi pipipi-business-api pipipi-process-dispatcher pipipi-process-worker pipipi-webhook-worker pipipi-retention-cleaner)
previous_image="$(docker inspect pipipi --format '{{.Config.Image}}')"
previous_revision="$(docker inspect pipipi --format '{{index .Config.Labels "com.pipipi.revision"}}')"
[[ "$previous_revision" =~ ^[0-9a-f]{40}$ ]]
previous_id="$(docker inspect pipipi --format '{{.Image}}')"
for container in "${containers[@]}"; do
    if [ "$(docker inspect "$container" --format '{{.Config.Image}}')" != "$previous_image" ] ||
        [ "$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')" != "$previous_revision" ] ||
        [ "$(docker inspect "$container" --format '{{.Image}}')" != "$previous_id" ] ||
        [ "$(docker inspect "$container" --format '{{.State.Running}}')" != true ]; then
        echo "Existing async deployment is incomplete or revisions differ" >&2
        exit 1
    fi
done
test "$(environment_value pipipi ASYNC_PROCESS_RUNS_ENABLED)" = true
test "$(environment_value pipipi ASYNC_PROCESS_RUN_INTAKE_DISABLED_FILE)" = /var/lib/pipipi-async-control/intake-disabled
export PIPIPI_ASYNC_RELEASE_STAGE
PIPIPI_ASYNC_RELEASE_STAGE="$(environment_value pipipi ASYNC_RELEASE_STAGE)"
[[ "$PIPIPI_ASYNC_RELEASE_STAGE" =~ ^(internal|canary|production)$ ]]
export PIPIPI_PROCESS_QUEUE_NAME PIPIPI_PROCESS_QUEUE_PREFIX PIPIPI_WEBHOOK_QUEUE_NAME PIPIPI_WEBHOOK_QUEUE_PREFIX
PIPIPI_PROCESS_QUEUE_NAME="$(environment_value pipipi-process-dispatcher PROCESS_QUEUE_NAME)"
PIPIPI_PROCESS_QUEUE_PREFIX="$(environment_value pipipi-process-dispatcher PROCESS_QUEUE_PREFIX)"
PIPIPI_WEBHOOK_QUEUE_NAME="$(environment_value pipipi-webhook-worker WEBHOOK_QUEUE_NAME)"
PIPIPI_WEBHOOK_QUEUE_PREFIX="$(environment_value pipipi-webhook-worker WEBHOOK_QUEUE_PREFIX)"
test "$(environment_value pipipi-process-worker PROCESS_QUEUE_NAME)" = "$PIPIPI_PROCESS_QUEUE_NAME"
test "$(environment_value pipipi-process-worker PROCESS_QUEUE_PREFIX)" = "$PIPIPI_PROCESS_QUEUE_PREFIX"

export PIPIPI_ENV_FILE="$shared/.env"
export PIPIPI_ASYNC_API_ENV_FILE="$shared/async-api.env"
export PIPIPI_PROCESS_DISPATCHER_ENV_FILE="$shared/process-dispatcher.env"
export PIPIPI_PROCESS_WORKER_ENV_FILE="$shared/process-worker.env"
export PIPIPI_WEBHOOK_WORKER_ENV_FILE="$shared/webhook-worker.env"
export PIPIPI_RETENTION_CLEANER_ENV_FILE="$shared/retention-cleaner.env"
export PIPIPI_DATABASE_CA_FILE="$shared/pg-server.crt"
export PIPIPI_BUSINESS_DATA_DIRECTORY="$shared/crt-business-api"
export PIPIPI_RUN_RECORD_DIRECTORY="$shared/run-records"
export PIPIPI_ASYNC_CONTROL_DIRECTORY="$control"
for file in "$base" "$overlay" "$base_source" "$async_source" "$image_archive" \
    "$PIPIPI_ENV_FILE" "$PIPIPI_ASYNC_API_ENV_FILE" "$PIPIPI_PROCESS_DISPATCHER_ENV_FILE" \
    "$PIPIPI_PROCESS_WORKER_ENV_FILE" "$PIPIPI_WEBHOOK_WORKER_ENV_FILE" \
    "$PIPIPI_RETENTION_CLEANER_ENV_FILE" "$PIPIPI_DATABASE_CA_FILE"; do
    test -f "$file"
done

gzip -dc "$image_archive" | docker load >/dev/null
candidate_id="$(docker image inspect "$image" --format '{{.Id}}')"
# 普通代码更新不写数据库；迁移字节变化必须走带备份审查的发布入口。
migration_digest() {
    docker run --rm --network none --entrypoint node "$1" -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const hash = crypto.createHash("sha256");
for (const name of fs.readdirSync("migrations").sort()) {
    hash.update(name + "\0"); hash.update(fs.readFileSync("migrations/" + name));
}
console.log(hash.digest("hex"));'
}
old_digest="$(migration_digest "$previous_id")"
new_digest="$(migration_digest "$image")"
if ! [[ "$old_digest" =~ ^[0-9a-f]{64}$ ]] || [ "$old_digest" != "$new_digest" ]; then
    echo "Database migrations changed; use a reviewed migration release with a backup before routine deployment" >&2
    exit 1
fi

compose() {
    docker compose --project-name pipipi --env-file /dev/null --file "$base" --file "$overlay" "$@"
}
PIPIPI_IMAGE="$image" PIPIPI_REVISION="$revision" docker compose --project-name pipipi \
    --env-file /dev/null --file "$base_source" --file "$async_source" config --quiet
# 用候选 Compose 的真实环境逐角色预检，避免再次复制六套环境覆盖。
for role in api crt-business-api process-dispatcher process-worker webhook-worker retention-cleaner; do
    service="$role"
    if [ "$role" = crt-business-api ]; then service=business-api; fi
    PIPIPI_IMAGE="$image" PIPIPI_REVISION="$revision" docker compose --project-name pipipi \
        --env-file /dev/null --file "$base_source" --file "$async_source" \
        run --rm --no-deps --entrypoint node "$service" dist/bin/check-deployment-environment.js "$role"
done

work="$(mktemp -d "$shared/.async-update.XXXXXX")"
cp -p "$base" "$work/base.yaml"
cp -p "$overlay" "$work/async.yaml"
changed=false
owns_marker=false
verify() {
    local target_revision="$1" target_id="$2" container port
    for container in "${containers[@]}"; do
        test "$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')" = "$target_revision" || return 1
        test "$(docker inspect "$container" --format '{{.Config.Image}}')" = "pipipi:$target_revision" || return 1
        test "$(docker inspect "$container" --format '{{.Image}}')" = "$target_id" || return 1
    done
    test "$(environment_value pipipi ASYNC_PROCESS_RUNS_ENABLED)" = true || return 1
    test "$(environment_value pipipi ASYNC_RELEASE_STAGE)" = "$PIPIPI_ASYNC_RELEASE_STAGE" || return 1
    for container in pipipi-process-dispatcher pipipi-process-worker; do
        test "$(environment_value "$container" PROCESS_QUEUE_NAME)" = "$PIPIPI_PROCESS_QUEUE_NAME" || return 1
        test "$(environment_value "$container" PROCESS_QUEUE_PREFIX)" = "$PIPIPI_PROCESS_QUEUE_PREFIX" || return 1
    done
    test "$(environment_value pipipi-webhook-worker WEBHOOK_QUEUE_NAME)" = "$PIPIPI_WEBHOOK_QUEUE_NAME" || return 1
    test "$(environment_value pipipi-webhook-worker WEBHOOK_QUEUE_PREFIX)" = "$PIPIPI_WEBHOOK_QUEUE_PREFIX" || return 1
    for port in 4300 4400 4310 4320 4350 4340; do
        curl --fail --silent --show-error --connect-timeout 3 --max-time 10 "http://127.0.0.1:$port/healthz" >/dev/null || return 1
        curl --fail --silent --show-error --connect-timeout 3 --max-time 10 "http://127.0.0.1:$port/readyz" >/dev/null || return 1
    done
}
activate() {
    PIPIPI_IMAGE="$1" PIPIPI_REVISION="$2" compose up -d --force-recreate --no-build --wait --wait-timeout 180 || return 1
    verify "$2" "$3"
}
finish() {
    local result="$?" restored=true
    trap - EXIT HUP INT TERM
    if [ "$result" -ne 0 ] && [ "$changed" = true ]; then
        if ! { install -m 600 "$work/base.yaml" "$base" &&
            install -m 600 "$work/async.yaml" "$overlay" &&
            activate "$previous_image" "$previous_revision" "$previous_id"; }; then
            restored=false
            echo "Async update rollback failed; intake remains disabled; snapshots: $work" >&2
        fi
    fi
    if [ "$restored" = true ]; then
        if [ "$owns_marker" = true ]; then rm -f -- "$control/intake-disabled"; fi
        rm -f -- "$work/base.yaml" "$work/async.yaml"
        rmdir "$work"
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# 仅移除本次创建的停流标记，既有人工停流必须保留。
if [ ! -f "$control/intake-disabled" ]; then
    touch "$control/intake-disabled"
    owns_marker=true
fi
# 保持旧 API 查询和 Worker 可用，等待已接受的 Run 排空后再切换。
drained=false
for ((attempt=0; attempt<60; attempt++)); do
    backlog="$(docker exec pipipi-process-dispatcher node -e '
const { Pool } = require("pg");
const pool = new Pool({connectionString:process.env.DATABASE_URL, max:1, connectionTimeoutMillis:5000, query_timeout:5000});
pool.query("SELECT count(*) AS count FROM process_runs WHERE status IN (\u0027queued\u0027, \u0027running\u0027)")
    .then(r => console.log(r.rows[0].count)).catch(() => {process.exitCode=1;}).finally(() => pool.end());')"
    [[ "$backlog" =~ ^[0-9]+$ ]]
    if [ "$backlog" = 0 ]; then drained=true; break; fi
    sleep 5
done
if [ "$drained" != true ]; then
    echo "Accepted async Runs did not drain in 300 seconds; current deployment retained" >&2
    exit 1
fi
changed=true
install -m 600 "$base_source" "$base"
install -m 600 "$async_source" "$overlay"
activate "$image" "$revision" "$candidate_id"
echo "Updated async revision $revision; stage $PIPIPI_ASYNC_RELEASE_STAGE and Queue identity preserved"
