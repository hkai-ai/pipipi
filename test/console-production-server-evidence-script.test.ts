import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REVISION = "7".repeat(40);

describe("Console production server evidence script", () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            temporaryDirectories
                .splice(0)
                .map((directory) =>
                    rm(directory, { recursive: true, force: true }),
                ),
        );
    });

    it("reports missing database configuration without leaking environment content", async () => {
        const fixture = await createFixture({
            activeDatabaseUrl: false,
            auditFailure: "DATABASE_URL is required",
            sharedDatabaseUrl: false,
        });

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            event: "console_server_readiness_failed",
            revision: REVISION,
            status: "failed",
            failureGate: "database_audit",
            databaseAuditFailure: "database_url_required",
            prerequisites: {
                activeDatabaseUrlConfigured: false,
                sharedDatabaseUrlConfigured: false,
                databaseCaPresent: false,
                backupEvidencePresent: false,
            },
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stdout).not.toContain("postgres://");
        expect(result.stderr).not.toContain("DATABASE_URL is required");
    });

    it("treats an active whitespace-only database URL as missing", async () => {
        const fixture = await createFixture({
            activeDatabaseUrl: "whitespace",
            auditFailure: "DATABASE_URL is required",
            sharedDatabaseUrl: false,
        });

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            databaseAuditFailure: "database_url_required",
            prerequisites: {
                activeDatabaseUrlConfigured: false,
            },
        });
    });

    it("classifies SET ROLE and only exposes configuration presence", async () => {
        const fixture = await createFixture({
            activeDatabaseUrl: true,
            auditFailure: "Production database session must not switch roles",
            sharedDatabaseUrl: true,
            withBackup: true,
            withCertificate: true,
        });

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureGate: "database_audit",
            databaseAuditFailure: "role_switching_present",
            prerequisites: {
                activeDatabaseUrlConfigured: true,
                sharedDatabaseUrlConfigured: true,
                databaseCaPresent: true,
                backupEvidencePresent: true,
            },
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stdout).not.toContain("postgres://");
        expect(result.stderr).not.toContain(
            "Production database session must not switch roles",
        );
    });

    it("redacts unclassified connection errors", async () => {
        const fixture = await createFixture({
            activeDatabaseUrl: true,
            auditFailure:
                "connect ECONNREFUSED postgres://fixture-secret@database.internal",
            sharedDatabaseUrl: true,
            withCertificate: true,
        });

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureGate: "database_audit",
            databaseAuditFailure: "connection_or_unclassified_failure",
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stdout).not.toContain("database.internal");
        expect(result.stderr).toBe("");
    });

    it("classifies a successful command with an invalid audit contract", async () => {
        const fixture = await createFixture({
            activeDatabaseUrl: true,
            invalidAudit: true,
            sharedDatabaseUrl: true,
            withCertificate: true,
        });

        const result = runAudit(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            failureGate: "database_audit",
            databaseAuditFailure: "invalid_audit_result",
        });
    });

    it("preserves the successful database and backup evidence contract", async () => {
        const fixture = await createFixture({
            activeDatabaseUrl: true,
            sharedDatabaseUrl: true,
            successfulAudit: true,
            withBackup: true,
            withCertificate: true,
        });

        const result = runAudit(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            revision: REVISION,
            database: {
                event: "production_database_identity_verified",
                databaseIdentitySha256: "d".repeat(64),
                tlsVerified: true,
                dedicatedDatabaseVerified: true,
                nonSuperuserVerified: true,
                administrativePrivilegesAbsent: true,
                otherDatabaseAccessAbsent: true,
                roleMembershipAbsent: true,
                roleSwitchingAbsent: true,
            },
            backup: {
                databaseIdentitySha256: "d".repeat(64),
                backupId: "backup:fixture",
            },
            runtime: { asyncShape: false },
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stdout).not.toContain("postgres://");
    });

    async function createFixture(
        options: Readonly<{
            activeDatabaseUrl: boolean | "whitespace";
            auditFailure?: string;
            invalidAudit?: boolean;
            sharedDatabaseUrl: boolean;
            successfulAudit?: boolean;
            withBackup?: boolean;
            withCertificate?: boolean;
        }>,
    ): Promise<Fixture> {
        const directory = await mkdtemp(
            path.join(tmpdir(), "pipipi-console-readiness-"),
        );
        temporaryDirectories.push(directory);
        const appRoot = path.join(directory, "app");
        const shared = path.join(appRoot, "shared");
        const binaries = path.join(directory, "bin");
        await Promise.all([
            mkdir(shared, { recursive: true }),
            mkdir(binaries),
        ]);
        await writeFile(
            path.join(shared, ".env"),
            options.sharedDatabaseUrl
                ? "DATABASE_URL=postgres://fixture-secret\nOTHER=fixture-secret\n"
                : "OTHER=fixture-secret\n",
        );
        if (options.withCertificate) {
            await writeFile(path.join(shared, "pg-server.crt"), "fixture\n");
        }
        if (options.withBackup) {
            const now = Date.now();
            await mkdir(path.join(shared, "postgres-backup"));
            await writeFile(
                path.join(shared, "postgres-backup", "evidence.json"),
                JSON.stringify({
                    schemaVersion: 1,
                    event: "postgres_backup_verified",
                    status: "succeeded",
                    databaseIdentitySha256: "d".repeat(64),
                    backupId: "backup:fixture",
                    completedAt: new Date(now - 60_000)
                        .toISOString()
                        .replace(/\.\d{3}Z$/, "Z"),
                    restoreVerifiedAt: new Date(now - 120_000)
                        .toISOString()
                        .replace(/\.\d{3}Z$/, "Z"),
                    retentionUntil: new Date(now + 31 * 86_400_000)
                        .toISOString()
                        .replace(/\.\d{3}Z$/, "Z"),
                    signatureSha256: "e".repeat(64),
                }),
            );
        }
        const docker = path.join(binaries, "docker");
        await writeFile(docker, fakeDocker);
        await chmod(docker, 0o755);
        return {
            activeDatabaseUrl: options.activeDatabaseUrl,
            appRoot,
            auditFailure: options.auditFailure ?? "",
            binaries,
            invalidAudit: options.invalidAudit ?? false,
            successfulAudit: options.successfulAudit ?? false,
        };
    }
});

