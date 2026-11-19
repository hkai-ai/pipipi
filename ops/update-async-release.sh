#!/usr/bin/env bash
# 在生产发布锁内更新已有异步部署，保留阶段、队列与角色配置。
set -Eeuo pipefail

migration_digest() {
    docker run --rm --network none --entrypoint node "$1" -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const hash = crypto.createHash("sha256");
for (const name of fs.readdirSync("migrations").sort()) {
    hash.update(name + "\0"); hash.update(fs.readFileSync("migrations/" + name));
}
console.log(hash.digest("hex"));'
}

if [ "$1" = --migration-digest ]; then
    migration_digest "$2"
    exit
fi

mode=activate
if [ "$1" = --plan ]; then
    mode=plan
    shift
fi
app_root="$1"
shared="$app_root/shared"
base="$shared/compose.production.yaml"
overlay="$shared/compose.production.async.yaml"
control="$shared/async-control"
if [ "$mode" = plan ]; then
    candidate_digest="$2"
    [[ "$candidate_digest" =~ ^[0-9a-f]{64}$ ]] || exit 1
    # 首次部署可能尚无 shared 目录。实际激活始终在独占锁内重查。
    if [ -f "$shared/deployment.lock" ]; then
        exec 9<"$shared/deployment.lock"
        flock -s -w 60 9
    fi
    names="$(docker ps -a --format '{{.Names}}')"
    if ! grep -Eq '^pipipi-(process-dispatcher|process-worker|webhook-worker|retention-cleaner)$' <<< "$names"; then
        if grep -Fxq pipipi <<< "$names"; then
            async_enabled="$(docker inspect pipipi --format '{{range .Config.Env}}{{println .}}{{end}}' | awk '$0 == "ASYNC_PROCESS_RUNS_ENABLED=true" {print "true"}')"
            if [ "$async_enabled" = true ]; then
                echo "Async API has no background roles" >&2
                exit 1
            fi
        fi
        echo routine
        exit 0
    fi
