import { spawn, spawnSync } from "node:child_process";
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ACTIVE_REVISION = "7".repeat(40);
const CANDIDATE_REVISION = "e".repeat(40);

describe("Production database boundary inspection", () => {
    const directories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            directories
                .splice(0)
                .map((directory) =>
                    rm(directory, { recursive: true, force: true }),
                ),
        );
    });

    it("exposes only a protected read-only manual workflow", async () => {
        const [workflow, script] = await Promise.all([
            readFile(
                ".github/workflows/production-database-boundary-inspection.yml",
                "utf8",
            ),
            readFile("ops/inspect-production-database-boundary.sh", "utf8"),
        ]);

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request|schedule):/);
        expect(workflow).toContain("name: production-database-inspection");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain("ops/validate-production-ssh-target.sh");
        expect(workflow).toContain(
            "< ops/inspect-production-database-boundary.sh",
        );
        expect(workflow).toMatch(/if: \$\{\{ always\(\) \}\}/);
        expect(workflow).not.toContain("DATABASE_URL:");
        expect(script).toContain("pg_stat_ssl");
        expect(script).toContain("--network host");
        expect(script).toContain(
            'cmp -s "$database_env" "$active_database_env"',
        );
        expect(script).toContain('--env-file "$database_env"');
        expect(script).not.toContain('--env-file "$shared_env"');
        expect(script).toContain('sslmode", "verify-ca"');
        expect(script).toContain("directEffectiveRoleBoundaryVerified");
        expect(script).toContain("trap 'on_signal 129' HUP");
        expect(script).toContain("trap 'on_signal 130' INT");
        expect(script).toContain("trap 'on_signal 143' TERM");
        expect(script).toContain('node "$candidate_image_id"');
        expect(script).not.toMatch(/\b(ALTER|CREATE|DROP|GRANT|REVOKE)\b/);
        expect(script).not.toContain("docker compose");
    });

    it("rejects an SSH path that could be reinterpreted remotely", () => {
        const result = spawnSync(
            "bash",
            [
                "ops/validate-production-ssh-target.sh",
                "47.84.178.254",
                "root",
                "/opt/pipipi;touch injected",
            ],
            { cwd: process.cwd(), encoding: "utf8" },
        );

        expect(result.status).toBe(64);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
    });

    it("returns only redacted live-boundary facts", async () => {
        const fixture = await createFixture();

        const result = runInspection(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            schemaVersion: 1,
            event: "production_database_boundary_inspected",
            status: "succeeded",
            activeRevision: ACTIVE_REVISION,
            candidateRevision: CANDIDATE_REVISION,
            currentConnection: {
                tls: false,
                roleSwitchingPresent: true,
                superuser: true,
                administrativePrivilegesPresent: true,
                otherDatabaseAccessPresent: true,
                roleMembershipPresent: false,
            },
            pinnedTlsConnectionAvailable: true,
            directEffectiveRoleLoginAvailable: false,
            directEffectiveRoleBoundaryVerified: false,
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stdout).not.toContain("postgres://");
        expect(result.stderr).toBe("");
    });

    it("fails closed on an invalid collector response", async () => {
        const fixture = await createFixture({ invalidResult: true });

        const result = runInspection(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            event: "production_database_boundary_inspected",
            status: "inspection_failed",
            failureReason: "database_boundary_result_invalid",
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stderr).toBe("");
    });

    it("rejects a nested field that could carry a database secret", async () => {
        const fixture = await createFixture({ nestedSecret: true });

        const result = runInspection(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "database_boundary_result_invalid",
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stderr).toBe("");
    });

    it("fails closed if the candidate tag is changed during inspection", async () => {
        const fixture = await createFixture({ retagCandidate: true });

        const result = runInspection(fixture);

        expect(result.status).not.toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "inspection_failed",
            failureReason: "candidate_image_changed",
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stderr).toBe("");
    });

    it("removes database credential files when the SSH command is terminated", async () => {
        const fixture = await createFixture({ waitForSignal: true });
        const temporary = path.join(fixture.root, "tmp");
        await mkdir(temporary);
        const child = spawn(
            "bash",
            [
                "ops/inspect-production-database-boundary.sh",
                fixture.appRoot,
                ACTIVE_REVISION,
                CANDIDATE_REVISION,
            ],
            {
                cwd: process.cwd(),
                detached: true,
                env: {
                    ...process.env,
                    FAKE_ACTIVE_REVISION: ACTIVE_REVISION,
                    FAKE_IMAGE_INSPECT_COUNT: fixture.imageInspectCount,
                    FAKE_INVALID_RESULT: "false",
                    FAKE_NESTED_SECRET: "false",
                    FAKE_RETAG_CANDIDATE: "false",
                    FAKE_SIGNAL_READY: fixture.signalReady,
                    FAKE_WAIT_FOR_SIGNAL: "true",
                    PATH: `${fixture.binaries}:${process.env.PATH ?? ""}`,
                    TMPDIR: temporary,
                },
                stdio: "ignore",
            },
        );
        await waitForFile(fixture.signalReady);
        if (child.pid === undefined)
            throw new Error("Missing child process ID");

        process.kill(-child.pid, "SIGTERM");
        await new Promise<void>((resolve) =>
            child.once("close", () => resolve()),
        );

        expect(await readdir(temporary)).toEqual([]);
    });

    async function createFixture(
        options: Readonly<{
            invalidResult?: boolean;
            nestedSecret?: boolean;
            retagCandidate?: boolean;
            waitForSignal?: boolean;
        }> = {},
    ) {
        const root = await mkdtemp(
            path.join(tmpdir(), "pipipi-database-boundary-"),
        );
        directories.push(root);
        const appRoot = path.join(root, "app");
        const shared = path.join(appRoot, "shared");
        const binaries = path.join(root, "bin");
        await Promise.all([
            mkdir(shared, { recursive: true }),
            mkdir(binaries),
        ]);
        await writeFile(
            path.join(shared, ".env"),
            "DATABASE_URL=postgres://fixture-secret\n",
        );
        await writeFile(path.join(shared, "pg-server.crt"), "fixture\n");
        const docker = path.join(binaries, "docker");
        const imageInspectCount = path.join(root, "image-inspect-count");
        const signalReady = path.join(root, "signal-ready");
        await writeFile(
            docker,
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = inspect ]; then
    if [[ " $* " == *"com.pipipi.revision"* ]]; then
        if [ "$FAKE_WAIT_FOR_SIGNAL" = true ]; then
            : > "$FAKE_SIGNAL_READY"
            exec sleep 30
        fi
        printf '%s\n' "$FAKE_ACTIVE_REVISION"
    elif [[ " $* " == *"range .Config.Env"* ]]; then
        printf '%s\n' 'DATABASE_URL=postgres://fixture-secret'
    fi
    exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
    count=0
    if [ -f "$FAKE_IMAGE_INSPECT_COUNT" ]; then count="$(< "$FAKE_IMAGE_INSPECT_COUNT")"; fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$FAKE_IMAGE_INSPECT_COUNT"
    if [ "$FAKE_RETAG_CANDIDATE" = true ] && [ "$count" -gt 1 ]; then
        printf 'sha256:%064d\n' 2
    else
        printf 'sha256:%064d\n' 1
    fi
    exit 0
fi
if [ "$1" = run ]; then
    if [ "$FAKE_INVALID_RESULT" = true ]; then
        printf '%s\n' '{"databaseUrl":"postgres://fixture-secret"}'
    elif [ "$FAKE_NESTED_SECRET" = true ]; then
        printf '%s\n' '{"schemaVersion":1,"event":"production_database_boundary_inspected","status":"succeeded","currentConnection":{"tls":false,"roleSwitchingPresent":true,"superuser":true,"administrativePrivilegesPresent":true,"otherDatabaseAccessPresent":true,"roleMembershipPresent":false,"databaseUrl":"postgres://fixture-secret"},"pinnedTlsConnectionAvailable":true,"directEffectiveRoleLoginAvailable":false,"directEffectiveRoleBoundaryVerified":false}'
    else
        printf '%s\n' '{"schemaVersion":1,"event":"production_database_boundary_inspected","status":"succeeded","currentConnection":{"tls":false,"roleSwitchingPresent":true,"superuser":true,"administrativePrivilegesPresent":true,"otherDatabaseAccessPresent":true,"roleMembershipPresent":false},"pinnedTlsConnectionAvailable":true,"directEffectiveRoleLoginAvailable":false,"directEffectiveRoleBoundaryVerified":false}'
    fi
    exit 0
fi
exit 2
`,
        );
        await chmod(docker, 0o755);
        return {
            appRoot,
            binaries,
            imageInspectCount,
            invalidResult: options.invalidResult ?? false,
            nestedSecret: options.nestedSecret ?? false,
            retagCandidate: options.retagCandidate ?? false,
            root,
            signalReady,
            waitForSignal: options.waitForSignal ?? false,
        };
    }
});

function runInspection(
    fixture: Readonly<{
        appRoot: string;
        binaries: string;
        imageInspectCount: string;
        invalidResult: boolean;
        nestedSecret: boolean;
        retagCandidate: boolean;
        root: string;
        signalReady: string;
        waitForSignal: boolean;
    }>,
) {
    return spawnSync(
        "bash",
        [
            "ops/inspect-production-database-boundary.sh",
            fixture.appRoot,
            ACTIVE_REVISION,
            CANDIDATE_REVISION,
        ],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
                ...process.env,
                FAKE_ACTIVE_REVISION: ACTIVE_REVISION,
                FAKE_IMAGE_INSPECT_COUNT: fixture.imageInspectCount,
                FAKE_INVALID_RESULT: String(fixture.invalidResult),
                FAKE_NESTED_SECRET: String(fixture.nestedSecret),
                FAKE_RETAG_CANDIDATE: String(fixture.retagCandidate),
                FAKE_SIGNAL_READY: fixture.signalReady,
                FAKE_WAIT_FOR_SIGNAL: String(fixture.waitForSignal),
                PATH: `${fixture.binaries}:${process.env.PATH ?? ""}`,
            },
        },
    );
}

async function waitForFile(file: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            await access(file);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    throw new Error("Timed out waiting for signal fixture");
}