type Fixture = Readonly<{
    activeDatabaseUrl: boolean | "whitespace";
    appRoot: string;
    auditFailure: string;
    binaries: string;
    invalidAudit: boolean;
    successfulAudit: boolean;
}>;

function runAudit(fixture: Fixture) {
    return spawnSync(
        "bash",
        [
            "ops/collect-console-production-server-evidence.sh",
            fixture.appRoot,
            REVISION,
        ],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${fixture.binaries}:${process.env.PATH}`,
                FAKE_ACTIVE_DATABASE_URL:
                    fixture.activeDatabaseUrl === true
                        ? "value"
                        : fixture.activeDatabaseUrl === "whitespace"
                          ? "whitespace"
                          : "none",
                FAKE_AUDIT_FAILURE: fixture.auditFailure,
                FAKE_INVALID_AUDIT: fixture.invalidAudit ? "true" : "false",
                FAKE_REVISION: REVISION,
                FAKE_SUCCESSFUL_AUDIT: fixture.successfulAudit
                    ? "true"
                    : "false",
            },
        },
    );
}

const fakeDocker = String.raw`#!/usr/bin/env bash
set -eu
if [ "$1" = "inspect" ]; then
    if [[ " $* " == *"com.pipipi.revision"* ]]; then
        printf '%s\n' "$FAKE_REVISION"
    elif [[ " $* " == *"range .Config.Env"* ]]; then
        if [ "$FAKE_ACTIVE_DATABASE_URL" = "value" ]; then
            printf '%s\n' 'DATABASE_URL=postgres://fixture-secret'
        elif [ "$FAKE_ACTIVE_DATABASE_URL" = "whitespace" ]; then
            printf '%s\n' 'DATABASE_URL=   '
        fi
    fi
    exit 0
fi
if [ "$1" = "exec" ]; then
    if [ "$FAKE_INVALID_AUDIT" = "true" ]; then
        printf '%s\n' '{"event":"unexpected"}'
        exit 0
    fi
    if [ "$FAKE_SUCCESSFUL_AUDIT" = "true" ]; then
        printf '%s\n' '{"event":"production_database_identity_verified","databaseIdentitySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","tlsVerified":true,"dedicatedDatabaseVerified":true,"nonSuperuserVerified":true,"administrativePrivilegesAbsent":true,"otherDatabaseAccessAbsent":true,"roleMembershipAbsent":true,"roleSwitchingAbsent":true}'
        exit 0
    fi
    printf '%s\n' "$FAKE_AUDIT_FAILURE" >&2
    exit 17
fi
exit 2
`;
