import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ACTIVE_REVISION = "7".repeat(40);
const CANDIDATE_REVISION = "e".repeat(40);
const DATABASE_URL =
    "postgresql://async-user:database-secret@database.invalid/pipipi?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=%2Fetc%2Fpipipi%2Fpg-server.crt";
const REDIS_URL = "rediss://async-user:redis-secret@redis.invalid/0";
const ORIGINAL_DATABASE_URL =
    "postgresql://legacy-superuser:legacy-secret@database.invalid/pipipi?sslmode=require";
const ROLE_FILES = [
    "async-api.env",
    "process-dispatcher.env",
    "process-worker.env",
    "webhook-worker.env",
    "retention-cleaner.env",
] as const;

describe("Async production environment provisioning", () => {
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

    it("uses a protected manual workflow and keeps secrets out of remote argv", () => {
        const workflow = readFileSync(
            ".github/workflows/async-production-environment-provisioning.yml",
            "utf8",
        );

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).toContain("name: async-internal");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain(
            "ASYNC_DATABASE_URL: $" + "{{ secrets.ASYNC_DATABASE_URL }}",
        );
        expect(workflow).toContain(
            "ASYNC_REDIS_URL: $" + "{{ secrets.ASYNC_REDIS_URL }}",
        );
        expect(workflow).toContain("printf '%s\\0'");
        expect(workflow).not.toMatch(
            /ssh[^\n]*(ASYNC_DATABASE_URL|ASYNC_REDIS_URL)/,
        );
        expect(workflow).not.toMatch(
            /scp[^\n]*(ASYNC_DATABASE_URL|ASYNC_REDIS_URL)/,
        );
        expect(workflow).toContain("type: choice");
        expect(workflow).toContain("- plan");
        expect(workflow).toContain("- apply");
        expect(workflow.indexOf("cleanup_remote=true")).toBeLessThan(
            workflow.indexOf("scp -q"),
        );
        expect(workflow).toContain(
            "ops/finalize-async-production-environment-evidence.sh",
        );
        expect(workflow).toContain("trap finalize EXIT");
        expect(workflow).toContain("- name: Finalize missing evidence");
        expect(workflow).toContain("if: $" + "{{ always() }}");
    });

    it("emits a redacted failure result before validated arguments exist", () => {
        const result = spawnSync(
            "bash",
            ["ops/provision-async-production-environments.sh"],
            { cwd: process.cwd(), encoding: "utf8" },
        );

        expect(result.status).toBe(64);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            activeRevision: null,
            candidateRevision: null,
            failureReason: "invalid_request",
        });
        expect(result.stderr).toBe("");
    });

    it.each([
        ["succeeded", 7, 7],
        ["failed", 0, 1],
    ] as const)(
        "replaces %s evidence when the execution exit code is %i",
        async (evidenceStatus, executionExitCode, expectedExitCode) => {
            const root = await mkdtemp(
                path.join(tmpdir(), "pipipi-async-evidence-"),
            );
            directories.push(root);
            const evidence = path.join(root, "evidence.json");
            await writeFile(
                evidence,
                JSON.stringify(environmentEvidence(evidenceStatus)),
            );

            const result = spawnSync(
                "bash",
                [
                    "ops/finalize-async-production-environment-evidence.sh",
                    evidence,
                    String(executionExitCode),
                    ACTIVE_REVISION,
                    CANDIDATE_REVISION,
                    "apply",
                    "issue-2",
                ],
                { cwd: process.cwd(), encoding: "utf8" },
            );

            expect(result.status).toBe(expectedExitCode);
            expect(JSON.parse(await readFile(evidence, "utf8"))).toMatchObject({
                status: "failed",
                failureReason: "workflow_transport_or_execution_failed",
            });
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe("");
        },
    );

    it("rejects evidence with an extra nested Secret or a missing required field", async () => {
        const exact = environmentEvidence("succeeded");
        const { cleanupStatus: _cleanupStatus, ...missingCleanupStatus } =
            exact;
        const malformedEvidence = [
            {
                ...exact,
                diagnostic: {
                    databaseUrl:
                        "postgresql://user:secret@database.invalid/pipipi",
                },
            },
            missingCleanupStatus,
            { ...exact, applied: false },
            { ...exact, rollbackStatus: "failed" },
            { ...exact, cleanupStatus: "failed" },
        ];

        for (const malformed of malformedEvidence) {
            const root = await mkdtemp(
                path.join(tmpdir(), "pipipi-async-evidence-shape-"),
            );
            directories.push(root);
            const evidence = path.join(root, "evidence.json");
            await writeFile(evidence, JSON.stringify(malformed));

            const result = runEvidenceFinalizer(evidence, 0);

            expect(result.status).toBe(1);
            const replacement = await readFile(evidence, "utf8");
            expect(JSON.parse(replacement)).toMatchObject({
                status: "failed",
                failureReason: "workflow_transport_or_execution_failed",
            });
            expect(replacement).not.toContain("database.invalid");
            expect(replacement).not.toContain("secret");
        }
    });

    it("preserves exact evidence when its status matches the exit code", async () => {
        const root = await mkdtemp(
            path.join(tmpdir(), "pipipi-async-evidence-exact-"),
        );
        directories.push(root);
        const evidence = path.join(root, "evidence.json");
        const expected = environmentEvidence("succeeded");
        await writeFile(evidence, JSON.stringify(expected));

        const result = runEvidenceFinalizer(evidence, 0);

        expect(result.status).toBe(0);
        expect(JSON.parse(await readFile(evidence, "utf8"))).toEqual(expected);
    });

    it("validates a plan without creating role files", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "plan");

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            schemaVersion: 1,
            event: "async_production_environment_provisioned",
            status: "succeeded",
            mode: "plan",
            candidateVerified: true,
            applied: false,
        });
        await expectRoleFiles(fixture.shared, false);
        expect(
            await readFile(path.join(fixture.shared, ".env"), "utf8"),
        ).toContain(`DATABASE_URL=${ORIGINAL_DATABASE_URL}`);
        expect(result.stdout).not.toContain("database-secret");
        expect(result.stdout).not.toContain("redis-secret");
        expect(result.stdout).not.toContain("openai-secret");
        expect(result.stderr).toBe("");
    });

    it("atomically writes five isolated root-only role files on apply", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply");

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "succeeded",
            mode: "apply",
            candidateVerified: true,
            applied: true,
        });
        await expectRoleFiles(fixture.shared, true);
        const sharedEnvironment = await readFile(
            path.join(fixture.shared, ".env"),
            "utf8",
        );
        expect(sharedEnvironment).toContain(`DATABASE_URL=${DATABASE_URL}`);
        expect(sharedEnvironment).not.toContain(ORIGINAL_DATABASE_URL);
        expect(sharedEnvironment).toContain("FAL_KEY=fal-secret-must-not-copy");
        expect(sharedEnvironment).toContain(
            "OSS_ACCESS_KEY_SECRET=oss-secret-must-not-copy",
        );
        const contents = await Promise.all(
            ROLE_FILES.map((name) =>
                readFile(path.join(fixture.shared, name), "utf8"),
            ),
        );
        for (const content of contents) expect(content).toContain(DATABASE_URL);
        expect(contents[0]).not.toContain(REDIS_URL);
        expect(contents[1]).toContain(REDIS_URL);
        expect(contents[2]).toContain(REDIS_URL);
        expect(contents[3]).toContain(REDIS_URL);
        expect(contents[4]).not.toContain(REDIS_URL);
        expect(contents[0]).toContain("ASYNC_GATEWAY_SHARED_SECRET=");
        expect(contents[3]).toContain("WEBHOOK_SECRET_ENCRYPTION_KEY=");
        expect(contents[1]).not.toContain("OPENAI_API_KEY");
        expect(contents[2]).toContain("OPENAI_API_KEY=openai-secret");
        for (const content of [contents[0], contents[2]]) {
            expect(content).toContain(
                "TITLED_CONTENT_SEPARATOR=custom-separator",
            );
            expect(content).toContain("PROCESS_RUN_RECORD_POOL_MAX=7");
            expect(content).toContain(
                "PROCESS_RUN_OBSERVATION_TIMEOUT_MS=1800",
            );
            expect(content).toContain("PROCESS_RUN_RECORD_RETENTION_DAYS=45");
        }
        for (const content of contents) {
            expect(content).not.toContain("FAL_KEY");
            expect(content).not.toContain("OSS_ACCESS_KEY_SECRET");
        }
        expect(result.stdout).not.toContain("database-secret");
        expect(result.stdout).not.toContain("redis-secret");
        expect(result.stdout).not.toContain("openai-secret");
        expect(result.stderr).toBe("");
    });

    it("falls back to audited standard connection variables when overrides are empty", async () => {
        const fixture = await createFixture({ standardConnections: true });

        const result = runProvisioning(fixture, "apply", {
            databaseUrl: "",
            redisUrl: "",
        });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "succeeded",
            databaseConfigurationSource: "shared_environment",
            redisConfigurationSource: "shared_environment",
        });
        await expectRoleFiles(fixture.shared, true);
        await expect(stat(fixture.databaseAuditMarker)).resolves.toBeDefined();
        const dispatcher = await readFile(
            path.join(fixture.shared, "process-dispatcher.env"),
            "utf8",
        );
        expect(dispatcher).toContain(`DATABASE_URL=${DATABASE_URL}`);
        expect(dispatcher).toContain(`REDIS_URL=${REDIS_URL}`);
        expect(result.stdout).not.toContain("database-secret");
        expect(result.stdout).not.toContain("redis-secret");
    });

    it("resolves quoted and commented fallback values with Compose env-file semantics", async () => {
        const fixture = await createFixture({
            quotedStandardConnections: true,
            standardConnections: true,
        });

        const result = runProvisioning(fixture, "apply", {
            databaseUrl: "",
            redisUrl: "",
        });

        expect(result.status, result.stderr).toBe(0);
        const dispatcher = await readFile(
            path.join(fixture.shared, "process-dispatcher.env"),
            "utf8",
        );
        expect(dispatcher).toContain(`DATABASE_URL=${DATABASE_URL}`);
        expect(dispatcher).toContain(`REDIS_URL=${REDIS_URL}`);
        expect(dispatcher).not.toContain("approved fallback");
        expect(dispatcher).not.toContain('DATABASE_URL="');
    });

    it("rejects a standard database fallback that fails the live boundary audit", async () => {
        const fixture = await createFixture({ standardConnections: true });

        const result = runProvisioning(fixture, "apply", {
            databaseAuditFails: true,
            databaseUrl: "",
            redisUrl: "",
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "database_boundary_invalid",
            databaseConfigurationSource: "shared_environment",
            redisConfigurationSource: "shared_environment",
        });
        await expectRoleFiles(fixture.shared, false);
    });

    it("rejects a protected database override that fails the live boundary audit", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            databaseAuditFails: true,
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "database_boundary_invalid",
            databaseConfigurationSource: "protected_override",
            redisConfigurationSource: "protected_override",
        });
        await expectRoleFiles(fixture.shared, false);
    });

    it("fails closed when the standard Redis fallback is absent", async () => {
        const fixture = await createFixture({
            standardConnections: true,
            standardRedisAbsent: true,
        });

        const result = runProvisioning(fixture, "plan", {
            databaseUrl: "",
            redisUrl: "",
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "standard_redis_url_unavailable",
            databaseConfigurationSource: "shared_environment",
            redisConfigurationSource: "not_observed",
        });
        await expectRoleFiles(fixture.shared, false);
    });

    it("rejects PostgreSQL query parameters that can override the authority", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            databaseUrl: `${DATABASE_URL}&options=-c%20role%3Dpostgres`,
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "connection_contract_invalid",
        });
        await expectRoleFiles(fixture.shared, false);
    });

    it.each([
        ["non-TLS Redis", REDIS_URL.replace("rediss:", "redis:"), ""],
        [
            "unverified PostgreSQL",
            DATABASE_URL.replace("verify-ca", "require"),
            "",
        ],
        ["failed Worker preflight", REDIS_URL, "process-worker"],
    ])("leaves no role files after %s", async (_name, redisUrl, failedRole) => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            databaseUrl:
                _name === "unverified PostgreSQL"
                    ? DATABASE_URL.replace("verify-ca", "require")
                    : DATABASE_URL,
            failedRole,
            redisUrl,
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            event: "async_production_environment_provisioned",
            status: "failed",
        });
        await expectRoleFiles(fixture.shared, false);
        expect(
            await readFile(path.join(fixture.shared, ".env"), "utf8"),
        ).toContain(`DATABASE_URL=${ORIGINAL_DATABASE_URL}`);
        expect(result.stdout).not.toContain("database-secret");
        expect(result.stdout).not.toContain("redis-secret");
        expect(result.stderr).toBe("");
    });

    it("refuses to rewrite files while an async role exists", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            asyncRoleExists: true,
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "current_sync_shape_invalid",
        });
        await expectRoleFiles(fixture.shared, false);
        expect(
            await readFile(path.join(fixture.shared, ".env"), "utf8"),
        ).toContain(`DATABASE_URL=${ORIGINAL_DATABASE_URL}`);
        expect(result.stderr).toBe("");
    });

    it("rolls back files installed before an atomic install failure", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            installFailureTarget: "process-worker.env",
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "atomic_install_failed",
        });
        await expectRoleFiles(fixture.shared, false);
        expect(
            await readFile(path.join(fixture.shared, ".env"), "utf8"),
        ).toContain(`DATABASE_URL=${ORIGINAL_DATABASE_URL}`);
        expect(result.stderr).toBe("");
    });

    it("fails closed when the candidate image tag changes", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            retagAtInspection: 2,
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "candidate_image_changed",
        });
        await expectRoleFiles(fixture.shared, false);
        expect(
            await readFile(path.join(fixture.shared, ".env"), "utf8"),
        ).toContain(`DATABASE_URL=${ORIGINAL_DATABASE_URL}`);
        expect(result.stderr).toBe("");
    });

    it("rechecks the candidate image immediately before the shared commit", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            retagAtInspection: 3,
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "candidate_image_changed",
            rollbackStatus: "succeeded",
        });
        await expectRoleFiles(fixture.shared, false);
        expect(
            await readFile(path.join(fixture.shared, ".env"), "utf8"),
        ).toContain(`DATABASE_URL=${ORIGINAL_DATABASE_URL}`);
    });

    it("preserves a concurrent shared environment update", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            sharedEnvChangeAfterTarget: "process-dispatcher.env",
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "shared_environment_changed",
            rollbackStatus: "succeeded",
        });
        await expectRoleFiles(fixture.shared, false);
        const sharedEnvironment = await readFile(
            path.join(fixture.shared, ".env"),
            "utf8",
        );
        expect(sharedEnvironment).toContain("CONCURRENT_ROTATION=preserved");
        expect(sharedEnvironment).toContain(
            `DATABASE_URL=${ORIGINAL_DATABASE_URL}`,
        );
    });

    it("reports a failed rollback when an installed Secret cannot be removed", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            cleanupFailureTarget: "async-api.env",
            installFailureTarget: "process-worker.env",
        });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "atomic_install_failed",
            rollbackStatus: "failed",
            cleanupStatus: "failed",
        });
        expect(
            (await stat(path.join(fixture.shared, "async-api.env"))).mode &
                0o777,
        ).toBe(0o600);
    });

    it("removes the just-linked Secret file when SIGTERM lands after ln", async () => {
        const fixture = await createFixture();

        const result = runProvisioning(fixture, "apply", {
            signalAfterTarget: "process-dispatcher.env",
        });

        expect(result.status).toBe(143);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: "failed",
            failureReason: "interrupted_TERM",
        });
        await expectRoleFiles(fixture.shared, false);
        expect(
            await readFile(path.join(fixture.shared, ".env"), "utf8"),
        ).toContain(`DATABASE_URL=${ORIGINAL_DATABASE_URL}`);
        expect(result.stderr).toBe("");
    });

    async function createFixture(
        options: Readonly<{
            quotedStandardConnections?: boolean;
            standardConnections?: boolean;
            standardRedisAbsent?: boolean;
        }> = {},
    ) {
        const root = await mkdtemp(
            path.join(tmpdir(), "pipipi-async-provision-"),
        );
        directories.push(root);
        const appRoot = path.join(root, "app");
        const shared = path.join(appRoot, "shared");
        const binaries = path.join(root, "bin");
        const databaseAuditMarker = path.join(root, "database-audit-ran");
        await Promise.all([
            mkdir(shared, { recursive: true }),
            mkdir(binaries),
        ]);
        await writeFile(
            path.join(shared, ".env"),
            [
                "BUSINESS_API_BASE_URL=http://127.0.0.1:4400",
                options.quotedStandardConnections
                    ? `DATABASE_URL="${DATABASE_URL}" # approved fallback`
                    : `DATABASE_URL=${options.standardConnections ? DATABASE_URL : ORIGINAL_DATABASE_URL}`,
                ...(options.standardConnections && !options.standardRedisAbsent
                    ? [
                          options.quotedStandardConnections
                              ? `REDIS_URL='${REDIS_URL}' # approved fallback`
                              : `REDIS_URL=${REDIS_URL}`,
                      ]
                    : []),
                "PI_PROVIDER=openai",
                "PI_MODEL=gpt-5.6-terra",
                "OPENAI_API_KEY=openai-secret",
                "OPENAI_BASE_URL=https://api.openai.invalid/v1",
                "OPENAI_API_MODE=responses",
                "PROCESS_TIMEOUT_MS=240000",
                "TITLED_CONTENT_SEPARATOR=custom-separator",
                "PROCESS_RUN_RECORD_POOL_MAX=7",
                "PROCESS_RUN_OBSERVATION_TIMEOUT_MS=1800",
                "PROCESS_RUN_RECORD_RETENTION_DAYS=45",
                "FAL_KEY=fal-secret-must-not-copy",
                "OSS_ACCESS_KEY_SECRET=oss-secret-must-not-copy",
                "",
            ].join("\n"),
            { mode: 0o600 },
        );
        await writeFile(path.join(shared, "pg-server.crt"), "fixture-ca\n", {
            mode: 0o600,
        });
        await writeExecutable(
            path.join(binaries, "docker"),
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = image ] && [ "$2" = inspect ]; then
    count_file="$FAKE_STATE_DIRECTORY/image-inspections"
    count=0
    if [ -f "$count_file" ]; then count="$(<"$count_file")"; fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    if [ "$FAKE_RETAG_AT_INSPECTION" -gt 0 ] && [ "$count" -ge "$FAKE_RETAG_AT_INSPECTION" ]; then
        printf 'sha256:%064d\n' 2
        exit 0
    fi
    printf 'sha256:%064d\n' 1
    exit 0
fi
if [ "$1" = compose ]; then
    printf '{"services":{"connection-probe":{"environment":{"DATABASE_URL":"%s","REDIS_URL":"%s"}}}}\n' \
        "$FAKE_STANDARD_DATABASE_URL" "$FAKE_STANDARD_REDIS_URL"
    exit 0
fi
if [ "$1" = inspect ]; then
    if [ "$2" = pipipi ]; then
        printf '[{"State":{"Running":true},"Config":{"Labels":{"com.pipipi.revision":"%s"},"Env":["ASYNC_PROCESS_RUNS_ENABLED=false"]}}]\n' "$FAKE_ACTIVE_REVISION"
        exit 0
    fi
    if [ "$2" = pipipi-business-api ]; then
        printf '[{"State":{"Running":true},"Config":{"Labels":{"com.pipipi.revision":"%s"},"Env":[]}}]\n' "$FAKE_ACTIVE_REVISION"
        exit 0
    fi
    if [ "$FAKE_ASYNC_ROLE_EXISTS" = true ]; then exit 0; fi
    exit 1
fi
if [ "$1" = run ]; then
    if [[ " $* " == *" audit:production-database "* ]]; then
        [[ " $* " == *" --network host "* ]]
        : > "$FAKE_DATABASE_AUDIT_MARKER"
        [ "$FAKE_DATABASE_AUDIT_FAILS" != true ]
        printf '%s\n' '{"event":"production_database_identity_verified","databaseIdentitySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","tlsVerified":true,"dedicatedDatabaseVerified":true,"nonSuperuserVerified":true,"administrativePrivilegesAbsent":true,"otherDatabaseAccessAbsent":true,"roleMembershipAbsent":true,"roleSwitchingAbsent":true}'
        exit 0
    fi
    [[ " $* " == *" --rm "* ]]
    [[ " $* " == *" --network none "* ]]
    [[ " $* " == *" sha256:0000000000000000000000000000000000000000000000000000000000000001 "* ]]
    env_file=""
    role=""
    code=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --env-file) env_file="$2"; shift 2 ;;
            dist/bin/check-deployment-environment.js) role="$2"; shift 2 ;;
            -e) code="$2"; break ;;
            *) shift ;;
        esac
    done
    if [ -n "$role" ]; then
        [ "$role" != "$FAKE_FAILED_ROLE" ]
        exit 0
    fi
    if [ -n "$code" ]; then
        FAKE_ENV_FILE="$env_file" FAKE_CODE="$code" exec "$FAKE_NODE" -e '
