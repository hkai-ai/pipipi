import { spawnSync } from "node:child_process";
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
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const CANDIDATE = "b".repeat(40);
const PREVIOUS = "a".repeat(40);

describe("Async internal deployment script", () => {
    const temporaryDirectories: string[] = [];
    const temporaryFiles: string[] = [];
    let releaseSequence = 6000;

    afterEach(async () => {
        await Promise.all(
            temporaryDirectories.splice(0).map((directory) =>
                rm(directory, {
                    recursive: true,
                    force: true,
                }),
            ),
        );
        await Promise.all(
            temporaryFiles.splice(0).map((file) =>
                rm(file, {
                    force: true,
                }),
            ),
        );
    });

    it("passes every gate before activating the internal API", async () => {
        const fixture = await createFixture();

        const result = runDeployment(fixture);

        expect(result.status, result.stderr).toBe(0);
        const log = await readFile(fixture.dockerLog, "utf8");
        expectOrdered(log, [
            "check-deployment-environment.js api",
            "audit:production-database",
            "migrate-and-verify.js",
            "recover.js --dry-run --mode=all",
            "business-api retention-cleaner process-dispatcher process-worker webhook-worker",
            "--no-deps api",
        ]);
        const evidence = await evidenceRecord(fixture);
        expect(evidence).toMatchObject({
            status: "succeeded",
            failedGate: "complete",
            candidateCommit: CANDIDATE,
            imageId: `sha256:${"b".repeat(64)}`,
            previousShape: "sync",
            previousRevision: PREVIOUS,
            releaseStage: "internal",
            databaseBoundaryVerified: true,
            migrationVerified: true,
            recoveryStartedWithEmptyCursor: true,
            recoveryFinalCursorEmpty: true,
            recoveryVerified: true,
            rolesVerified: true,
            rollbackStatus: "not_required",
        });
        expect(await pathExists(fixture.archive)).toBe(false);
        expect(await pathExists(fixture.baseCompose)).toBe(false);
        expect(await pathExists(fixture.asyncCompose)).toBe(false);
        expect(
            await readdir(
                path.join(
                    fixture.appRoot,
                    "shared",
                    "async-release-evidence",
                    `${CANDIDATE}-${fixture.releaseRunId}-1`,
                ),
            ),
        ).toEqual([
            "database.json",
            "environment-prechecks.jsonl",
            "evidence.json",
            "migration.json",
            "readiness.jsonl",
            "recovery.jsonl",
        ]);
    });

    it("stops before migration when the live database boundary is invalid", async () => {
        const fixture = await createFixture({ failDatabaseAudit: true });

        const result = runDeployment(fixture);

        expect(result.status).not.toBe(0);
        expect(result.stderr).not.toContain("database-secret");
        expect(result.stderr).not.toContain("database.internal");
        const log = await readFile(fixture.dockerLog, "utf8");
        expect(log).toContain("audit:production-database");
        expect(log).not.toContain("migrate-and-verify.js");
        expect(await readFile(fixture.stateFile, "utf8")).toBe(
            "sync:previous\n",
        );
        await expect(evidenceRecord(fixture)).resolves.toMatchObject({
            status: "failed",
            failedGate: "database_boundary",
            databaseBoundaryVerified: false,
            migrationVerified: false,
            rollbackStatus: "not_required",
        });
        await expect(
            readFile(
                path.join(
                    fixture.appRoot,
                    "shared",
                    "async-release-evidence",
                    `${CANDIDATE}-${fixture.releaseRunId}-1`,
                    "database.json",
                ),
                "utf8",
            ),
        ).resolves.toBe("");
    });

    it("restores the synchronous shape when API activation fails", async () => {
        const fixture = await createFixture({ failApiActivation: true });

        const result = runDeployment(fixture);

        expect(result.status).not.toBe(0);
        expect(await readFile(fixture.stateFile, "utf8")).toBe(
            "sync:previous\n",
        );
        const log = await readFile(fixture.dockerLog, "utf8");
        expect(log).toContain("--remove-orphans");
        const evidence = await evidenceRecord(fixture);
        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "api_activation",
            migrationVerified: true,
            recoveryVerified: true,
            rolesVerified: false,
            rollbackStatus: "succeeded",
        });
    });

    it("restores the previous async revision without changing Queue identity", async () => {
        const fixture = await createFixture({
            failApiActivation: true,
            initialShape: "async",
        });

        const result = runDeployment(fixture);

        expect(result.status).not.toBe(0);
        expect(await readFile(fixture.stateFile, "utf8")).toBe(
            "async:previous\n",
        );
        const log = await readFile(fixture.dockerLog, "utf8");
        expect(log).not.toContain("--remove-orphans");
        const evidence = await evidenceRecord(fixture);
        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "api_activation",
            previousShape: "async",
            previousRevision: PREVIOUS,
            rollbackStatus: "succeeded",
        });
    });

    it("rolls back an interrupted release after background activation", async () => {
        const fixture = await createFixture({
            interruptAfterBackground: true,
        });

        const result = runDeployment(fixture);

        expect(result.status).toBe(143);
        expect(await readFile(fixture.stateFile, "utf8")).toBe(
            "sync:previous\n",
        );
        const evidence = await evidenceRecord(fixture);
        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "interrupted_TERM",
            previousShape: "sync",
            rollbackStatus: "succeeded",
        });
        expect(
            await pathExists(
                path.join(fixture.appRoot, "shared", ".async-release-work"),
            ),
        ).toBe(false);
    });

    it("reports rollback failure when the previous Compose snapshot cannot be installed", async () => {
        const fixture = await createFixture({
            failApiActivation: true,
            failRollbackInstall: true,
        });

        const result = runDeployment(fixture);

        expect(result.status).not.toBe(0);
        expect(await readFile(fixture.stateFile, "utf8")).toBe(
            "async:candidate\n",
        );
        const evidence = await evidenceRecord(fixture);
        expect(evidence).toMatchObject({
            status: "failed",
            failedGate: "api_activation",
            rollbackStatus: "failed",
        });
    });

    async function createFixture(options?: {
        failDatabaseAudit?: boolean;
        failApiActivation?: boolean;
        failRollbackInstall?: boolean;
        initialShape?: "sync" | "async";
        interruptAfterBackground?: boolean;
    }): Promise<Fixture> {
        const directory = await mkdtemp(
            path.join(tmpdir(), "pipipi-async-release-"),
        );
        temporaryDirectories.push(directory);
        const appRoot = path.join(directory, "app");
        const shared = path.join(appRoot, "shared");
        const binaries = path.join(directory, "bin");
        const dockerLog = path.join(directory, "docker.log");
        const stateFile = path.join(directory, "state");
        await Promise.all([
            mkdir(shared, { recursive: true }),
            mkdir(binaries),
        ]);
        const initialShape = options?.initialShape ?? "sync";
        await writeFile(stateFile, `${initialShape}:previous\n`);
        await Promise.all(
            [
                ".env",
                "async-api.env",
                "process-dispatcher.env",
                "process-worker.env",
                "webhook-worker.env",
                "retention-cleaner.env",
                "pg-server.crt",
                "compose.production.yaml",
            ].map((name) => writeFile(path.join(shared, name), "fixture\n")),
        );
        if (initialShape === "async") {
            await writeFile(
                path.join(shared, "compose.production.async.yaml"),
                "services: {}\n",
            );
        }
        // GitHub's run ID is globally unique. Preserve that production
        // invariant when Vitest files or separate test processes share /tmp.
        const releaseRunId = String(process.pid * 10_000 + releaseSequence++);
        const candidatePrefix = `/tmp/pipipi-async-${releaseRunId}-1`;
        const archive = `${candidatePrefix}.image.tar.gz`;
        const baseCompose = `${candidatePrefix}.compose.yaml`;
        const asyncCompose = `${candidatePrefix}.compose.async.yaml`;
        temporaryFiles.push(archive, baseCompose, asyncCompose);
        await Promise.all([
            writeFile(archive, gzipSync("image")),
            writeFile(baseCompose, "services: {}\n"),
            writeFile(asyncCompose, "services: {}\n"),
            writeExecutable(path.join(binaries, "docker"), fakeDocker),
            writeExecutable(path.join(binaries, "curl"), fakeCurl),
            writeExecutable(path.join(binaries, "flock"), fakeFlock),
            writeExecutable(path.join(binaries, "install"), fakeInstall),
        ]);
        return {
            appRoot,
            archive,
            baseCompose,
            asyncCompose,
            binaries,
            dockerLog,
            stateFile,
            failApiActivation: options?.failApiActivation ?? false,
            failDatabaseAudit: options?.failDatabaseAudit ?? false,
            failRollbackInstall: options?.failRollbackInstall ?? false,
            interruptAfterBackground:
                options?.interruptAfterBackground ?? false,
            releaseRunId,
        };
    }
});

