#!/usr/bin/env bash
# 把同步 API 与内部图片服务发布到独立 UAT 服务器。不读取生产主机，也不部署异步角色。
set -Eeuo pipefail

app_root="$1"
revision="$2"
image_archive="$3"
compose_source="$4"

[[ "$app_root" =~ ^/[a-zA-Z0-9_/-]+$ ]]
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]

trap 'rm -f -- "$image_archive" "$compose_source"' EXIT

image="pipipi:$revision"
shared_env="$app_root/shared/.env"
compose_file="$app_root/shared/compose.production.yaml"
previous_compose="$app_root/shared/compose.production.previous.yaml"
marker="$app_root/shared/uat-target"
previous_image=""
previous_revision=""
previous_has_business="false"

command -v docker >/dev/null
docker compose version >/dev/null
command -v flock >/dev/null

mkdir -p "$app_root/shared"
lock_file="$app_root/shared/deployment.lock"
exec 9>"$lock_file"
if ! flock -n 9; then
    echo "Another UAT deployment is active" >&2
    exit 1
fi

if [ ! -f "$marker" ] || ! grep -Fxq uat "$marker"; then
    echo "Refusing to deploy: $marker must contain the single line uat" >&2
    exit 1
fi

for async_container in \
    pipipi-process-dispatcher \
    pipipi-process-worker \
    pipipi-webhook-worker \
    pipipi-retention-cleaner; do
    if docker inspect "$async_container" >/dev/null 2>&1; then
        echo "UAT deploy refuses async role $async_container" >&2
        exit 1
    fi
done

if [ ! -f "$shared_env" ]; then
    echo "Missing UAT environment file: $shared_env" >&2
    exit 1
fi
if grep -Eq '^ASYNC_PROCESS_RUNS_ENABLED=true$' "$shared_env"; then
    echo "UAT environment must keep ASYNC_PROCESS_RUNS_ENABLED=false" >&2
    exit 1
fi

install -d -m 700 -o 1000 -g 1000 "$app_root/shared/crt-business-api"
install -d -m 700 -o 1000 -g 1000 "$app_root/shared/run-records"
export PIPIPI_BUSINESS_DATA_DIRECTORY="$app_root/shared/crt-business-api"
export PIPIPI_RUN_RECORD_DIRECTORY="$app_root/shared/run-records"
export PIPIPI_DATABASE_CA_FILE="$app_root/shared/pg-server.crt"

if [ ! -f "$app_root/shared/pg-server.crt" ]; then
    echo "Missing database certificate: $app_root/shared/pg-server.crt" >&2
    exit 1
fi

gzip -dc "$image_archive" | docker load

docker run --rm --env-file "$shared_env" \
    --env IMAGE_PROVIDER=fal \
    --env OBJECT_STORAGE_PROVIDER=aliyun-oss \
    --entrypoint node "$image" \
    dist/bin/check-deployment-environment.js crt-business-api

docker run --rm --env-file "$shared_env" \
    --env PROCESS_RUN_RECORD_STORE=postgres \
    --env CONSOLE_ENABLED=true \
    --env CRT_BUSINESS_API_BASE_URL=http://127.0.0.1:4400 \
    --entrypoint node "$image" \
    dist/bin/check-deployment-environment.js api

docker run --rm --env-file "$shared_env" \
    --volume "$app_root/shared/pg-server.crt:/etc/pipipi/pg-server.crt:ro" \
    --entrypoint npm "$image" run db:migrate

docker run --rm --env-file "$shared_env" \
    --volume "$app_root/shared/pg-server.crt:/etc/pipipi/pg-server.crt:ro" \
    --entrypoint npm "$image" run audit:production-database

if docker inspect pipipi >/dev/null 2>&1; then
    previous_image="$(docker inspect pipipi --format '{{.Config.Image}}')"
    previous_revision="$(docker inspect pipipi --format '{{index .Config.Labels "com.pipipi.revision"}}')"
    if docker inspect pipipi-business-api >/dev/null 2>&1; then
        previous_has_business="true"
    fi
fi

if [ -f "$compose_file" ]; then
    cp -p "$compose_file" "$previous_compose"
fi
install -m 600 "$compose_source" "$compose_file"

activate() {
    target_image="$1"
    target_revision="$2"
    PIPIPI_IMAGE="$target_image" \
    PIPIPI_REVISION="$target_revision" \
    PIPIPI_ENV_FILE="$shared_env" \
        docker compose --project-name pipipi \
        --file "$compose_file" up -d --force-recreate --no-build

    actual_image="$(docker inspect pipipi --format '{{.Config.Image}}')"
    actual_revision="$(docker inspect pipipi --format '{{index .Config.Labels "com.pipipi.revision"}}')"
    business_image="$(docker inspect pipipi-business-api --format '{{.Config.Image}}')"
    business_revision="$(docker inspect pipipi-business-api --format '{{index .Config.Labels "com.pipipi.revision"}}')"
    if [ "$actual_image" != "$target_image" ] || \
        [ "$actual_revision" != "$target_revision" ] || \
        [ "$business_image" != "$target_image" ] || \
        [ "$business_revision" != "$target_revision" ]; then
        echo "Container revision mismatch" >&2
        return 1
    fi
}

healthy_api() {
    curl --fail --silent --show-error http://127.0.0.1:4300/healthz >/dev/null && \
    curl --fail --silent --show-error http://127.0.0.1:4300/readyz >/dev/null && \
    curl --fail --silent --show-error http://127.0.0.1:4300/llms.txt |
        grep -Fq '# Pipipi Business Process API' && \
    curl --fail --silent --show-error http://127.0.0.1:4300/docs/api.md |
        grep -Fq '# 业务接口文档'
}

healthy() {
    attempt=1
    while [ "$attempt" -le 30 ]; do
        if curl --fail --silent --show-error http://127.0.0.1:4400/healthz >/dev/null && \
            curl --fail --silent --show-error http://127.0.0.1:4400/readyz >/dev/null && \
            healthy_api; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    return 1
}

rollback() {
    if [ -z "$previous_image" ] || [ "$previous_has_business" != "true" ]; then
        echo "No previous UAT deployment is available for rollback" >&2
        return 1
    fi
    echo "Rolling back to $previous_image" >&2
    activate "$previous_image" "$previous_revision"
    healthy
}

if ! activate "$image" "$revision" || ! healthy; then
    docker logs --tail 100 pipipi || true
    docker logs --tail 100 pipipi-business-api || true
    rollback || true
    exit 1
fi

rm -f -- "$image_archive" "$compose_source" "$previous_compose"
echo "Deployed UAT revision $revision"
