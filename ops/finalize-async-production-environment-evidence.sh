#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 6 ]; then
    exit 64
fi

evidence="$1"
execution_exit_code="$2"
active_revision="$3"
candidate_revision="$4"
mode="$5"
change_reference="$6"

if ! [[ "$execution_exit_code" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]] ||
    ! [[ "$active_revision" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$candidate_revision" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$mode" =~ ^(plan|apply)$ ]] ||
    ! [[ "$change_reference" =~ ^issue-[1-9][0-9]{0,9}$ ]]; then
    exit 64
fi

evidence_status="$(jq -er \
    --arg activeRevision "$active_revision" \
    --arg candidateRevision "$candidate_revision" \
    --arg changeReference "$change_reference" \
    --arg mode "$mode" '
    def exact_keys($expected): (keys | sort) == ($expected | sort);
    def common_shape:
        .schemaVersion == 1 and
        .event == "async_production_environment_provisioned" and
        .mode == $mode and
        .activeRevision == $activeRevision and
        .candidateRevision == $candidateRevision and
        .changeReference == $changeReference and
        (.candidateVerified | type == "boolean") and
        (.applied | type == "boolean") and
        (
            .rollbackStatus == "not_required" or
            .rollbackStatus == "succeeded" or
            .rollbackStatus == "failed" or
            .rollbackStatus == "not_observed"
        ) and
        (
            .cleanupStatus == "not_required" or
            .cleanupStatus == "succeeded" or
            .cleanupStatus == "failed" or
            .cleanupStatus == "not_observed"
        );
    if
        type == "object" and common_shape and
        (
            (
                .status == "succeeded" and
                .candidateVerified == true and
                .applied == (.mode == "apply") and
                .rollbackStatus == "not_required" and
                .cleanupStatus == "succeeded" and
                exact_keys([
                    "schemaVersion", "event", "status", "mode",
                    "activeRevision", "candidateRevision", "changeReference",
                    "candidateVerified", "applied", "rollbackStatus", "cleanupStatus"
                ])
            ) or
            (
                .status == "failed" and
                .candidateVerified == false and
                (.failureReason | type == "string" and test("^[a-z0-9_]{1,64}$")) and
                exact_keys([
                    "schemaVersion", "event", "status", "mode",
                    "activeRevision", "candidateRevision", "changeReference",
                    "candidateVerified", "applied", "rollbackStatus", "cleanupStatus",
                    "failureReason"
                ])
            )
        )
    then .status
    else empty
    end
' "$evidence" 2>/dev/null || true)"

if { [ "$execution_exit_code" -eq 0 ] && [ "$evidence_status" = succeeded ]; } ||
    { [ "$execution_exit_code" -ne 0 ] && [ "$evidence_status" = failed ]; }; then
    exit "$execution_exit_code"
fi

temporary="$evidence.tmp.$$"
cleanup() {
    rm -f -- "$temporary"
}
trap cleanup EXIT
if ! jq -n \
    --arg activeRevision "$active_revision" \
    --arg candidateRevision "$candidate_revision" \
    --arg changeReference "$change_reference" \
    --arg mode "$mode" '
    {
        schemaVersion: 1,
        event: "async_production_environment_provisioned",
        status: "failed",
        mode: $mode,
        activeRevision: $activeRevision,
        candidateRevision: $candidateRevision,
        changeReference: $changeReference,
        candidateVerified: false,
        applied: false,
        rollbackStatus: "not_observed",
        cleanupStatus: "not_observed",
        failureReason: "workflow_transport_or_execution_failed"
    }
' > "$temporary" || ! mv -f -- "$temporary" "$evidence"; then
    exit 1
fi
trap - EXIT

if [ "$execution_exit_code" -eq 0 ]; then
    exit 1
fi
exit "$execution_exit_code"