else
    revision="$2"
    image_archive="$3"
    base_source="$4"
    async_source="$5"
    image="pipipi:$revision"
    [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 1
    # 激活时由调用方持有独占锁。
    flock -n 9
fi
test ! -f "$control/smoke-lease"

environment_value() {
    docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' |
        awk -F= -v name="$2" '$1 == name {sub(/^[^=]*=/, ""); print; found=1} END {if (!found) exit 1}'
}

containers=(pipipi pipipi-business-api pipipi-process-dispatcher pipipi-process-worker pipipi-webhook-worker pipipi-retention-cleaner)
previous_image="$(docker inspect pipipi --format '{{.Config.Image}}')"
previous_revision="$(docker inspect pipipi --format '{{index .Config.Labels "com.pipipi.revision"}}')"
[[ "$previous_revision" =~ ^[0-9a-f]{40}$ ]] || exit 1
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
[[ "$PIPIPI_ASYNC_RELEASE_STAGE" =~ ^(internal|canary|production)$ ]] || exit 1
export PIPIPI_PROCESS_QUEUE_NAME PIPIPI_PROCESS_QUEUE_PREFIX PIPIPI_WEBHOOK_QUEUE_NAME PIPIPI_WEBHOOK_QUEUE_PREFIX
PIPIPI_PROCESS_QUEUE_NAME="$(environment_value pipipi-process-dispatcher PROCESS_QUEUE_NAME)"
PIPIPI_PROCESS_QUEUE_PREFIX="$(environment_value pipipi-process-dispatcher PROCESS_QUEUE_PREFIX)"
PIPIPI_WEBHOOK_QUEUE_NAME="$(environment_value pipipi-webhook-worker WEBHOOK_QUEUE_NAME)"
PIPIPI_WEBHOOK_QUEUE_PREFIX="$(environment_value pipipi-webhook-worker WEBHOOK_QUEUE_PREFIX)"
test "$(environment_value pipipi-process-worker PROCESS_QUEUE_NAME)" = "$PIPIPI_PROCESS_QUEUE_NAME"
test "$(environment_value pipipi-process-worker PROCESS_QUEUE_PREFIX)" = "$PIPIPI_PROCESS_QUEUE_PREFIX"

old_digest="$(migration_digest "$previous_id")"
[[ "$old_digest" =~ ^[0-9a-f]{64}$ ]] || exit 1
if [ "$mode" = plan ]; then
    if [ "$old_digest" = "$candidate_digest" ]; then
        echo routine
    else
        echo "migration $PIPIPI_ASYNC_RELEASE_STAGE $previous_revision"
    fi
    exit 0
fi

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
# 迁移字节不变时本脚本不写数据库；变化时在排空之后自动备份并迁移（见下方）。
new_digest="$(migration_digest "$candidate_id")"
[[ "$new_digest" =~ ^[0-9a-f]{64}$ ]] || exit 1
migrations_changed=false
if [ "$old_digest" != "$new_digest" ]; then migrations_changed=true; fi

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
backup_id=""
backup_dump=""
migrations_applied=false
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
    if [ "$result" -ne 0 ] && [ -n "$backup_dump" ] && [ "$migrations_applied" != true ]; then
        # 备份未通过验证或迁移未应用时不留下无证据的半成品；迁移后失败则保留备份。
        if [ ! -f "$shared/db-backups/$backup_id.json" ]; then rm -f -- "$backup_dump"; fi
    fi
    if [ "$result" -ne 0 ] && [ "$migrations_applied" = true ]; then
        echo "Database migrations were applied before this failure and are not rolled back (no migration down); the application was reverted to the previous release. Restore from backup $backup_id under $shared/db-backups only if the new schema is unusable" >&2
    fi
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
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# 迁移变化：在停流并排空之后、安装新 Compose 之前备份并迁移。
# 此刻已拒绝新 Run 且没有 queued/running Run，业务写入基本停止，
# 备份与迁移面对的是同一份静止数据；备份先于迁移，任何一步失败都由 finish 保持旧部署。
# 迁移不做 down：迁移后切换失败只回滚应用，数据库可用本次备份恢复。
if [ "$migrations_changed" = true ]; then
    dispatcher_env="$PIPIPI_PROCESS_DISPATCHER_ENV_FILE"
    pg_image="${PIPIPI_PG_DUMP_IMAGE:-postgres:18-alpine}"
    backup_dir="$shared/db-backups"
    backup_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ( umask 077; mkdir -p -- "$backup_dir" )
    chmod 700 "$backup_dir"
    backup_id="pipipi-pg-$(date -u +%Y%m%dT%H%M%SZ)"
    backup_dump="$backup_dir/$backup_id.dump"
    test ! -e "$backup_dump"

    # 连接串只经 --env-file 进入容器，由容器内 shell 读取环境变量，
    # 不出现在宿主机 docker 命令行、日志或证据中。应用 URL 带 uselibpqcompat（node-pg 专用，
    # libpq 不认识），在容器内剔除；sslmode=verify-ca 与固定 CA 路径必须存在，否则拒绝。
    # sslrootcert 可能被百分号编码（%2F），按解码后的值判断——应用侧也是按解码值校验。
    # 失败时只向 stderr 输出固定类别 PG_ERROR=<CODE>，不回显 libpq 原文（可能含主机等连接信息）。
    pg_container_script=""
    IFS= read -r -d '' pg_container_script <<'PG_CONTAINER' || true
# BEGIN pg container
set -eu
decoded="$(printf "%s" "$DATABASE_URL" | sed -e "s/%2[Ff]/\//g")"
case "$decoded" in
  *sslmode=verify-ca*) ;;
  *) echo "PG_ERROR=URL_NOT_VERIFY_CA" >&2; exit 1;;
