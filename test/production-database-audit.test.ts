import { describe, expect, it } from "vitest";
import {
    auditProductionDatabase,
    parseProductionDatabaseAuditConnection,
} from "../src/release/production-database-audit.js";

describe("Production database audit", () => {
    it("requires the fixed production CA contract before connecting", () => {
        const connection =
            "postgresql://pipipi:secret@database.internal/pipipi?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=%2Fetc%2Fpipipi%2Fpg-server.crt";

        expect(parseProductionDatabaseAuditConnection(connection)).toBe(
            connection,
        );
        for (const invalid of [
            "postgresql://pipipi:secret@database.internal/pipipi?uselibpqcompat=true&sslmode=require&sslrootcert=%2Fetc%2Fpipipi%2Fpg-server.crt",
            "postgresql://pipipi:secret@database.internal/pipipi?uselibpqcompat=true&sslmode=verify-ca",
            "postgresql://pipipi:secret@database.internal/pipipi?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=%2Fetc%2Fpipipi%2Fpg-server.crt&options=-c%20role%3Dpostgres",
        ]) {
            expect(() =>
                parseProductionDatabaseAuditConnection(invalid),
            ).toThrow("Production database connection must use the fixed CA");
        }
    });

    it("accepts an encrypted dedicated database session without role switching", async () => {
        const result = await auditProductionDatabase(
            database({
                database: "pipipi",
                instanceIdentity: "019ffb23-9a95-7d12-844d-941a3c940c97",
                currentUser: "pipipi_app",
                sessionUser: "pipipi_app",
                superuser: false,
                createRole: false,
                createDatabase: false,
                replication: false,
                bypassRowLevelSecurity: false,
                canLogin: true,
                otherDatabaseAccessAbsent: true,
                roleMembershipAbsent: true,
                tls: true,
            }),
        );

        expect(result).toEqual({
            event: "production_database_identity_verified",
            databaseIdentitySha256:
                "61c68676097dfad5aff569a58992572d70576fe120369421962603a394e1aa56",
            tlsVerified: true,
            dedicatedDatabaseVerified: true,
            nonSuperuserVerified: true,
            administrativePrivilegesAbsent: true,
            otherDatabaseAccessAbsent: true,
            roleMembershipAbsent: true,
            roleSwitchingAbsent: true,
        });
    });

    it.each([
        [
            "an unencrypted session",
            { tls: false },
            "Production database session must use TLS",
        ],
        [
            "a superuser session",
            { superuser: true },
            "Production database session must use a non-superuser role",
        ],
        [
            "an administrative login role",
            { createRole: true },
            "Production database role must not have administrative privileges",
        ],
        [
            "a role that can access another application database",
            { otherDatabaseAccessAbsent: false },
            "Production database role must not access other databases",
        ],
        [
            "SET ROLE privilege indirection",
            { sessionUser: "postgres" },
            "Production database session must not switch roles",
        ],
        [
            "membership in another role",
            { roleMembershipAbsent: false },
            "Production database role must not inherit or switch to another role",
        ],
        [
            "the PostgreSQL maintenance database",
            { database: "postgres" },
            "Production database must be application-dedicated",
        ],
    ])("rejects %s", async (_label, override, message) => {
        await expect(
            auditProductionDatabase(
                database({
                    database: "pipipi",
                    instanceIdentity: "019ffb23-9a95-7d12-844d-941a3c940c97",
                    currentUser: "pipipi_app",
                    sessionUser: "pipipi_app",
                    superuser: false,
                    createRole: false,
                    createDatabase: false,
                    replication: false,
                    bypassRowLevelSecurity: false,
                    canLogin: true,
                    otherDatabaseAccessAbsent: true,
                    roleMembershipAbsent: true,
                    tls: true,
                    ...override,
                }),
            ),
        ).rejects.toThrow(message);
    });

    it("fails closed on an invalid response without exposing database identity", async () => {
        const source = database({
            database: "sensitive-database-name",
            instanceIdentity: "019ffb23-9a95-7d12-844d-941a3c940c97",
            currentUser: "sensitive-role-name",
            sessionUser: "sensitive-role-name",
            superuser: "false",
            createRole: false,
            createDatabase: false,
            replication: false,
            bypassRowLevelSecurity: false,
            canLogin: true,
            otherDatabaseAccessAbsent: true,
            roleMembershipAbsent: true,
            tls: true,
        });

        let error: unknown;
        try {
            await auditProductionDatabase(source);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
            "Production database identity audit returned an invalid result",
        );
        expect((error as Error).message).not.toContain("sensitive");
    });
});

function database(row: Record<string, unknown>) {
    return {
        query: async () => ({ rows: [row] }),
    };
}
