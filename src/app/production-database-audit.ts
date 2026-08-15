import { createHash } from "node:crypto";

export type ProductionDatabaseAuditSource = Readonly<{
    query: (text: string) => Promise<Readonly<{ rows: readonly unknown[] }>>;
}>;

export type ProductionDatabaseAudit = Readonly<{
    event: "production_database_identity_verified";
    databaseIdentitySha256: string;
    tlsVerified: true;
    dedicatedDatabaseVerified: true;
    nonSuperuserVerified: true;
    administrativePrivilegesAbsent: true;
    otherDatabaseAccessAbsent: true;
    roleMembershipAbsent: true;
    roleSwitchingAbsent: true;
}>;

const fixedCaConnectionError =
    "Production database connection must use the fixed CA";

export function parseProductionDatabaseAuditConnection(
    value: string | undefined,
): string {
    const candidate = value?.trim();
    if (!candidate) throw new Error(fixedCaConnectionError);
    try {
        const url = new URL(candidate);
        const allowedParameters = new Set([
            "uselibpqcompat",
            "sslmode",
            "sslrootcert",
        ]);
        const exactly = (key: string, expected: string): boolean => {
            const values = url.searchParams.getAll(key);
            return values.length === 1 && values[0] === expected;
        };
        const database = decodeURIComponent(url.pathname.slice(1));
        if (
            !["postgres:", "postgresql:"].includes(url.protocol) ||
            !url.username ||
            !url.password ||
            !url.hostname ||
            !database ||
            database.includes("/") ||
            [...url.searchParams.keys()].some(
                (key) => !allowedParameters.has(key),
            ) ||
            !exactly("uselibpqcompat", "true") ||
            !exactly("sslmode", "verify-ca") ||
            !exactly("sslrootcert", "/etc/pipipi/pg-server.crt")
        ) {
            throw new Error();
        }
    } catch {
        throw new Error(fixedCaConnectionError);
    }
    return candidate;
}

/**
 * Verifies the effective production database security boundary over the live
 * connection. URL inspection cannot prove that a named role is not a
 * superuser, or detect a privileged session that used SET ROLE.
 */
export async function auditProductionDatabase(
    source: ProductionDatabaseAuditSource,
): Promise<ProductionDatabaseAudit> {
    const result = await source.query(`
        SELECT
          current_database() AS "database",
          identity.identity::text AS "instanceIdentity",
          current_user AS "currentUser",
          session_user AS "sessionUser",
          role.rolsuper AS "superuser",
          role.rolcreaterole AS "createRole",
          role.rolcreatedb AS "createDatabase",
          role.rolreplication AS "replication",
          role.rolbypassrls AS "bypassRowLevelSecurity",
          role.rolcanlogin AS "canLogin",
          NOT EXISTS (
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
          ) AS "otherDatabaseAccessAbsent",
          NOT EXISTS (
            SELECT 1
            FROM pg_roles AS member_role
            WHERE member_role.rolname <> session_user
              AND pg_has_role(session_user, member_role.oid, 'MEMBER')
          ) AS "roleMembershipAbsent",
          COALESCE(ssl.ssl, false) AS "tls"
        FROM pg_roles AS role
        CROSS JOIN service_instance_identity AS identity
        LEFT JOIN pg_stat_ssl AS ssl ON ssl.pid = pg_backend_pid()
        WHERE role.rolname = session_user
          AND identity.singleton = true
    `);
    const row = result.rows[0];
    if (!auditRow(row) || result.rows.length !== 1) {
        throw new Error(
            "Production database identity audit returned an invalid result",
        );
    }
    if (!row.tls) {
        throw new Error("Production database session must use TLS");
    }
    if (["postgres", "template0", "template1"].includes(row.database)) {
        throw new Error("Production database must be application-dedicated");
    }
    if (row.superuser) {
        throw new Error(
            "Production database session must use a non-superuser role",
        );
    }
    if (
        row.createRole ||
        row.createDatabase ||
        row.replication ||
        row.bypassRowLevelSecurity ||
        !row.canLogin
    ) {
        throw new Error(
            "Production database role must not have administrative privileges",
        );
    }
    if (!row.otherDatabaseAccessAbsent) {
        throw new Error(
            "Production database role must not access other databases",
        );
    }
    if (row.currentUser !== row.sessionUser) {
        throw new Error("Production database session must not switch roles");
    }
    if (!row.roleMembershipAbsent) {
        throw new Error(
            "Production database role must not inherit or switch to another role",
        );
    }

    return Object.freeze({
        event: "production_database_identity_verified",
        databaseIdentitySha256: createHash("sha256")
            .update(row.database)
            .update("\0")
            .update(row.currentUser)
            .update("\0")
            .update(row.instanceIdentity)
            .digest("hex"),
        tlsVerified: true,
        dedicatedDatabaseVerified: true,
        nonSuperuserVerified: true,
        administrativePrivilegesAbsent: true,
        otherDatabaseAccessAbsent: true,
        roleMembershipAbsent: true,
        roleSwitchingAbsent: true,
    });
}

function auditRow(value: unknown): value is Readonly<{
    database: string;
    instanceIdentity: string;
    currentUser: string;
    sessionUser: string;
    superuser: boolean;
    createRole: boolean;
    createDatabase: boolean;
    replication: boolean;
    bypassRowLevelSecurity: boolean;
    canLogin: boolean;
    otherDatabaseAccessAbsent: boolean;
    roleMembershipAbsent: boolean;
    tls: boolean;
}> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const row = value as Record<string, unknown>;
    return (
        typeof row.database === "string" &&
        row.database.length > 0 &&
        typeof row.instanceIdentity === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            row.instanceIdentity,
        ) &&
        typeof row.currentUser === "string" &&
        row.currentUser.length > 0 &&
        typeof row.sessionUser === "string" &&
        row.sessionUser.length > 0 &&
        typeof row.superuser === "boolean" &&
        typeof row.createRole === "boolean" &&
        typeof row.createDatabase === "boolean" &&
        typeof row.replication === "boolean" &&
        typeof row.bypassRowLevelSecurity === "boolean" &&
        typeof row.canLogin === "boolean" &&
        typeof row.otherDatabaseAccessAbsent === "boolean" &&
        typeof row.roleMembershipAbsent === "boolean" &&
        typeof row.tls === "boolean"
    );
}