esac
case "$decoded" in
  *sslrootcert=/etc/pipipi/pg-server.crt*) ;;
  *) echo "PG_ERROR=URL_NOT_FIXED_CA" >&2; exit 1;;
esac
url="$(printf "%s" "$DATABASE_URL" | sed -e "s/uselibpqcompat=true&\{0,1\}//" -e "s/[?&]\$//")"
err="$(mktemp)"
classify() {
  if grep -qi "version mismatch" "$err"; then code=VERSION_MISMATCH
  elif grep -qi "password authentication\|pg_hba" "$err"; then code=AUTH_FAILED
  elif grep -qi "permission denied" "$err"; then code=PERMISSION_DENIED
  elif grep -qi "invalid URI\|invalid connection option\|invalid sslmode\|invalid integer" "$err"; then code=URL_PARAMETER_INVALID
  elif grep -qi "certificate\|ssl\|tls" "$err"; then code=TLS_FAILED
  elif grep -qi "translate host\|connection refused\|timeout\|could not connect\|unreachable" "$err"; then code=NETWORK_FAILED
  else code=UNKNOWN; fi
  rm -f "$err"
  echo "PG_ERROR=$code" >&2
  exit 1
}
case "$1" in
  size) psql "$url" --no-psqlrc --tuples-only --no-align --command "SELECT pg_database_size(current_database())" 2>"$err" || classify;;
  dump) pg_dump "$url" --format=custom 2>"$err" || classify;;
  *) exit 1;;
