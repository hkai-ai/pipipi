#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 11 ]; then
    echo "Usage: $0 <domain> <public-path> <public-url> <revision> <host-config> <config-sha256> <container> <container-config> <htpasswd-source> <authorization-source> <collector>" >&2
    exit 64
fi

domain="$1"
public_path="$2"
public_url="$3"
revision="$4"
host_config="$5"
expected_config_sha256="$6"
container="$7"
container_config="$8"
htpasswd_source="$9"
authorization_source="${10}"
collector="${11}"

if ! [[ "$domain" =~ ^[a-z0-9.-]+$ ]] ||
    ! [[ "$public_path" =~ ^/[A-Za-z0-9_-]+$ ]] ||
    [ "$public_url" != "https://$domain$public_path" ] ||
    ! [[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$expected_config_sha256" =~ ^[0-9a-f]{64}$ ]] ||
    ! [[ "$host_config" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    ! [[ "$container_config" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    ! [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    exit 64
fi
for source in "$htpasswd_source" "$authorization_source" "$collector"; do
    if ! [[ "$source" =~ ^/[A-Za-z0-9._/-]+$ ]] || [ ! -f "$source" ]; then
        exit 64
    fi
done

# The dollar signs below are literal htpasswd format delimiters.
# shellcheck disable=SC2016
if [ "$(wc -l < "$htpasswd_source" | tr -d ' ')" -ne 1 ] ||
    ! grep -Eq '^[A-Za-z0-9._-]+:\$(apr1|2[aby]|5|6)\$[^[:space:]]+$' "$htpasswd_source"; then
    echo "Invalid htpasswd credential" >&2
    exit 65
fi
if [ "$(wc -l < "$authorization_source" | tr -d ' ')" -ne 1 ]; then
    echo "Invalid Authorization credential" >&2
    exit 65
fi
authorization="$(sed -n '1p' "$authorization_source")"
if ! [[ "$authorization" =~ ^Basic\ [A-Za-z0-9+/]+=*$ ]]; then
    echo "Invalid Authorization credential" >&2
    exit 65
fi
if ! decoded_authorization="$(printf '%s' "${authorization#Basic }" | base64 --decode 2>/dev/null)" ||
    [[ "$decoded_authorization" != *:* ]] ||
    [ "${decoded_authorization%%:*}" != "$(cut -d: -f1 "$htpasswd_source")" ] ||
    [ -z "${decoded_authorization#*:}" ]; then
    echo "Credential identities do not match" >&2
    exit 65
fi
unset decoded_authorization

for command in awk base64 curl docker jq realpath sha256sum; do
    command -v "$command" >/dev/null 2>&1 || {
        echo "Required command is unavailable: $command" >&2
        exit 69
    }
done

evidence="$(mktemp)"
candidate=""
auth_candidate=""
backup_directory="$(mktemp -d)"
curl_config="$backup_directory/curl.conf"
headers="$backup_directory/headers"
anonymous_headers="$backup_directory/anonymous-headers"
auth_host_config="$(dirname "$host_config")/.pipipi-console.htpasswd"
auth_container_config="$(dirname "$container_config")/.pipipi-console.htpasswd"
config_backup="$backup_directory/site.conf"
auth_backup="$backup_directory/htpasswd"
auth_existed=false
credential_mutation_started=false
config_mutation_started=false
activated_config_sha256=""
credential_sha256="$(sha256sum "$htpasswd_source" | cut -d ' ' -f 1)"
auth_backup_sha256=""
rollback_status="not_required"
failure_stage="precondition"

cleanup() {
    rm -f -- "$evidence"
    if [ -n "$candidate" ]; then rm -f -- "$candidate"; fi
    if [ -n "$auth_candidate" ]; then rm -f -- "$auth_candidate"; fi
    rm -rf -- "$backup_directory"
}

rollback() {
    local result=0
    local config_ready_for_reload=false
    local active_config_rollback_confirmed=true
    trap - ERR HUP INT TERM
    set +e
    if [ "$config_mutation_started" = true ]; then
        active_config_rollback_confirmed=false
        current_config_sha256="$(sha256sum "$host_config" 2>/dev/null | cut -d ' ' -f 1)"
        if [ "$current_config_sha256" = "$activated_config_sha256" ]; then
            if cp -p -- "$config_backup" "$host_config"; then
                config_ready_for_reload=true
            else
                result=1
            fi
        elif [ "$current_config_sha256" = "$expected_config_sha256" ]; then
            config_ready_for_reload=true
        else
            result=1
        fi
    fi
    if [ "$config_ready_for_reload" = true ]; then
        if docker exec "$container" openresty -t >/dev/null 2>&1 &&
            docker exec "$container" openresty -s reload >/dev/null 2>&1; then
            active_config_rollback_confirmed=true
        else
            result=1
        fi
    fi
    if [ "$credential_mutation_started" = true ] &&
        [ "$active_config_rollback_confirmed" = true ]; then
        current_credential_sha256="missing"
        if [ -f "$auth_host_config" ] && [ ! -L "$auth_host_config" ]; then
            current_credential_sha256="$(sha256sum "$auth_host_config" 2>/dev/null | cut -d ' ' -f 1)"
        fi
        if [ "$current_credential_sha256" = "$credential_sha256" ]; then
            if [ "$auth_existed" = true ]; then
                cp -p -- "$auth_backup" "$auth_host_config" || result=1
            else
                rm -f -- "$auth_host_config" || result=1
            fi
        elif [ "$auth_existed" = true ] &&
            [ "$current_credential_sha256" = "$auth_backup_sha256" ]; then
            :
        elif [ "$auth_existed" = false ] &&
            [ "$current_credential_sha256" = "missing" ]; then
            :
        else
            result=1
        fi
    fi
    if [ "$config_mutation_started" = false ] &&
        [ "$credential_mutation_started" = false ]; then
        rollback_status="not_required"
    elif [ "$result" -eq 0 ]; then
        rollback_status="succeeded"
    else
        rollback_status="failed"
    fi
    jq -n \
        --arg revision "$revision" \
        --arg failureStage "$failure_stage" \
        --arg rollbackStatus "$rollback_status" '
        {
            schemaVersion: 1,
            event: "console_gateway_auth_change_failed",
            status: "failed",
            revision: $revision,
            failureStage: $failureStage,
            rollbackStatus: $rollbackStatus
        }
    ' || true
    cleanup
    trap - EXIT
    exit 1
}
trap rollback ERR HUP INT TERM
trap cleanup EXIT

actual_config_sha256="$(sha256sum "$host_config" | cut -d ' ' -f 1)"
if [ "$actual_config_sha256" != "$expected_config_sha256" ]; then
    echo "Gateway configuration digest changed" >&2
    rollback
fi

"$collector" "$domain" "$public_path" > "$evidence"
jq --exit-status \
    --arg path "$host_config" \
    --arg sha256 "$expected_config_sha256" \
    --arg container "$container" \
    --arg containerPath "$container_config" '
    .status == "discovered" and
    .matchingServerBlockCount == 1 and
    .config.path == $path and
    .config.sha256 == $sha256 and
    .config.authBasicDirectiveCount == 0 and
    .config.authRequestDirectiveCount == 0 and
    .reloadAdapter.kind == "docker_container" and
    .reloadAdapter.containerNames == [$container] and
    .reloadAdapter.configPath == $containerPath
' "$evidence" >/dev/null

cp -p -- "$host_config" "$config_backup"
if [ "$(sha256sum "$config_backup" | cut -d ' ' -f 1)" != "$expected_config_sha256" ]; then
    echo "Gateway configuration changed during evidence collection" >&2
    rollback
fi
if [ -e "$auth_host_config" ] || [ -L "$auth_host_config" ]; then
    if [ -L "$auth_host_config" ] || [ ! -f "$auth_host_config" ]; then
        echo "Existing Console credential path is not a regular file" >&2
        rollback
    fi
    cp -p -- "$auth_host_config" "$auth_backup"
    auth_backup_sha256="$(sha256sum "$auth_backup" | cut -d ' ' -f 1)"
    auth_existed=true
fi

candidate="$(mktemp "$(dirname "$host_config")/.pipipi-console-config.XXXXXX")"
cp -p -- "$config_backup" "$candidate"
regex_path="$(printf '%s' "$public_path" | sed 's/[][\\.^$*+?{}|()]/\\&/g')"
if ! awk \
    -v domain="$domain" \
    -v regex_path="$regex_path" \
    -v auth_file="$auth_container_config" '
    function matches_domain(    line, count, fields, field_index) {
        line = $0
        sub(/[[:space:]]*#.*/, "", line)
        if (line !~ /^[[:space:]]*server_name[[:space:]]+[^;]+;[[:space:]]*$/) return 0
        sub(/^[[:space:]]*/, "", line)
        sub(/;[[:space:]]*$/, "", line)
        count = split(line, fields, /[[:space:]]+/)
        for (field_index = 2; field_index <= count; field_index += 1) {
            if (fields[field_index] == domain) return 1
        }
        return 0
    }
    {
        matched = matches_domain()
        if (matched) matches += 1
        lines[NR] = $0
        match_lines[NR] = matched
    }
    END {
        if (matches != 1) exit 42
        for (line_number = 1; line_number <= NR; line_number += 1) {
            print lines[line_number]
            if (match_lines[line_number]) {
                match(lines[line_number], /^[[:space:]]*/)
                indent = substr(lines[line_number], RSTART, RLENGTH)
                print indent "set $pipipi_console_realm off;"
                print indent "if ($uri ~ ^" regex_path "(?:/|$)) {"
                print indent "    set $pipipi_console_realm \"pipipi console\";"
                print indent "}"
                print indent "auth_basic $pipipi_console_realm;"
                print indent "auth_basic_user_file " auth_file ";"
            }
        }
    }
' "$config_backup" > "$candidate"; then
    echo "A unique standalone server_name directive is required" >&2
    rollback
fi

worker_user="$(docker exec "$container" sh -c '
    openresty -T 2>&1 |
        awk '\''$1 == "user" { gsub(/;/, "", $2); print $2 }'\'' |
        sort -u
')"
if ! [[ "$worker_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
    echo "A unique OpenResty worker user is required" >&2
    rollback
fi
worker_gid="$(docker exec "$container" id -g "$worker_user")"
if ! [[ "$worker_gid" =~ ^[0-9]+$ ]]; then
    echo "OpenResty worker group is invalid" >&2
    rollback
fi
if [ "$(sha256sum "$host_config" | cut -d ' ' -f 1)" != "$expected_config_sha256" ]; then
    echo "Gateway configuration changed before credential installation" >&2
    rollback
fi

failure_stage="credential_installation"
auth_candidate="$(mktemp "$(dirname "$auth_host_config")/.pipipi-console-auth.XXXXXX")"
auth_candidate_container="$(dirname "$auth_container_config")/$(basename "$auth_candidate")"
install -m 600 -- "$htpasswd_source" "$auth_candidate"
docker exec "$container" chown "root:$worker_gid" "$auth_candidate_container"
docker exec "$container" chmod 640 "$auth_candidate_container"
if [ "$(docker exec "$container" stat -c '%a:%g' "$auth_candidate_container")" != "640:$worker_gid" ]; then
    echo "Console credential permissions are invalid" >&2
    rollback
fi
if [ "$(sha256sum "$host_config" | cut -d ' ' -f 1)" != "$expected_config_sha256" ]; then
    echo "Gateway configuration changed before activation" >&2
    rollback
fi
failure_stage="credential_activation"
credential_mutation_started=true
mv -f -- "$auth_candidate" "$auth_host_config"
auth_candidate=""
if [ "$(docker exec "$container" stat -c '%a:%g' "$auth_container_config")" != "640:$worker_gid" ]; then
    echo "Activated Console credential permissions are invalid" >&2
    rollback
fi
activated_config_sha256="$(sha256sum "$candidate" | cut -d ' ' -f 1)"
config_mutation_started=true
mv -f -- "$candidate" "$host_config"
candidate=""
failure_stage="configuration_test"
docker exec "$container" openresty -t >/dev/null
failure_stage="reload"
docker exec "$container" openresty -s reload >/dev/null

printf 'header = "Authorization: %s"\n' "$authorization" > "$curl_config"
chmod 600 "$curl_config"
anonymous_statuses=""
authenticated_statuses=""
for suffix in "" "/processes" "/stats?hours=1"; do
    failure_stage="anonymous_probe"
    : > "$anonymous_headers"
    anonymous_status="$(curl --silent --show-error --output /dev/null \
        --dump-header "$anonymous_headers" --write-out '%{http_code}' \
        --connect-timeout 10 --max-time 20 --proto '=https' \
        "$public_url$suffix")"
    if [ "$anonymous_status" != "401" ] || ! awk '
        {
            line = tolower($0)
            sub(/\r$/, "", line)
            if (line ~ /^www-authenticate:[[:space:]]*basic([[:space:]]|$)/) found = 1
        }
        END { exit(found ? 0 : 1) }
    ' "$anonymous_headers"; then
        echo "Anonymous Console probe was not rejected" >&2
        rollback
    fi
    failure_stage="authenticated_probe"
    : > "$headers"
    authenticated_status="$(curl --silent --show-error --output /dev/null \
        --dump-header "$headers" --write-out '%{http_code}' \
        --connect-timeout 10 --max-time 20 --proto '=https' \
        --config "$curl_config" "$public_url$suffix")"
    if [ "$authenticated_status" != "200" ]; then
        echo "Authenticated Console probe failed" >&2
        rollback
    fi
    failure_stage="revision_probe"
    if ! awk -v revision="$revision" '
        BEGIN { found = 0 }
        {
            line = $0
            sub(/\r$/, "", line)
            if (tolower(line) == "x-pipipi-revision: " revision) found = 1
        }
        END { exit(found ? 0 : 1) }
    ' "$headers"; then
        echo "Console revision probe failed" >&2
        rollback
    fi
    anonymous_statuses+="${anonymous_status}"$'\n'
    authenticated_statuses+="${authenticated_status}"$'\n'
done

failure_stage="credential_consistency"
if [ "$(sha256sum "$auth_host_config" 2>/dev/null | cut -d ' ' -f 1)" != "$credential_sha256" ] ||
    [ "$(docker exec "$container" stat -c '%a:%g' "$auth_container_config")" != "640:$worker_gid" ]; then
    echo "Console credential changed during public verification" >&2
    rollback
fi
failure_stage="configuration_consistency"
config_sha256="$(sha256sum "$host_config" | cut -d ' ' -f 1)"
if [ "$config_sha256" != "$activated_config_sha256" ]; then
    echo "Gateway configuration changed during public verification" >&2
    rollback
fi
failure_stage="evidence"
if ! jq -n \
    --arg revision "$revision" \
    --arg configSha256 "$config_sha256" \
    --arg rollbackStatus "$rollback_status" \
    --arg anonymousStatuses "$anonymous_statuses" \
    --arg authenticatedStatuses "$authenticated_statuses" '
    {
        schemaVersion: 1,
        event: "console_gateway_auth_changed",
        status: "succeeded",
        revision: $revision,
        configSha256: $configSha256,
        anonymousStatus: ($anonymousStatuses | split("\n") | map(select(length > 0) | tonumber)),
        authenticatedStatus: ($authenticatedStatuses | split("\n") | map(select(length > 0) | tonumber)),
        rollbackStatus: $rollbackStatus
    }
'; then
    rollback
fi
trap - ERR HUP INT TERM
