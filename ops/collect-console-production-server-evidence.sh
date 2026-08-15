#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <app-root> <revision>" >&2
    exit 64
fi

app_root="$1"
revision="$2"
failure_gate="runtime_revision"
failure_reason="runtime_revision_mismatch"
database_audit_failure="not_run"
active_database_url_configured=false
shared_database_url_configured=false
database_ca_present=false
backup_evidence_present=false
audit_error=""

cleanup() {
    if [ -n "$audit_error" ] && [ -f "$audit_error" ]; then
        rm -f -- "$audit_error" || true
    fi
}

record_failure() {
    exit_code="$?"
    trap - EXIT
    cleanup
    if [ "$exit_code" -ne 0 ]; then
        jq -n \
            --arg revision "$revision" \
            --arg failureGate "$failure_gate" \
            --arg failureReason "$failure_reason" \
            --arg databaseAuditFailure "$database_audit_failure" \
            --argjson activeDatabaseUrlConfigured "$active_database_url_configured" \
            --argjson sharedDatabaseUrlConfigured "$shared_database_url_configured" \
            --argjson databaseCaPresent "$database_ca_present" \
            --argjson backupEvidencePresent "$backup_evidence_present" '
            {
                schemaVersion: 1,
                event: "console_server_readiness_failed",
                revision: $revision,
                status: "failed",
                failureGate: $failureGate,
                failureReason: $failureReason,
                databaseAuditFailure: (
                    if $databaseAuditFailure == "not_run" or
                       $databaseAuditFailure == "none"
                    then null
                    else $databaseAuditFailure
                    end
                ),
                prerequisites: {
                    activeDatabaseUrlConfigured: $activeDatabaseUrlConfigured,
                    sharedDatabaseUrlConfigured: $sharedDatabaseUrlConfigured,
                    databaseCaPresent: $databaseCaPresent,
                    backupEvidencePresent: $backupEvidencePresent
                }
            }
        '
    fi
    exit "$exit_code"
}
trap record_failure EXIT

[[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]]
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
for container in pipipi pipipi-business-api; do
    test "$(docker inspect "$container" --format '{{index .Config.Labels "com.pipipi.revision"}}')" = "$revision"
done

shared_env="$app_root/shared/.env"
if [ -f "$shared_env" ] && awk '
    index($0, "DATABASE_URL=") == 1 {
        value = substr($0, length("DATABASE_URL=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (length(value) > 0) found = 1
    }
    END { exit(found ? 0 : 1) }
' "$shared_env"; then
    shared_database_url_configured=true
fi
if docker inspect pipipi --format '{{range .Config.Env}}{{println .}}{{end}}' | awk '
    index($0, "DATABASE_URL=") == 1 {
        value = substr($0, length("DATABASE_URL=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if (length(value) > 0) found = 1
    }
    END { exit(found ? 0 : 1) }
'; then
    active_database_url_configured=true
fi
if [ -f "$app_root/shared/pg-server.crt" ]; then
    database_ca_present=true
fi
backup="$app_root/shared/postgres-backup/evidence.json"
if [ -f "$backup" ]; then
    backup_evidence_present=true
fi

failure_gate="async_observation_shape"
failure_reason="async_observation_shape_invalid"
async_shape=false
if test -f "$app_root/shared/compose.production.async.yaml"; then
    async_shape=true
    test "$(docker inspect pipipi-process-worker --format '{{index .Config.Labels "com.pipipi.revision"}}')" = "$revision"
    worker_store="$(docker inspect pipipi-process-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PROCESS_RUN_RECORD_STORE=//p')"
    worker_content="$(docker inspect pipipi-process-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PROCESS_RUN_RECORD_CONTENT=//p')"
    test "$worker_store" = "postgres"
    test "$worker_content" = "accepted-input-and-output"
fi

classify_database_audit_failure() {
    if grep -Fq "DATABASE_URL is required" "$audit_error"; then
        database_audit_failure="database_url_required"
    elif grep -Fq "must use TLS" "$audit_error"; then
        database_audit_failure="tls_required"
    elif grep -Fq "must be application-dedicated" "$audit_error"; then
        database_audit_failure="dedicated_database_required"
    elif grep -Fq "must use a non-superuser role" "$audit_error"; then
        database_audit_failure="non_superuser_required"
    elif grep -Fq "must not have administrative privileges" "$audit_error"; then
        database_audit_failure="administrative_privileges_present"
    elif grep -Fq "must not access other databases" "$audit_error"; then
        database_audit_failure="other_database_access_present"
    elif grep -Fq "must not switch roles" "$audit_error"; then
        database_audit_failure="role_switching_present"
    elif grep -Fq "must not inherit or switch to another role" "$audit_error"; then
        database_audit_failure="role_membership_present"
    elif grep -Fq "identity audit returned an invalid result" "$audit_error"; then
        database_audit_failure="invalid_audit_result"
    else
        database_audit_failure="connection_or_unclassified_failure"
    fi
}

failure_gate="database_audit"
failure_reason="database_audit_failed"
audit_error="$(mktemp)"
if ! database="$(docker exec pipipi npm run --silent audit:production-database 2>"$audit_error")"; then
    classify_database_audit_failure
    exit 1
fi
database_audit_failure="invalid_audit_result"
jq --exit-status '
    .event == "production_database_identity_verified" and
    (.databaseIdentitySha256 | test("^[0-9a-f]{64}$")) and
    .tlsVerified == true and
    .dedicatedDatabaseVerified == true and
    .nonSuperuserVerified == true and
    .administrativePrivilegesAbsent == true and
    .otherDatabaseAccessAbsent == true and
    .roleMembershipAbsent == true and
    .roleSwitchingAbsent == true
' <<< "$database" >/dev/null
database_audit_failure="none"

failure_gate="backup_evidence"
failure_reason="backup_evidence_missing"
test "$backup_evidence_present" = true
failure_reason="backup_evidence_invalid"
now="$(date -u +%s)"
jq --exit-status --argjson database "$database" --argjson now "$now" '
    .schemaVersion == 1 and
    .event == "postgres_backup_verified" and
    .status == "succeeded" and
    (.databaseIdentitySha256 | test("^[0-9a-f]{64}$")) and
    .databaseIdentitySha256 == $database.databaseIdentitySha256 and
    (.backupId | type == "string" and test("^[A-Za-z0-9._:/-]{1,128}$")) and
    (.completedAt | fromdateiso8601) <= $now and
    (.completedAt | fromdateiso8601) >= ($now - 86400) and
    (.restoreVerifiedAt | fromdateiso8601) <= $now and
    (.restoreVerifiedAt | fromdateiso8601) >= ($now - 7776000) and
    (.retentionUntil | fromdateiso8601) >= ($now + 2592000)
' "$backup" >/dev/null

cleanup
trap - EXIT
jq -n \
    --arg revision "$revision" \
    --argjson asyncShape "$async_shape" \
    --argjson database "$database" \
    --slurpfile backup "$backup" '
    {
        revision: $revision,
        database: $database,
        backup: {
            databaseIdentitySha256: $backup[0].databaseIdentitySha256,
            backupId: $backup[0].backupId,
            completedAt: $backup[0].completedAt,
            restoreVerifiedAt: $backup[0].restoreVerifiedAt,
            retentionUntil: $backup[0].retentionUntil,
            signatureSha256: $backup[0].signatureSha256
        },
        runtime: { asyncShape: $asyncShape }
    }
'