type Fixture = Readonly<{
    appRoot: string;
    archive: string;
    baseCompose: string;
    asyncCompose: string;
    binaries: string;
    dockerLog: string;
    stateFile: string;
    failApiActivation: boolean;
    failDatabaseAudit: boolean;
    failRollbackInstall: boolean;
    interruptAfterBackground: boolean;
    releaseRunId: string;
}>;

function runDeployment(fixture: Fixture) {
    return spawnSync(
        "bash",
        [
            "ops/deploy-async-internal.sh",
            fixture.appRoot,
            CANDIDATE,
            "1234",
            fixture.releaseRunId,
            "1",
            "backup:test",
            "operator:test",
            fixture.archive,
            fixture.baseCompose,
            fixture.asyncCompose,
            "process-runs",
            "pipipi-internal",
            "webhook-deliveries",
            "pipipi-internal",
        ],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${fixture.binaries}:${process.env.PATH}`,
                FAKE_CANDIDATE: CANDIDATE,
                FAKE_DOCKER_LOG: fixture.dockerLog,
                FAKE_DOCKER_STATE: fixture.stateFile,
                FAKE_FAIL_API: fixture.failApiActivation ? "true" : "false",
                FAKE_FAIL_DATABASE_AUDIT: fixture.failDatabaseAudit
                    ? "true"
                    : "false",
                FAKE_FAIL_ROLLBACK_INSTALL: fixture.failRollbackInstall
                    ? "true"
                    : "false",
                FAKE_INTERRUPT_BACKGROUND: fixture.interruptAfterBackground
                    ? "true"
                    : "false",
                FAKE_PREVIOUS: PREVIOUS,
            },
        },
    );
}

async function evidenceRecord(
    fixture: Fixture,
): Promise<Record<string, unknown>> {
    const source = await readFile(
        path.join(
            fixture.appRoot,
            "shared",
            "async-release-evidence",
            `${CANDIDATE}-${fixture.releaseRunId}-1`,
            "evidence.json",
        ),
        "utf8",
    );
    return JSON.parse(source) as Record<string, unknown>;
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await access(target);
        return true;
    } catch {
        return false;
    }
}

async function writeExecutable(file: string, source: string): Promise<void> {
    await writeFile(file, source);
    await chmod(file, 0o755);
}

function expectOrdered(source: string, values: readonly string[]): void {
    let previous = -1;
    for (const value of values) {
        const current = source.indexOf(value);
        expect(current, `missing or misordered ${value}`).toBeGreaterThan(
            previous,
        );
        previous = current;
    }
}

const fakeDocker = String.raw`#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
state="$(tr -d '\n' < "$FAKE_DOCKER_STATE")"

if [ "$1" = "compose" ]; then
    if [[ " $* " == *" up "* ]]; then
        if [ "$PIPIPI_IMAGE" = "pipipi:$FAKE_CANDIDATE" ]; then revision_state='candidate'; else revision_state='previous'; fi
        if [[ " $* " == *" --remove-orphans "* ]]; then
            printf 'sync:%s\n' "$revision_state" > "$FAKE_DOCKER_STATE"
        else
            printf 'async:%s\n' "$revision_state" > "$FAKE_DOCKER_STATE"
            if [ "$FAKE_INTERRUPT_BACKGROUND" = "true" ] && [[ " $* " != *" --no-deps api "* ]]; then
                kill -TERM "$PPID"
                exit 0
            fi
            if [ "$FAKE_FAIL_API" = "true" ] && [[ " $* " == *" --no-deps api "* ]]; then
                exit 19
            fi
        fi
    fi
    exit 0
fi

if [ "$1" = "load" ]; then
    cat >/dev/null
    exit 0
fi

if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    printf 'sha256:%064d\n' 0 | tr '0' 'b'
    exit 0
fi

if [ "$1" = "inspect" ]; then
    container="$2"
    if [[ "$container" == pipipi-process-* || "$container" == pipipi-webhook-worker || "$container" == pipipi-retention-cleaner ]]; then
        [[ "$state" == async:* ]] || exit 1
    fi
    if [[ " $* " == *".Config.Image"* ]]; then
        if [[ "$state" == *:candidate ]]; then
            printf 'pipipi:%s\n' "$FAKE_CANDIDATE"
        else
            printf 'pipipi:%s\n' "$FAKE_PREVIOUS"
        fi
    elif [[ " $* " == *"com.pipipi.revision"* ]]; then
        if [[ "$state" == *:candidate ]]; then printf '%s\n' "$FAKE_CANDIDATE"; else printf '%s\n' "$FAKE_PREVIOUS"; fi
    elif [[ " $* " == *"range .Config.Env"* ]]; then
        printf '%s\n' \
            'ASYNC_RELEASE_STAGE=internal' \
            'ASYNC_PROCESS_RUNS_ENABLED=true' \
            'PROCESS_QUEUE_NAME=process-runs' \
            'PROCESS_QUEUE_PREFIX=pipipi-internal' \
            'WEBHOOK_QUEUE_NAME=webhook-deliveries' \
            'WEBHOOK_QUEUE_PREFIX=pipipi-internal'
    elif [[ " $* " == *".Image"* ]]; then
        printf 'sha256:%064d\n' 0 | tr '0' 'b'
    fi
    exit 0
fi

if [ "$1" = "run" ]; then
    payload="$(cat)"
    [[ " $* " != *" pipipi:$FAKE_CANDIDATE "* ]]
    if [[ " $* " == *" audit:production-database "* || " $* " == *" migrate-and-verify.js "* || " $* " == *" recover.js --dry-run --mode=all "* ]]; then
        [[ " $* " == *" --network host "* ]]
    fi
    if [[ " $* " == *" audit:production-database "* ]]; then
        if [ "$FAKE_FAIL_DATABASE_AUDIT" = true ]; then
            printf '%s\n' 'connection to database.internal failed for database-secret' >&2
            exit 1
        fi
        printf '%s\n' '{"event":"production_database_identity_verified","databaseIdentitySha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","tlsVerified":true,"dedicatedDatabaseVerified":true,"nonSuperuserVerified":true,"administrativePrivilegesAbsent":true,"otherDatabaseAccessAbsent":true,"roleMembershipAbsent":true,"roleSwitchingAbsent":true}'
    elif [[ " $* " == *"database_migration_verified"* ]]; then
        printf '0'
    elif [[ " $* " == *"process_queue_recovery_batch_completed"* ]]; then
        printf '1 0'
    elif [[ " $* " == *"migrate-and-verify.js"* ]]; then
        printf '%s\n' '{"event":"database_migration_verified","appliedCount":0,"verificationCount":0}'
    elif [[ " $* " == *"recover.js --dry-run --mode=all"* ]]; then
        printf '%s\n' '{"event":"process_queue_recovery_batch_completed","trigger":"manual","mode":"all","dryRun":true,"failed":0}'
    else
        printf '%s\n' '{"event":"deployment_environment_check_passed","requiredVariables":[]}'
    fi
    : "$payload"
    exit 0
fi

exit 2
`;

const fakeCurl = String.raw`#!/usr/bin/env bash
set -eu
printf '%s\n' '{"status":"ready"}'
`;

const fakeFlock = `#!/usr/bin/env bash
set -eu
exit 0
`;

const fakeInstall = `#!/usr/bin/env bash
set -eu
if [ "$FAKE_FAIL_ROLLBACK_INSTALL" = "true" ] && [[ " $* " == *"previous.compose.yaml"* ]]; then
    exit 27
fi
exec /usr/bin/install "$@"
`;
