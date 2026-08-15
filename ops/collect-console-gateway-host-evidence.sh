#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <domain> <public-path> [config-root ...]" >&2
    exit 64
fi

domain="$1"
public_path="$2"
shift 2
if [ "${#domain}" -gt 253 ] || [[ "$domain" != *.* ]] || [[ "$domain" == *..* ]]; then
    exit 64
fi
IFS='.' read -r -a domain_labels <<< "$domain"
for label in "${domain_labels[@]}"; do
    if ! [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
        exit 64
    fi
done
if ! [[ "$public_path" =~ ^/[A-Za-z0-9._~/%-]*$ ]]; then
    exit 64
fi

if [ "$#" -gt 0 ]; then
    config_roots=("$@")
else
    config_roots=(
        /opt/1panel/apps/openresty/openresty/conf
        /etc/openresty
        /etc/nginx
    )
fi

for root in "${config_roots[@]}"; do
    if ! [[ "$root" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
        exit 64
    fi
done

candidates="$(mktemp)"
matches="$(mktemp)"
containers="$(mktemp)"
correlated_containers="$(mktemp)"
cleanup() {
    rm -f -- "$candidates" "$matches" "$containers" "$correlated_containers" || true
}
trap cleanup EXIT

domain_sha256="$(printf '%s' "$domain" | sha256sum | cut -d ' ' -f 1)"
inspection_failure() {
    local reason="$1"
    jq -n \
        --arg domainSha256 "$domain_sha256" \
        --arg publicPath "$public_path" \
        --arg failureReason "$reason" '
        {
            schemaVersion: 1,
            event: "console_gateway_host_inspected",
            status: "inspection_failed",
            domainSha256: $domainSha256,
            publicPath: $publicPath,
            failureReason: $failureReason
        }
    '
    exit 1
}

for root in "${config_roots[@]}"; do
    if [ ! -d "$root" ]; then
        continue
    fi
    if ! find "$root" -type f -name '*.conf' -print0 >> "$candidates" 2>/dev/null; then
        inspection_failure "config_enumeration_failed"
    fi
done

while IFS= read -r -d '' config; do
    if ! block_metrics="$(awk -v domain="$domain" -v public_path="$public_path" '
        function reset_statement(    field_index) {
            for (field_index = 1; field_index <= field_count; field_index += 1) delete fields[field_index]
            field_count = 0
        }
        function reset_server() {
            server_matches = 0
            auth_basic_count = 0
            auth_request_count = 0
            location_count = 0
            proxy_pass_count = 0
        }
        function add_field() {
            if (token != "") {
                field_count += 1
                fields[field_count] = token
                token = ""
            }
        }
        function inspect_statement(    field_index, candidate) {
            if (!in_server || field_count == 0) return
            if (fields[1] == "server_name") {
                for (field_index = 2; field_index <= field_count; field_index += 1) {
                    if (fields[field_index] == domain) server_matches = 1
                }
            } else if (fields[1] == "auth_basic") auth_basic_count += 1
            else if (fields[1] == "auth_request") auth_request_count += 1
            else if (fields[1] == "proxy_pass") proxy_pass_count += 1
            else if (fields[1] == "location") {
                for (field_index = 2; field_index <= field_count; field_index += 1) {
                    candidate = fields[field_index]
                    if (candidate == public_path || candidate == public_path "/") location_count += 1
                }
            }
        }
        function open_block() {
            add_field()
            if (!in_server && field_count == 1 && fields[1] == "server") {
                depth += 1
                in_server = 1
                server_depth = depth
                reset_server()
                reset_statement()
                return
            }
            inspect_statement()
            depth += 1
            reset_statement()
        }
        function close_block() {
            add_field()
            inspect_statement()
            reset_statement()
            depth -= 1
            if (depth < 0) invalid = 1
            if (in_server && depth < server_depth) {
                if (server_matches) {
                    printf "%d\t%d\t%d\t%d\n", auth_basic_count, auth_request_count, location_count, proxy_pass_count
                }
                in_server = 0
            }
        }
        {
            line = $0 "\n"
            for (character_index = 1; character_index <= length(line); character_index += 1) {
                character = substr(line, character_index, 1)
                if (comment) {
                    if (character == "\n") comment = 0
                    continue
                }
                if (quote != "") {
                    if (escaped) {
                        token = token character
                        escaped = 0
                    } else if (character == "\\") escaped = 1
                    else if (character == quote) quote = ""
                    else token = token character
                    continue
                }
                if (character == "#") {
                    add_field()
                    comment = 1
                } else if (character == "\"" || character == "\047") quote = character
                else if (character == "{") open_block()
                else if (character == "}") close_block()
                else if (character == ";") {
                    add_field()
                    inspect_statement()
                    reset_statement()
                } else if (character ~ /[[:space:]]/) add_field()
                else token = token character
            }
        }
        END {
            if (depth != 0 || in_server || quote != "" || invalid) exit 2
        }
    ' "$config")"; then
        inspection_failure "config_parse_failed"
    fi
    if [ -n "$block_metrics" ]; then
        while IFS= read -r metrics; do
            printf '%s\t%s\n' "$config" "$metrics" >> "$matches"
        done <<< "$block_metrics"
    fi
done < "$candidates"

matching_server_block_count="$(wc -l < "$matches" | tr -d ' ')"
matching_config_count="$(cut -f 1 "$matches" | sort -u | wc -l | tr -d ' ')"

status="not_found"
config_json="null"
config=""
if [ "$matching_server_block_count" -gt 1 ]; then
    status="ambiguous"
elif [ "$matching_server_block_count" -eq 1 ]; then
    status="discovered"
    IFS=$'\t' read -r config auth_basic_count auth_request_count console_location_count proxy_pass_count < "$matches"
    config_sha256="$(sha256sum "$config" | cut -d ' ' -f 1)"
    config_json="$(jq -n \
        --arg path "$config" \
        --arg sha256 "$config_sha256" \
        --argjson authBasicDirectiveCount "$auth_basic_count" \
        --argjson authRequestDirectiveCount "$auth_request_count" \
        --argjson consoleLocationDirectiveCount "$console_location_count" \
        --argjson proxyPassDirectiveCount "$proxy_pass_count" '
        {
            path: $path,
            sha256: $sha256,
            authBasicDirectiveCount: $authBasicDirectiveCount,
            authRequestDirectiveCount: $authRequestDirectiveCount,
            consoleLocationDirectiveCount: $consoleLocationDirectiveCount,
            proxyPassDirectiveCount: $proxyPassDirectiveCount
        }
    ')"
fi

reload_adapter="unavailable"
if [ "$status" = "ambiguous" ]; then
    reload_adapter="ambiguous"
elif [ "$status" = "discovered" ] && command -v docker >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null |
        awk 'tolower($0) ~ /(openresty|nginx)/ { print $1 }' |
        sort -u > "$containers"; then
        while IFS= read -r container; do
            [ -n "$container" ] || continue
            if mounts="$(docker inspect --format '{{json .Mounts}}' "$container" 2>/dev/null)" &&
                jq -e --arg config "$config" '
                    any(.[]?;
                        .Source as $source |
                        ($source | type) == "string" and
                        ($config == $source or ($config | startswith($source + "/")))
                    )
                ' >/dev/null 2>&1 <<< "$mounts"; then
                printf '%s\n' "$container" >> "$correlated_containers"
            fi
        done < "$containers"
    fi
fi
sort -u -o "$correlated_containers" "$correlated_containers"
container_count="$(wc -l < "$correlated_containers" | tr -d ' ')"
container_names="$(jq -Rsc 'split("\n") | map(select(length > 0))' "$correlated_containers")"
if [ "$status" = "discovered" ] && [ "$container_count" -eq 1 ]; then
    reload_adapter="docker_container"
elif [ "$status" = "discovered" ] && [ "$container_count" -gt 1 ]; then
    reload_adapter="ambiguous"
fi

jq -n \
    --arg domainSha256 "$domain_sha256" \
    --arg publicPath "$public_path" \
    --arg status "$status" \
    --argjson matchingConfigCount "$matching_config_count" \
    --argjson matchingServerBlockCount "$matching_server_block_count" \
    --argjson config "$config_json" \
    --arg reloadAdapter "$reload_adapter" \
    --argjson containerNames "$container_names" '
    {
        schemaVersion: 1,
        event: "console_gateway_host_inspected",
        status: $status,
        domainSha256: $domainSha256,
        publicPath: $publicPath,
        matchingConfigCount: $matchingConfigCount,
        matchingServerBlockCount: $matchingServerBlockCount,
        config: $config,
        reloadAdapter: {
            kind: $reloadAdapter,
            containerNames: $containerNames
        }
    }
'
