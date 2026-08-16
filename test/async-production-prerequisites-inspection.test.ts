import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
    chmod,
    mkdir,
    mkdtemp,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ACTIVE_REVISION = "7".repeat(40);
const CANDIDATE_REVISION = "e".repeat(40);

describe("Async production prerequisites inspection", () => {
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

    it("is a protected manual read-only workflow", () => {
        const workflow = readFileSync(
            ".github/workflows/async-production-prerequisites-inspection.yml",
            "utf8",
        );
        const script = readFileSync(
            "ops/inspect-async-production-prerequisites.sh",
            "utf8",
        );

        expect(workflow).toContain("workflow_dispatch:");
        expect(workflow).not.toMatch(/\n {2}(push|pull_request|schedule):/);
        expect(workflow).toContain("name: async-internal");
        expect(workflow).toContain("group: pipipi-production-release");
        expect(workflow).toContain(
            "ops/inspect-async-production-prerequisites.sh",
        );
        expect(script).toContain("--network none");
        expect(script).not.toMatch(/\b(ALTER|CREATE|DROP|GRANT|REVOKE)\b/);
        expect(script).not.toContain("docker compose up");
    });

    it("reports a complete redacted prerequisite shape", async () => {
        const fixture = await createFixture();

        const result = runInspection(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            schemaVersion: 1,
            event: "async_production_prerequisites_inspected",
            status: "succeeded",
            candidateImageVerified: true,
            currentSyncShapeVerified: true,
            databaseUrlConsistent: true,
            redisUrlConsistent: true,
            redisLoopbackPasswordConfigured: true,
            gatewaySecretConfigured: true,
            webhookSecretConfigured: true,
            roles: {
                api: {
                    environmentIsolated: true,
                    filePresent: true,
                    fileRestricted: true,
                    preflightPassed: true,
                },
                dispatcher: {
                    environmentIsolated: true,
                    filePresent: true,
                    fileRestricted: true,
                    preflightPassed: true,
                },
                worker: {
                    environmentIsolated: true,
                    filePresent: true,
                    fileRestricted: true,
                    preflightPassed: true,
                },
                webhook: {
                    environmentIsolated: true,
                    filePresent: true,
                    fileRestricted: true,
                    preflightPassed: true,
                },
                retention: {
                    environmentIsolated: true,
                    filePresent: true,
                    fileRestricted: true,
                    preflightPassed: true,
                },
            },
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stdout).not.toContain("postgres://");
        expect(result.stdout).not.toContain("redis://");
        expect(result.stderr).toBe("");
    });

    it("reports missing role files without exposing another role", async () => {
        const fixture = await createFixture({ missingWorker: true });

        const result = runInspection(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            databaseUrlConsistent: false,
            redisUrlConsistent: false,
            roles: {
                worker: {
                    environmentIsolated: false,
                    filePresent: false,
                    fileRestricted: false,
                    preflightPassed: false,
                },
            },
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stderr).toBe("");
    });

    it("separates database drift from Redis consistency", async () => {
        const fixture = await createFixture({ mismatchedWorkerDatabase: true });

        const result = runInspection(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            databaseUrlConsistent: false,
            redisUrlConsistent: true,
        });
        expect(result.stdout).not.toContain("different-secret");
        expect(result.stderr).toBe("");
    });

    it("reports an isolated role preflight failure and invalid secret shapes", async () => {
        const fixture = await createFixture({ invalidSecrets: true });

        const result = runInspection(fixture, {
            preflightFailureRole: "process-worker",
        });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            gatewaySecretConfigured: false,
            webhookSecretConfigured: false,
            roles: {
                api: { preflightPassed: true },
                dispatcher: { preflightPassed: true },
                worker: { preflightPassed: false },
                webhook: { preflightPassed: true },
                retention: { preflightPassed: true },
            },
        });
        expect(result.stdout).not.toContain("short-secret");
        expect(result.stderr).toBe("");
    });

    it("fails closed when the candidate tag changes during inspection", async () => {
        const fixture = await createFixture();

        const result = runInspection(fixture, { retagCandidate: true });

        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            schemaVersion: 1,
            event: "async_production_prerequisites_inspected",
            status: "inspection_failed",
            failureReason: "candidate_image_changed",
        });
        expect(result.stdout).not.toContain("fixture-secret");
        expect(result.stderr).toBe("");
    });

    it("requires both synchronous containers to match the active revision", async () => {
        const fixture = await createFixture();

        const result = runInspection(fixture, {
            businessRevision: "6".repeat(40),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            currentSyncShapeVerified: false,
        });
        expect(result.stderr).toBe("");
    });

    it("rejects a stopped synchronous container", async () => {
        const fixture = await createFixture();

        const result = runInspection(fixture, { apiRunning: false });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            currentSyncShapeVerified: false,
        });
        expect(result.stderr).toBe("");
    });

    it("rejects an API whose async intake is already enabled", async () => {
        const fixture = await createFixture();

        const result = runInspection(fixture, { asyncEnabled: true });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            currentSyncShapeVerified: false,
        });
        expect(result.stderr).toBe("");
    });

    it("detects a cross-role Secret in the Worker environment", async () => {
        const fixture = await createFixture({ workerHasGatewaySecret: true });

        const result = runInspection(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            roles: {
                api: { environmentIsolated: true },
                worker: {
                    environmentIsolated: false,
                    preflightPassed: false,
                },
                webhook: { environmentIsolated: true },
            },
        });
        expect(result.stdout).not.toContain("cross-role-secret");
        expect(result.stderr).toBe("");
    });

    it("does not inject cross-role Secrets into API or Webhook checks", async () => {
        const fixture = await createFixture({
            apiHasWebhookSecret: true,
            webhookHasGatewaySecret: true,
        });

        const result = runInspection(fixture);

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            gatewaySecretConfigured: false,
            webhookSecretConfigured: false,
            roles: {
                api: {
                    environmentIsolated: false,
                    preflightPassed: false,
                },
                webhook: {
                    environmentIsolated: false,
                    preflightPassed: false,
                },
            },
        });
        expect(result.stdout).not.toContain("cross-role-secret");
        expect(result.stderr).toBe("");
    });

    it.each([
        ["0640 file", { workerMode: "640" }],
        ["symbolic link", { workerSymlink: true }],
    ])(
        "rejects a Worker environment stored as a %s",
        async (_name, options) => {
            const fixture = await createFixture(options);

            const result = runInspection(fixture);

            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout)).toMatchObject({
                roles: {
                    worker: {
                        environmentIsolated: false,
                        fileRestricted: false,
                        preflightPassed: false,
                    },
                },
            });
            expect(result.stderr).toBe("");
        },
    );

    async function createFixture(
        options: Readonly<{
            apiHasWebhookSecret?: boolean;
            invalidSecrets?: boolean;
            mismatchedWorkerDatabase?: boolean;
            missingWorker?: boolean;
            workerHasGatewaySecret?: boolean;
            workerMode?: string;
            workerSymlink?: boolean;
            webhookHasGatewaySecret?: boolean;
        }> = {},
    ) {
        const root = await mkdtemp(
            path.join(tmpdir(), "pipipi-async-prerequisites-"),
        );
        directories.push(root);
        const appRoot = path.join(root, "app");
        const shared = path.join(appRoot, "shared");
        const binaries = path.join(root, "bin");
        await Promise.all([
            mkdir(shared, { recursive: true }),
            mkdir(binaries),
        ]);
        const databaseUrl =
            "postgres://fixture-secret@database.invalid/pipipi?sslmode=verify-ca";
        const redisUrl = "redis://:fixture-secret@127.0.0.1:6380/0";
        const workerDatabaseUrl = options.mismatchedWorkerDatabase
            ? "postgres://different-secret@database.invalid/pipipi?sslmode=verify-ca"
            : databaseUrl;
        const gatewaySecret = options.invalidSecrets
            ? "short-secret"
            : "g".repeat(32);
        const webhookSecret = options.invalidSecrets
            ? "not-canonical-base64"
            : Buffer.alloc(32, 1).toString("base64");
        const workerExtra = options.workerHasGatewaySecret
            ? "ASYNC_GATEWAY_SHARED_SECRET=cross-role-secret\n"
            : "";
        const apiExtra = options.apiHasWebhookSecret
            ? "WEBHOOK_SECRET_ENCRYPTION_KEY=cross-role-secret\n"
            : "";
        const webhookExtra = options.webhookHasGatewaySecret
            ? "ASYNC_GATEWAY_SHARED_SECRET=cross-role-secret\n"
            : "";
        const files = new Map<string, string>([
            [".env", `DATABASE_URL=${databaseUrl}\n`],
            [
                "async-api.env",
                `BUSINESS_API_BASE_URL=http://127.0.0.1:4400\nDATABASE_URL=${databaseUrl}\nASYNC_GATEWAY_SHARED_SECRET=${gatewaySecret}\nPROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS=86400000\nPROCESS_RUN_RESULT_RETENTION_MS=604800000\nPROCESS_RUN_METADATA_RETENTION_MS=2592000000\nASYNC_GLOBAL_BACKLOG_LIMIT=1000\nASYNC_CALLER_BACKLOG_LIMIT=100\nASYNC_BACKLOG_RETRY_AFTER_SECONDS=5\nPI_PALE_WATERCOLOR_SKILL_DIRECTORY=/app/.pi/skills/pale\nPI_RAW_HUMANISM_SKILL_DIRECTORY=/app/.pi/skills/raw\nPI_NARRATIVE_MONUMENT_SKILL_DIRECTORY=/app/.pi/skills/monument\n${apiExtra}`,
            ],
            [
                "process-dispatcher.env",
                `DATABASE_URL=${databaseUrl}\nREDIS_URL=${redisUrl}\n`,
            ],
            [
                "process-worker.env",
                `BUSINESS_API_BASE_URL=http://127.0.0.1:4400\nDATABASE_URL=${workerDatabaseUrl}\nREDIS_URL=${redisUrl}\nPROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS=86400000\nPROCESS_RUN_RESULT_RETENTION_MS=604800000\nPROCESS_RUN_METADATA_RETENTION_MS=2592000000\nPI_PALE_WATERCOLOR_SKILL_DIRECTORY=/app/.pi/skills/pale\nPI_RAW_HUMANISM_SKILL_DIRECTORY=/app/.pi/skills/raw\nPI_NARRATIVE_MONUMENT_SKILL_DIRECTORY=/app/.pi/skills/monument\n${workerExtra}`,
            ],
            [
                "webhook-worker.env",
                `DATABASE_URL=${databaseUrl}\nREDIS_URL=${redisUrl}\nWEBHOOK_SECRET_ENCRYPTION_KEY=${webhookSecret}\n${webhookExtra}`,
            ],
            ["retention-cleaner.env", `DATABASE_URL=${databaseUrl}\n`],
        ]);
        if (options.missingWorker) files.delete("process-worker.env");
        await Promise.all(
            [...files].map(async ([name, content]) => {
                const file = path.join(shared, name);
                await writeFile(file, content, { mode: 0o600 });
                await chmod(file, 0o600);
            }),
        );
        if (options.workerSymlink) {
            const worker = path.join(shared, "process-worker.env");
            const target = path.join(shared, "worker-target.env");
            await writeFile(target, files.get("process-worker.env") ?? "", {
                mode: 0o600,
            });
            await rm(worker);
            await symlink(target, worker);
        }
        await writeFile(path.join(shared, "pg-server.crt"), "fixture\n");
        const docker = path.join(binaries, "docker");
        await writeFile(
            docker,
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = inspect ]; then
    if [ "$2" = pipipi ]; then
        printf '[{"State":{"Running":%s},"Config":{"Labels":{"com.pipipi.revision":"%s"},"Env":["ASYNC_PROCESS_RUNS_ENABLED=%s","DATABASE_URL=postgres://fixture-secret@database.invalid/pipipi"]}}]\n' \
            "$FAKE_API_RUNNING" "$FAKE_ACTIVE_REVISION" "$FAKE_ASYNC_ENABLED"
        exit 0
    fi
    if [ "$2" = pipipi-business-api ]; then
        printf '[{"State":{"Running":%s},"Config":{"Labels":{"com.pipipi.revision":"%s"},"Env":[]}}]\n' \
            "$FAKE_BUSINESS_RUNNING" "$FAKE_BUSINESS_REVISION"
        exit 0
    fi
    exit 1
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
    count_file="$FAKE_STATE_DIRECTORY/image-inspections"
    count=0
    if [ -f "$count_file" ]; then count="$(<"$count_file")"; fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    if [ "\${FAKE_RETAG_CANDIDATE:-false}" = true ] && [ "$count" -gt 1 ]; then
        printf 'sha256:%064d\n' 2
        exit 0
    fi
    printf 'sha256:%064d\n' 1
    exit 0
fi
if [ "$1" = run ]; then
    if [[ " $* " != *" --rm "* ]] || [[ " $* " != *" --network none "* ]] ||
        [[ " $* " != *" sha256:0000000000000000000000000000000000000000000000000000000000000001 "* ]]; then
        exit 90
    fi
    if [[ " $* " == *" dist/bin/check-deployment-environment.js \${FAKE_PREFLIGHT_FAILURE_ROLE:-__none__} "* ]]; then
        exit 1
    fi
    env_file=""
    secret_kind=""
    code=""
    role=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --env-file) env_file="$2"; shift 2 ;;
            --env)
                if [[ "$2" == SECRET_KIND=* ]]; then secret_kind="\${2#SECRET_KIND=}"; fi
                shift 2
                ;;
            dist/bin/check-deployment-environment.js)
                role="$2"
                shift 2
                ;;
            -e) code="$2"; break ;;
            *) shift ;;
        esac
    done
    if [ -n "$code" ]; then
        expected_file=""
        case "$secret_kind" in
            "") expected_file=process-dispatcher.env ;;
            gateway) expected_file=async-api.env ;;
            webhook) expected_file=webhook-worker.env ;;
            *) exit 91 ;;
        esac
        [ "$(basename "$env_file")" = "$expected_file" ] || exit 92
        set -a
        # The fixture values are deliberately shell-safe. Production never sources env files.
        source "$env_file"
        set +a
        if [ -z "$secret_kind" ]; then exec "$FAKE_NODE" -e "$code"; fi
        export SECRET_KIND="$secret_kind"
        exec "$FAKE_NODE" -e "$code"
    fi
    case "$role" in
        api) expected_file=async-api.env ;;
        process-dispatcher) expected_file=process-dispatcher.env ;;
        process-worker) expected_file=process-worker.env ;;
        webhook-worker) expected_file=webhook-worker.env ;;
        retention-cleaner) expected_file=retention-cleaner.env ;;
        *) exit 93 ;;
    esac
    [ "$(basename "$env_file")" = "$expected_file" ] || exit 94
    exit 0