esac
rm -f "$err"
# END pg container
PG_CONTAINER
    pg_run_url() {
        docker run --rm --network host --env-file "$dispatcher_env" \
            --volume "$PIPIPI_DATABASE_CA_FILE:/etc/pipipi/pg-server.crt:ro" \
            --entrypoint sh "$pg_image" -c "$pg_container_script" sh "$1"
    }
    # 只取容器给出的固定类别；没有类别说明 docker 本身失败（如镜像不可用）。
    pg_failure() {
        local code
        code="$(grep -o 'PG_ERROR=[A-Z_]*' "$1" 2>/dev/null | tail -n 1 | sed 's/^PG_ERROR=//')" || true
        rm -f -- "$1"
        printf '%s' "${code:-DOCKER_FAILED}"
    }
    if ! docker image inspect "$pg_image" >/dev/null 2>&1 && ! docker pull --quiet "$pg_image" >/dev/null 2>&1; then
        echo "Cannot pull $pg_image for the database backup; current deployment retained" >&2
        exit 1
    fi
    pg_err="$(mktemp)"

    db_bytes="$(pg_run_url size 2>"$pg_err")" ||
        { echo "Cannot read database size ($(pg_failure "$pg_err")); current deployment retained" >&2; exit 1; }
    rm -f -- "$pg_err"
    [[ "$db_bytes" =~ ^[0-9]+$ ]] || { echo "Invalid database size; current deployment retained" >&2; exit 1; }
    available_kib="$(df -Pk "$backup_dir" | awk 'NR == 2 {print $4}')"
    [[ "$available_kib" =~ ^[0-9]+$ ]] || exit 1
    required_bytes=$((db_bytes * 3 + 1073741824))
    if [ $((available_kib * 1024)) -lt "$required_bytes" ]; then
        echo "Not enough disk space for a database backup (need 3x database size + 1GiB); current deployment retained" >&2
        exit 1
    fi

    pg_err="$(mktemp)"
    ( umask 077; pg_run_url dump 2>"$pg_err" > "$backup_dump" ) ||
        { echo "pg_dump failed ($(pg_failure "$pg_err")); current deployment retained" >&2; exit 1; }
    rm -f -- "$pg_err"
    chmod 600 "$backup_dump"
    backup_listing="$(docker run --rm --network none --volume "$backup_dump:/backup.dump:ro" \
        --entrypoint pg_restore "$pg_image" --list /backup.dump 2>/dev/null)" ||
        { echo "Backup cannot be read by pg_restore; current deployment retained" >&2; exit 1; }
    grep -Eq 'TABLE (DATA )?public process_runs ' <<< "$backup_listing" ||
        { echo "Backup does not contain process_runs; current deployment retained" >&2; exit 1; }
    backup_sha256="$(sha256_of "$backup_dump")"
    [[ "$backup_sha256" =~ ^[0-9a-f]{64}$ ]] || exit 1
    backup_bytes="$(wc -c < "$backup_dump" | tr -d '[:space:]')"
    [[ "$backup_bytes" =~ ^[1-9][0-9]*$ ]] || exit 1

    audit_output="$(docker run --rm --network host --env-file "$dispatcher_env" \
        --volume "$PIPIPI_DATABASE_CA_FILE:/etc/pipipi/pg-server.crt:ro" \
        --entrypoint npm "$candidate_id" run --silent audit:production-database 2>/dev/null)" ||
        { echo "Production database boundary audit failed; current deployment retained" >&2; exit 1; }
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
    ' <<< "$audit_output" >/dev/null ||
        { echo "Production database boundary audit result rejected; current deployment retained" >&2; exit 1; }

    migration_output="$(docker run --rm --network host --env-file "$dispatcher_env" \
        --volume "$PIPIPI_DATABASE_CA_FILE:/etc/pipipi/pg-server.crt:ro" \
        --entrypoint node "$candidate_id" dist/bin/migrate-and-verify.js 2>/dev/null)" || {
        # 迁移可能已部分执行：保守地按“已改动数据库”处理，提示用备份恢复。
        migrations_applied=true
        echo "Database migration failed" >&2
        exit 1
    }
    migrations_applied=true
    jq --exit-status '.event == "database_migration_verified" and .verificationCount == 0 and (.appliedCount | type == "number")' \
        <<< "$migration_output" >/dev/null || { echo "Database migration verification rejected" >&2; exit 1; }
    applied_count="$(jq -r '.appliedCount' <<< "$migration_output")"
    [[ "$applied_count" =~ ^[0-9]+$ ]] || exit 1

    evidence="$backup_dir/$backup_id.json"
    ( umask 077; jq -n \
        --arg commit "$revision" --arg previousRevision "$previous_revision" \
        --arg previousMigrationDigest "$old_digest" --arg candidateMigrationDigest "$new_digest" \
        --arg backupFile "$backup_id.dump" --arg backupSha256 "$backup_sha256" \
        --argjson backupBytes "$backup_bytes" --argjson appliedCount "$applied_count" \
        --arg startedAt "$backup_started" --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{commit: $commit, previousRevision: $previousRevision, previousMigrationDigest: $previousMigrationDigest,
          candidateMigrationDigest: $candidateMigrationDigest, backupFile: $backupFile, backupSha256: $backupSha256,
          backupBytes: $backupBytes, appliedCount: $appliedCount, startedAt: $startedAt, completedAt: $completedAt}' > "$evidence" )
    chmod 600 "$evidence"

    # 只保留最新 14 份备份及证据；名字含 UTC 时间戳，按名字排序即按时间排序。
    stale="$(find "$backup_dir" -maxdepth 1 -type f -name 'pipipi-pg-*Z.dump' -exec basename {} \; | sort | awk -v keep=14 '{a[NR]=$0} END {for (i = 1; i <= NR - keep; i++) print a[i]}')"
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        rm -f -- "$backup_dir/$name" "$backup_dir/${name%.dump}.json"
    done <<< "$stale"
    echo "PIPIPI_BACKUP_ID=$backup_id"
    echo "PIPIPI_MIGRATIONS_APPLIED=$applied_count"
fi
changed=true
install -m 600 "$base_source" "$base"
install -m 600 "$async_source" "$overlay"
activate "$image" "$revision" "$candidate_id"
echo "Updated async revision $revision; stage $PIPIPI_ASYNC_RELEASE_STAGE and Queue identity preserved"