const fs = require("node:fs");
for (const line of fs.readFileSync(process.env.FAKE_ENV_FILE, "utf8").split("\\n")) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    process.env[line.slice(0, separator)] = line.slice(separator + 1);
}
eval(process.env.FAKE_CODE);
'
    fi
    exit 2
fi
exit 2
`,
        );
        await writeExecutable(
            path.join(binaries, "stat"),
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = -c ] && [ "$2" = '%u:%g:%a' ]; then printf '0:0:600\n'; exit 0; fi
if [ "$1" = -c ] && [ "$2" = '%d:%i' ]; then printf '1:1\n'; exit 0; fi
exit 2
`,
        );
        await writeExecutable(
            path.join(binaries, "ln"),
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ -n "$FAKE_INSTALL_FAILURE_TARGET" ] && [ "$(basename "$3")" = "$FAKE_INSTALL_FAILURE_TARGET" ]; then
    exit 1
fi
"$FAKE_LN" "$@"
if [ -n "$FAKE_SHARED_ENV_CHANGE_AFTER_TARGET" ] && [ "$(basename "$3")" = "$FAKE_SHARED_ENV_CHANGE_AFTER_TARGET" ]; then
    printf '%s\n' 'CONCURRENT_ROTATION=preserved' >> "$FAKE_SHARED_ENV"