fi
exit 2
`,
        );
        await chmod(docker, 0o755);
        const stat = path.join(binaries, "stat");
        await writeFile(
            stat,
            `#!/usr/bin/env bash
set -Eeuo pipefail
if [ "$1" = -c ]; then
    if [ "$(basename "$3")" = process-worker.env ]; then
        printf '0:0:%s\n' "$FAKE_WORKER_MODE"
    else
        printf '0:0:600\n'
    fi
    exit 0
fi
exit 2
`,
        );
        await chmod(stat, 0o755);
        return {
            appRoot,
            binaries,
            stateDirectory: root,
            workerMode: options.workerMode ?? "600",
        };
    }
});

function runInspection(
    fixture: {
        appRoot: string;
        binaries: string;
        stateDirectory: string;
        workerMode: string;
    },
    options: Readonly<{
        apiRunning?: boolean;
        asyncEnabled?: boolean;
        businessRunning?: boolean;
        businessRevision?: string;
        preflightFailureRole?: string;
        retagCandidate?: boolean;
    }> = {},
) {
    return spawnSync(
        "bash",
        [
            "ops/inspect-async-production-prerequisites.sh",
            fixture.appRoot,
            ACTIVE_REVISION,
            CANDIDATE_REVISION,
            "process-runs",
            "pipipi-production",
            "webhook-deliveries",
            "pipipi-production",
        ],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
                ...process.env,
                FAKE_ACTIVE_REVISION: ACTIVE_REVISION,
                FAKE_API_RUNNING: String(options.apiRunning ?? true),
                FAKE_ASYNC_ENABLED: String(options.asyncEnabled ?? false),
                FAKE_BUSINESS_RUNNING: String(options.businessRunning ?? true),
                FAKE_BUSINESS_REVISION:
                    options.businessRevision ?? ACTIVE_REVISION,
                FAKE_NODE: process.execPath,
                FAKE_PREFLIGHT_FAILURE_ROLE: options.preflightFailureRole ?? "",
                FAKE_RETAG_CANDIDATE: String(options.retagCandidate ?? false),
                FAKE_STATE_DIRECTORY: fixture.stateDirectory,
                FAKE_WORKER_MODE: fixture.workerMode,
                PATH: `${fixture.binaries}:${process.env.PATH ?? ""}`,
            },
        },
    );
}
