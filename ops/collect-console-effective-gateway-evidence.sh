#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <container> <domain>" >&2
    exit 64
fi

container="$1"
domain="$2"
if ! [[ "$container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
    exit 64
fi
if [ "${#domain}" -gt 253 ] || [[ "$domain" != *.* ]] || [[ "$domain" == *..* ]]; then
    exit 64
fi
IFS='.' read -r -a domain_labels <<< "$domain"
for label in "${domain_labels[@]}"; do
    if ! [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
        exit 64
    fi
done

raw="$(mktemp)"
raw_after="$(mktemp)"
diagnostics="$(mktemp)"
mounts="$(mktemp)"
mount_map="$(mktemp)"
mount_rows="$(mktemp)"
manifest="$(mktemp)"
verified="$(mktemp)"
mapped_digests="$(mktemp)"
sources="$(mktemp)"
sections="$(mktemp -d)"
cleanup() {
    rm -f -- \
        "$raw" "$raw_after" "$diagnostics" "$mounts" "$mount_map" \
        "$mount_rows" "$manifest" "$verified" "$mapped_digests" "$sources" || true
    rm -rf -- "$sections" || true
}
trap cleanup EXIT

inspection_failure() {
    local reason="$1"
    jq -n --arg failureReason "$reason" '
        {
            schemaVersion: 1,
            event: "console_effective_gateway_inspected",
            status: "inspection_failed",
            failureReason: $failureReason
        }
    '
    exit 1
}

is_canonical_absolute_path() {
    local candidate="$1"
    local wrapped="/${candidate#/}/"
    [[ "$candidate" =~ ^/[A-Za-z0-9._/-]+$ ]] &&
        [ "$candidate" != "/" ] &&
        [[ "$candidate" != *"//"* ]] &&
        [[ "$wrapped" != *"/./"* ]] &&
        [[ "$wrapped" != *"/../"* ]] &&
        [[ "$candidate" != */ ]]
}

container_realpath() {
    local candidate="$1"
    local resolved
    if ! resolved="$(docker exec "$container" readlink -f "$candidate" 2>/dev/null)"; then
        return 1
    fi
    is_canonical_absolute_path "$resolved" || return 1
    printf '%s\n' "$resolved"
}

container_sha256() {
    local candidate="$1"
    local output digest
    if ! output="$(docker exec "$container" sha256sum "$candidate" 2>/dev/null)"; then
        return 1
    fi
    digest="${output%%[[:space:]]*}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf '%s\n' "$digest"
}

host_sha256() {
    local candidate="$1"
    local output digest
    if ! output="$(sha256sum "$candidate" 2>/dev/null)"; then
        return 1
    fi
    digest="${output%%[[:space:]]*}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf '%s\n' "$digest"
}

read_effective_configuration() {
    local target="$1"
    : > "$diagnostics"
    docker exec "$container" openresty -T > "$target" 2> "$diagnostics"
}

if ! read_effective_configuration "$raw"; then
    inspection_failure "effective_configuration_read_failed"
fi
if ! docker inspect --format '{{json .Mounts}}' "$container" > "$mounts" 2>/dev/null; then
    inspection_failure "gateway_mount_inspection_failed"
fi
if ! jq -e '
    type == "array" and all(.[].Destination; type == "string") and
    all(.[].Source; type == "string") and
    all(.[].Destination; test("^/[A-Za-z0-9._/-]+$")) and
    all(.[].Source; . == "" or test("^/[A-Za-z0-9._/-]+$"))
' "$mounts" >/dev/null 2>&1; then
    inspection_failure "gateway_mount_inspection_failed"
fi
if ! jq -r '
    .[] |
    [(if .Source == "" then "__pipipi_unavailable_mount_source__" else .Source end), .Destination] |
    @tsv
' "$mounts" > "$mount_rows"; then
    inspection_failure "gateway_mount_inspection_failed"
fi
while IFS=$'\t' read -r host_source container_destination; do
    [ -n "$container_destination" ] || inspection_failure "gateway_mount_inspection_failed"
    if ! is_canonical_absolute_path "$container_destination"; then
        inspection_failure "noncanonical_gateway_mount_destination"
    fi
    if ! destination_canonical="$(container_realpath "$container_destination")"; then
        inspection_failure "noncanonical_gateway_mount_destination"
    fi
    if [ "$host_source" = "__pipipi_unavailable_mount_source__" ]; then
        printf '%s\t%s\t%s\n' - "$destination_canonical" unavailable >> "$mount_map"
        continue
    fi
    if ! is_canonical_absolute_path "$host_source" ||
        ! source_canonical="$(realpath "$host_source" 2>/dev/null)" ||
        ! is_canonical_absolute_path "$source_canonical"; then
        inspection_failure "unsupported_gateway_mount_source"
    fi
    if [ -d "$source_canonical" ]; then
        source_kind="directory"
    elif [ -f "$source_canonical" ]; then
        source_kind="file"
    else
        inspection_failure "unsupported_gateway_mount_source"
    fi
    printf '%s\t%s\t%s\n' \
        "$source_canonical" "$destination_canonical" "$source_kind" >> "$mount_map"
done < "$mount_rows"
if cut -f2 "$mount_map" | sort | uniq -d | grep -q .; then
    inspection_failure "ambiguous_gateway_mount_destination"
fi

if ! awk -v domain="$domain" -v section_directory="$sections" '
    function trim(value) {
        sub(/^[ \t\r\n]+/, "", value)
        sub(/[ \t\r\n]+$/, "", value)
        return value
    }
    function unquote(value,    first, last) {
        if (length(value) < 2) return value
        first = substr(value, 1, 1)
        last = substr(value, length(value), 1)
        if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
            return substr(value, 2, length(value) - 2)
        }
        return value
    }
    function handle_statement(kind,    value, word_count, words, field_index, token) {
        value = trim(statement)
        statement = ""
        if (value == "") return
        word_count = split(value, words, /[ \t\r\n]+/)
        if (kind == "block") {
            if (words[1] == "location") locations++
            return
        }
        if (words[1] == "server_name") {
            for (field_index = 2; field_index <= word_count; field_index++) {
                token = words[field_index]
                if (token == domain || token == "\"" domain "\"" || token == "\047" domain "\047") {
                    server_name_matches++
                    break
                }
            }
        } else if (words[1] == "auth_basic") {
            sub(/^auth_basic[ \t\r\n]+/, "", value)
            value = unquote(trim(value))
            if (value == "off") auth_off++
            else if (value ~ /\$/) auth_variable++
            else auth_other++
        } else if (words[1] == "proxy_pass") {
            proxy_passes++
        } else if (words[1] == "include") {
            includes++
        }
    }
    function process_line(line,    character, field_index) {
        for (field_index = 1; field_index <= length(line); field_index++) {
            character = substr(line, field_index, 1)
            if (escaped) {
                statement = statement character
                escaped = 0
            } else if (character == "\\") {
                statement = statement character
                escaped = 1
            } else if (quote != "") {
                statement = statement character
                if (character == quote) quote = ""
            } else if (braced_variable) {
                statement = statement character
                if (character == "}") braced_variable = 0
            } else if (character == "\"" || character == "\047") {
                statement = statement character
                quote = character
            } else if (character == "$" && substr(line, field_index + 1, 1) == "{") {
                statement = statement "${"
                braced_variable = 1
                field_index++
            } else if (character == "#") {
                break
            } else if (character == ";") {
                handle_statement("directive")
            } else if (character == "{") {
                handle_statement("block")
            } else if (character == "}") {
                if (trim(statement) != "") parse_error = 1
                statement = ""
            } else {
                statement = statement character
            }
        }
        if (statement != "" && !escaped) statement = statement " "
    }
    function finish_source() {
        if (source == "") return
        if (quote != "" || escaped || braced_variable || trim(statement) != "") parse_error = 1
        if (section_line_pending && pending_section_line != "") {
            print pending_section_line >> section_file
        }
        close(section_file)
        printf "%06d\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n", \
            source_count, source, server_name_matches, locations, auth_off, \
            auth_variable, auth_other, proxy_passes, includes
    }
    function begin_source(path) {
        source_count++
        source = path
        section_file = sprintf("%s/%06d", section_directory, source_count)
        printf "%s", "" > section_file
        close(section_file)
        statement = ""
        quote = ""
        escaped = 0
        braced_variable = 0
        section_line_pending = 0
        pending_section_line = ""
        server_name_matches = 0
        locations = 0
        auth_off = 0
        auth_variable = 0
        auth_other = 0
        proxy_passes = 0
        includes = 0
    }
    /^# configuration file / && /:$/ {
        finish_source()
        path = substr($0, length("# configuration file ") + 1)
        begin_source(substr(path, 1, length(path) - 1))
        next
    }
    source != "" {
        if (section_line_pending) print pending_section_line >> section_file
        pending_section_line = $0
        section_line_pending = 1
        process_line($0)
    }
    END {
        finish_source()
        if (source_count == 0 || parse_error) exit 2
    }
' "$raw" > "$manifest"; then
    inspection_failure "effective_configuration_parse_failed"
fi
if cut -f2 "$manifest" | sort | uniq -d | grep -q .; then
    inspection_failure "effective_configuration_source_marker_invalid"
fi

while IFS=$'\t' read -r section_id declared_path server_names locations auth_off auth_variable auth_other proxy_passes includes; do
    if ! is_canonical_absolute_path "$declared_path"; then
        inspection_failure "unsupported_effective_configuration_path"
    fi
    if ! canonical_path="$(container_realpath "$declared_path")"; then
        inspection_failure "effective_configuration_source_unavailable"
    fi
    if ! section_sha="$(host_sha256 "$sections/$section_id")" ||
        ! container_sha="$(container_sha256 "$declared_path")"; then
        inspection_failure "effective_configuration_digest_failed"
    fi
    if [ "$section_sha" != "$container_sha" ]; then
        section_size="$(wc -c < "$sections/$section_id" | tr -d ' ')"
        if ! [[ "$section_size" =~ ^[1-9][0-9]*$ ]] ||
            ! dd if="$sections/$section_id" of="$sections/$section_id.trimmed" \
                bs=1 count="$((section_size - 1))" 2>/dev/null ||
            ! trimmed_sha="$(host_sha256 "$sections/$section_id.trimmed")" ||
            [ "$trimmed_sha" != "$container_sha" ]; then
            inspection_failure "effective_configuration_source_marker_invalid"
        fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$canonical_path" "$container_sha" "$server_names" "$locations" \
        "$auth_off" "$auth_variable" "$auth_other" "$proxy_passes" "$includes" \
        >> "$verified"
done < "$manifest"
if cut -f1 "$verified" | sort | uniq -d | grep -q .; then
    inspection_failure "effective_configuration_source_marker_invalid"
fi

while IFS=$'\t' read -r container_path container_sha server_names locations auth_off auth_variable auth_other proxy_passes includes; do
    if [ "$((server_names + locations + auth_off + auth_variable + auth_other + proxy_passes + includes))" -eq 0 ]; then
        continue
    fi
    mapping="$(awk -F '\t' -v path="$container_path" '
        path == $2 || index(path, $2 "/") == 1 {
            if (length($2) > longest) {
                longest = length($2)
                row = $0
            }
        }
        END { print row }
    ' "$mount_map")"
    host_path=""
    if [ -n "$mapping" ]; then
        IFS=$'\t' read -r host_source destination source_kind <<< "$mapping"
        if [ "$source_kind" = unavailable ]; then
            host_source=""
        elif [ "$container_path" = "$destination" ]; then
            [ "$source_kind" = file ] || inspection_failure "effective_configuration_mount_mapping_failed"
            candidate="$host_source"
        else
            [ "$source_kind" = directory ] || inspection_failure "effective_configuration_mount_mapping_failed"
            relative_path="${container_path#"$destination"/}"
            [ "$relative_path" != "$container_path" ] || inspection_failure "effective_configuration_mount_mapping_failed"
            candidate="$host_source/$relative_path"
        fi
        if [ -n "$host_source" ]; then
            if ! host_path="$(realpath "$candidate" 2>/dev/null)" ||
                ! is_canonical_absolute_path "$host_path" ||
                [ ! -f "$host_path" ]; then
                inspection_failure "effective_configuration_digest_failed"
            fi
            if [ "$source_kind" = directory ] &&
                [ "$host_path" != "$host_source" ] &&
                [[ "$host_path" != "$host_source"/* ]]; then
                inspection_failure "effective_configuration_mount_boundary_failed"
            fi
            if [ "$source_kind" = file ] && [ "$host_path" != "$host_source" ]; then
                inspection_failure "effective_configuration_mount_boundary_failed"
            fi
            if ! host_sha="$(host_sha256 "$host_path")" || [ "$host_sha" != "$container_sha" ]; then
                inspection_failure "effective_configuration_digest_failed"
            fi
            printf '%s\t%s\t%s\n' "$container_path" "$host_path" "$container_sha" >> "$mapped_digests"
        fi
    fi
    jq -cn \
        --arg containerPath "$container_path" \
        --arg hostPath "$host_path" \
        --arg sha256 "$container_sha" \
        --argjson serverNameMatchCount "$server_names" \
        --argjson locationDirectiveCount "$locations" \
        --argjson authBasicOffCount "$auth_off" \
        --argjson authBasicVariableCount "$auth_variable" \
        --argjson authBasicOtherCount "$auth_other" \
        --argjson proxyPassDirectiveCount "$proxy_passes" \
        --argjson includeDirectiveCount "$includes" '
        {
            containerPath: $containerPath,
            hostPath: (if $hostPath == "" then null else $hostPath end),
            sha256: $sha256,
            serverNameMatchCount: $serverNameMatchCount,
            locationDirectiveCount: $locationDirectiveCount,
            authBasicOffCount: $authBasicOffCount,
            authBasicVariableCount: $authBasicVariableCount,
            authBasicOtherCount: $authBasicOtherCount,
            proxyPassDirectiveCount: $proxyPassDirectiveCount,
            includeDirectiveCount: $includeDirectiveCount
        }
    ' >> "$sources"
done < "$verified"

if ! read_effective_configuration "$raw_after"; then
    inspection_failure "effective_configuration_read_failed"
fi
if ! cmp -s "$raw" "$raw_after"; then
    inspection_failure "effective_configuration_changed"
fi
while IFS=$'\t' read -r container_path expected_sha _; do
    if ! current_container_sha="$(container_sha256 "$container_path")" ||
        [ "$current_container_sha" != "$expected_sha" ]; then
        inspection_failure "effective_configuration_changed"
    fi
done < "$verified"
while IFS=$'\t' read -r _container_path host_path expected_sha; do
    if ! current_host_sha="$(host_sha256 "$host_path")" ||
        [ "$current_host_sha" != "$expected_sha" ]; then
        inspection_failure "effective_configuration_changed"
    fi
done < "$mapped_digests"

jq -s '
    {
        schemaVersion: 1,
        event: "console_effective_gateway_inspected",
        status: "succeeded",
        sources: (sort_by(.containerPath))
    }
' "$sources"