fi
if [ -n "$FAKE_SIGNAL_AFTER_TARGET" ] && [ "$(basename "$3")" = "$FAKE_SIGNAL_AFTER_TARGET" ]; then
    kill -TERM "$PPID"
fi
`,
        );
        await writeExecutable(
            path.join(binaries, "rm"),
            `#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "$@"; do
    if [ -n "$FAKE_CLEANUP_FAILURE_TARGET" ] && [ "$(basename "$argument")" = "$FAKE_CLEANUP_FAILURE_TARGET" ]; then
        exit 1
    fi
done
exec "$FAKE_RM" "$@"
`,
        );
        await writeExecutable(
            path.join(binaries, "flock"),
            `#!/usr/bin/env bash
set -Eeuo pipefail
[ "$1" = -n ]
[ "$2" = 9 ]
`,
        );
        return {
            appRoot,
            binaries,
            databaseAuditMarker,
            standardDatabaseUrl: options.standardConnections
                ? DATABASE_URL
                : ORIGINAL_DATABASE_URL,
            standardRedisUrl:
                options.standardConnections && !options.standardRedisAbsent
                    ? REDIS_URL
                    : "",
            shared,
            stateDirectory: root,
        };
    }
});

async function writeExecutable(file: string, content: string) {
    await writeFile(file, content, { mode: 0o755 });
    await chmod(file, 0o755);
}

function runProvisioning(
    fixture: {
        appRoot: string;
        binaries: string;
        databaseAuditMarker: string;
        standardDatabaseUrl: string;
        standardRedisUrl: string;
        stateDirectory: string;
    },
    mode: "plan" | "apply",
    options: Readonly<{
        asyncRoleExists?: boolean;
        cleanupFailureTarget?: string;
        databaseAuditFails?: boolean;
        databaseUrl?: string;
        failedRole?: string;
        installFailureTarget?: string;
        redisUrl?: string;
        retagAtInspection?: number;
        sharedEnvChangeAfterTarget?: string;
        signalAfterTarget?: string;
    }> = {},
) {
    const databaseUrl = options.databaseUrl ?? DATABASE_URL;
    const redisUrl = options.redisUrl ?? REDIS_URL;
    return spawnSync(
        "bash",
        [
            "ops/provision-async-production-environments.sh",
            fixture.appRoot,
            ACTIVE_REVISION,
            CANDIDATE_REVISION,
            mode,
            "process-runs",
            "pipipi-production",
            "webhook-deliveries",
            "pipipi-production",
            "issue-2",
        ],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
                ...process.env,
                FAKE_ACTIVE_REVISION: ACTIVE_REVISION,
                FAKE_ASYNC_ROLE_EXISTS: String(
                    options.asyncRoleExists ?? false,
                ),
                FAKE_CLEANUP_FAILURE_TARGET: options.cleanupFailureTarget ?? "",
                FAKE_DATABASE_AUDIT_FAILS: String(
                    options.databaseAuditFails ?? false,
                ),
                FAKE_DATABASE_AUDIT_MARKER: fixture.databaseAuditMarker,
                FAKE_FAILED_ROLE: options.failedRole ?? "",
                FAKE_STANDARD_DATABASE_URL: fixture.standardDatabaseUrl,
                FAKE_STANDARD_REDIS_URL: fixture.standardRedisUrl,
                FAKE_INSTALL_FAILURE_TARGET: options.installFailureTarget ?? "",
                FAKE_LN: "/bin/ln",
                FAKE_NODE: process.execPath,
                FAKE_RETAG_AT_INSPECTION: String(
                    options.retagAtInspection ?? 0,
                ),
                FAKE_RM: "/bin/rm",
                FAKE_SHARED_ENV: path.join(fixture.appRoot, "shared", ".env"),
                FAKE_SHARED_ENV_CHANGE_AFTER_TARGET:
                    options.sharedEnvChangeAfterTarget ?? "",
                FAKE_SIGNAL_AFTER_TARGET: options.signalAfterTarget ?? "",
                FAKE_STATE_DIRECTORY: fixture.stateDirectory,
                PATH: `${fixture.binaries}:${process.env.PATH ?? ""}`,
            },
            input: `${databaseUrl}\0${redisUrl}\0`,
        },
    );
}

async function expectRoleFiles(shared: string, expected: boolean) {
    for (const name of ROLE_FILES) {
        const file = path.join(shared, name);
        if (!expected) {
            await expect(stat(file)).rejects.toThrow();
            continue;
        }
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
}

function environmentEvidence(status: "succeeded" | "failed") {
    return {
        schemaVersion: 1,
        event: "async_production_environment_provisioned",
        status,
        mode: "apply",
        activeRevision: ACTIVE_REVISION,
        candidateRevision: CANDIDATE_REVISION,
        changeReference: "issue-2",
        candidateVerified: status === "succeeded",
        applied: status === "succeeded",
        rollbackStatus: "not_required",
        cleanupStatus: "succeeded",
        databaseConfigurationSource: "protected_override",
        redisConfigurationSource: "protected_override",
        ...(status === "failed" ? { failureReason: "fixture_failure" } : {}),
    };
}

function runEvidenceFinalizer(evidence: string, executionExitCode: number) {
    return spawnSync(
        "bash",
        [
            "ops/finalize-async-production-environment-evidence.sh",
            evidence,
            String(executionExitCode),
            ACTIVE_REVISION,
            CANDIDATE_REVISION,
            "apply",
            "issue-2",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
    );
}
