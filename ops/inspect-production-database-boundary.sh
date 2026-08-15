#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -ne 3 ]; then
    exit 64
fi

app_root="$1"
active_revision="$2"
candidate_revision="$3"

if ! [[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    ! [[ "$active_revision" =~ ^[0-9a-f]{40}$ ]] ||
    ! [[ "$candidate_revision" =~ ^[0-9a-f]{40}$ ]]; then
    exit 64
fi

shared="$app_root/shared"
shared_env="$shared/.env"
database_ca="$shared/pg-server.crt"
image="pipipi:$candidate_revision"
diagnostics="$(mktemp)"
result="$(mktemp)"
database_env="$(mktemp)"
active_database_env="$(mktemp)"
cleanup() {
    rm -f -- "$diagnostics" "$result" "$database_env" "$active_database_env"
}
trap cleanup EXIT
on_signal() {
    local exit_code="$1"
    trap - EXIT HUP INT TERM
    cleanup
    exit "$exit_code"
}
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
chmod 600 "$database_env" "$active_database_env"

inspection_failure() {
    local reason="$1"
    jq -n --arg failureReason "$reason" '
        {
            schemaVersion: 1,
            event: "production_database_boundary_inspected",
            status: "inspection_failed",
            failureReason: $failureReason
        }
    '
    exit 1
}

if [ ! -f "$shared_env" ] || [ ! -f "$database_ca" ]; then
    inspection_failure "database_boundary_prerequisite_missing"
fi
if [ "$(docker inspect pipipi --format '{{index .Config.Labels "com.pipipi.revision"}}' 2>/dev/null)" != "$active_revision" ]; then
    inspection_failure "active_revision_mismatch"
fi
if ! candidate_image_id="$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" ||
    ! [[ "$candidate_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    inspection_failure "candidate_image_unavailable"
fi
if ! awk '
    index($0, "DATABASE_URL=") == 1 {
        count++
        if (count == 1) print
    }
    END { if (count != 1) exit 1 }
' "$shared_env" > "$database_env"; then
    inspection_failure "database_url_configuration_invalid"
fi
if ! docker inspect pipipi --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
    awk '
        index($0, "DATABASE_URL=") == 1 {
            count++
            if (count == 1) print
        }
        END { if (count != 1) exit 1 }
    ' > "$active_database_env"; then
    inspection_failure "active_database_url_unavailable"
fi
if ! cmp -s "$database_env" "$active_database_env"; then
    inspection_failure "active_database_url_mismatch"
fi

if ! docker run --rm -i \
    --network host \
    --env-file "$database_env" \
    --volume "$database_ca:/etc/pipipi/pg-server.crt:ro" \
    --entrypoint node "$candidate_image_id" --input-type=module - \
    > "$result" 2> "$diagnostics" <<'NODE'
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) process.exit(1);

let source;
try {
    source = new URL(connectionString);
} catch {
    process.exit(1);
}
if (!/^postgres(?:ql)?:$/.test(source.protocol)) process.exit(1);

const pinned = new URL(source);
pinned.searchParams.set("uselibpqcompat", "true");
pinned.searchParams.set("sslmode", "verify-ca");
pinned.searchParams.delete("ssl");
pinned.searchParams.delete("sslcert");
pinned.searchParams.delete("sslkey");
pinned.searchParams.set("sslrootcert", "/etc/pipipi/pg-server.crt");
const tlsRequired = new URL(source);
tlsRequired.searchParams.set("uselibpqcompat", "true");
tlsRequired.searchParams.set("sslmode", "require");
tlsRequired.searchParams.delete("ssl");
tlsRequired.searchParams.delete("sslcert");
tlsRequired.searchParams.delete("sslkey");
tlsRequired.searchParams.delete("sslrootcert");

function classifyTlsFailure(error) {
    const code =
        typeof error === "object" && error !== null && "code" in error &&
        typeof error.code === "string" ? error.code : "";
    const message =
        error instanceof Error ? error.message.toLowerCase() : "";
    if (
        [
            "DEPTH_ZERO_SELF_SIGNED_CERT",
            "ERR_TLS_CERT_ALTNAME_INVALID",
            "SELF_SIGNED_CERT_IN_CHAIN",
            "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        ].includes(code)
    ) return "certificate_verification_failed";
    if (code.startsWith("28")) return "authentication_failed";
    if (
        message.includes("does not support ssl") ||
        message.includes("ssl is not enabled")
    ) return "server_tls_unavailable";
    if (
        code.startsWith("08") ||
        ["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ETIMEDOUT"].includes(code)
    ) return "transport_failure";
    if (message.includes("certificate")) {
        return "certificate_verification_failed";
    }
    return "unexpected_failure";
}

async function inspect(target) {
    const pool = new Pool({
        connectionString: target,
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
        statement_timeout: 5_000,
        max: 1,
    });
    try {
        const result = await pool.query(`
            SELECT
              current_user AS "currentUser",
              session_user AS "sessionUser",
              role.rolsuper AS "superuser",
              role.rolcreaterole OR role.rolcreatedb OR role.rolreplication OR
                role.rolbypassrls OR NOT role.rolcanlogin
                AS "administrativePrivilegesPresent",
              EXISTS (
                SELECT 1
                FROM pg_database AS other_database
                WHERE other_database.datallowconn
                  AND NOT other_database.datistemplate
                  AND other_database.datname <> current_database()
                  AND has_database_privilege(
                    session_user,
                    other_database.oid,
                    'CONNECT'
                  )
              ) AS "otherDatabaseAccessPresent",
              EXISTS (
                SELECT 1
                FROM pg_roles AS member_role
                WHERE member_role.rolname <> session_user
                  AND pg_has_role(session_user, member_role.oid, 'MEMBER')
              ) AS "roleMembershipPresent",
              COALESCE(ssl.ssl, false) AS "tls",
              current_setting('ssl') = 'on' AS "serverTlsEnabled",
              current_setting('ssl_cert_file') <> ''
                AS "serverCertificateConfigured",
              current_setting('ssl_key_file') <> '' AS "serverKeyConfigured",
              EXISTS (
                SELECT 1
                FROM service_instance_identity
                WHERE singleton = true
              ) AS "databaseIdentityPresent"
            FROM pg_roles AS role
            LEFT JOIN pg_stat_ssl AS ssl ON ssl.pid = pg_backend_pid()
            WHERE role.rolname = session_user
        `);
        if (result.rows.length !== 1) return undefined;
        return result.rows[0];
    } finally {
        await pool.end().catch(() => undefined);
    }
}

let current;
try {
    current = await inspect(source.toString());
} catch {
    process.exit(1);
}
if (!current) process.exit(1);

let pinnedTlsConnectionAvailable = false;
let pinnedTlsFailureReason = "none";
try {
    const pinnedResult = await inspect(pinned.toString());
    pinnedTlsConnectionAvailable = pinnedResult?.tls === true;
    if (!pinnedTlsConnectionAvailable) pinnedTlsFailureReason = "session_not_tls";
} catch (error) {
    pinnedTlsConnectionAvailable = false;
    pinnedTlsFailureReason = classifyTlsFailure(error);
}

let tlsWithoutCertificateVerificationAvailable = false;
let tlsWithoutCertificateVerificationFailureReason = "none";
try {
    const requiredResult = await inspect(tlsRequired.toString());
    tlsWithoutCertificateVerificationAvailable = requiredResult?.tls === true;
    if (!tlsWithoutCertificateVerificationAvailable) {
        tlsWithoutCertificateVerificationFailureReason = "session_not_tls";
    }
} catch (error) {
    tlsWithoutCertificateVerificationAvailable = false;
    tlsWithoutCertificateVerificationFailureReason =
        classifyTlsFailure(error);
}

let directWithoutTls;
try {
    const directUrl = new URL(source);
    directUrl.username = current.currentUser;
    directUrl.searchParams.delete("options");
    directUrl.searchParams.set("uselibpqcompat", "true");
    directUrl.searchParams.set("sslmode", "disable");
    directUrl.searchParams.delete("ssl");
    directUrl.searchParams.delete("sslcert");
    directUrl.searchParams.delete("sslkey");
    directUrl.searchParams.delete("sslrootcert");
    directWithoutTls = await inspect(directUrl.toString());
} catch {
    directWithoutTls = undefined;
}
const directEffectiveRoleLoginWithoutTlsAvailable =
    directWithoutTls !== undefined &&
    directWithoutTls.currentUser === current.currentUser &&
    directWithoutTls.sessionUser === current.currentUser &&
    directWithoutTls.tls === false;

let direct;
try {
    const directUrl = new URL(pinned);
    directUrl.username = current.currentUser;
    directUrl.searchParams.delete("options");
    direct = await inspect(directUrl.toString());
} catch {
    direct = undefined;
}
const directEffectiveRoleLoginAvailable =
    direct !== undefined &&
    direct.currentUser === current.currentUser &&
    direct.sessionUser === current.currentUser;
const directEffectiveRoleBoundaryVerified =
    directEffectiveRoleLoginAvailable &&
    direct.tls === true &&
    direct.superuser === false &&
    direct.administrativePrivilegesPresent === false &&
    direct.otherDatabaseAccessPresent === false &&
    direct.roleMembershipPresent === false &&
    direct.databaseIdentityPresent === true;

process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    event: "production_database_boundary_inspected",
    status: "succeeded",
    currentConnection: {
        tls: current.tls,
        roleSwitchingPresent: current.currentUser !== current.sessionUser,
        superuser: current.superuser,
        administrativePrivilegesPresent: current.administrativePrivilegesPresent,
        otherDatabaseAccessPresent: current.otherDatabaseAccessPresent,
        roleMembershipPresent: current.roleMembershipPresent,
    },
    pinnedTlsConnectionAvailable,
    pinnedTlsFailureReason,
    tlsWithoutCertificateVerificationAvailable,
    tlsWithoutCertificateVerificationFailureReason,
    directEffectiveRoleLoginAvailable,
    directEffectiveRoleLoginWithoutTlsAvailable,
    directEffectiveRoleBoundaryVerified,
    serverTlsEnabled: current.serverTlsEnabled,
    serverCertificateConfigured: current.serverCertificateConfigured,
    serverKeyConfigured: current.serverKeyConfigured,
}));
NODE
then
    inspection_failure "database_boundary_connection_failed"
fi
if [ "$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" != "$candidate_image_id" ]; then
    inspection_failure "candidate_image_changed"
fi

if ! jq -e '
    .schemaVersion == 1 and
    .event == "production_database_boundary_inspected" and
    .status == "succeeded" and
    (.currentConnection.tls | type == "boolean") and
    (.currentConnection.roleSwitchingPresent | type == "boolean") and
    (.currentConnection.superuser | type == "boolean") and
    (.currentConnection.administrativePrivilegesPresent | type == "boolean") and
    (.currentConnection.otherDatabaseAccessPresent | type == "boolean") and
    (.currentConnection.roleMembershipPresent | type == "boolean") and
    (.currentConnection | keys | sort) == [
      "administrativePrivilegesPresent",
      "otherDatabaseAccessPresent",
      "roleMembershipPresent",
      "roleSwitchingPresent",
      "superuser",
      "tls"
    ] and
    (.pinnedTlsConnectionAvailable | type == "boolean") and
    (.pinnedTlsFailureReason as $reason | [
      "none",
      "authentication_failed",
      "certificate_verification_failed",
      "server_tls_unavailable",
      "session_not_tls",
      "transport_failure",
      "unexpected_failure"
    ] | index($reason) != null) and
    (.pinnedTlsConnectionAvailable == (.pinnedTlsFailureReason == "none")) and
    (.tlsWithoutCertificateVerificationAvailable | type == "boolean") and
    (.tlsWithoutCertificateVerificationFailureReason as $reason | [
      "none",
      "authentication_failed",
      "certificate_verification_failed",
      "server_tls_unavailable",
      "session_not_tls",
      "transport_failure",
      "unexpected_failure"
    ] | index($reason) != null) and
    (.tlsWithoutCertificateVerificationAvailable == (.tlsWithoutCertificateVerificationFailureReason == "none")) and
    (.directEffectiveRoleLoginAvailable | type == "boolean") and
    (.directEffectiveRoleLoginWithoutTlsAvailable | type == "boolean") and
    (.directEffectiveRoleBoundaryVerified | type == "boolean") and
    (.serverTlsEnabled | type == "boolean") and
    (.serverCertificateConfigured | type == "boolean") and
    (.serverKeyConfigured | type == "boolean") and
    (keys | sort) == [
      "currentConnection",
      "directEffectiveRoleBoundaryVerified",
      "directEffectiveRoleLoginAvailable",
      "directEffectiveRoleLoginWithoutTlsAvailable",
      "event",
      "pinnedTlsConnectionAvailable",
      "pinnedTlsFailureReason",
      "schemaVersion",
      "serverCertificateConfigured",
      "serverKeyConfigured",
      "serverTlsEnabled",
      "status",
      "tlsWithoutCertificateVerificationAvailable",
      "tlsWithoutCertificateVerificationFailureReason"
    ]
' "$result" >/dev/null 2>&1; then
    inspection_failure "database_boundary_result_invalid"
fi

jq \
    --arg activeRevision "$active_revision" \
    --arg candidateRevision "$candidate_revision" \
    '. + {
      activeRevision: $activeRevision,
      candidateRevision: $candidateRevision
    }' "$result"
