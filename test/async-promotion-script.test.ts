import { spawnSync } from "node:child_process";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REVISION = "d".repeat(40);
let runSequence = 81_000;

describe("Async staged promotion script", () => {
    const roots: string[] = [];
    const aggregates: string[] = [];

    afterEach(async () => {
        await Promise.all(
            roots
                .splice(0)
                .map((root) => rm(root, { recursive: true, force: true })),
        );
        await Promise.all(
            aggregates.splice(0).map((file) => rm(file, { force: true })),
        );
    });

    it("changes only stage from internal zero to canary zero", async () => {
        const fixture = await createFixture({ stage: "internal", traffic: 0 });
        const result = runPromotion(fixture, "promote", "stage", "canary", 0);

        expect(result.status, result.stderr).toBe(0);
        expect(await readFile(fixture.stageFile, "utf8")).toBe("canary\n");
        expect(await readFile(fixture.trafficFile, "utf8")).toBe("0\n");
        await expect(readEvidence(fixture)).resolves.toMatchObject({
            status: "succeeded",
            changedVariable: "stage",
            previousStage: "internal",
            targetStage: "canary",
            previousTrafficPercent: 0,
            targetTrafficPercent: 0,
            fiveRolesReady: true,
            roleReadinessBefore: expect.arrayContaining([
                { role: "api", readiness: "ready" },
                { role: "process-worker", readiness: "ready" },
            ]),
            roleReadinessAfter: expect.arrayContaining([
                { role: "api", readiness: "ready" },
                { role: "process-worker", readiness: "ready" },
            ]),
            ownerQueriesPreserved: true,
            compatibleWorkersPreserved: true,
            postgresStateDeleted: false,
        });
    });

    it("initializes a new candidate from internal zero despite stale prior state", async () => {
        const fixture = await createFixture({
            stage: "internal",
            traffic: 0,
            existingState: true,
            stateRevision: "c".repeat(40),
        });
        const result = runPromotion(fixture, "promote", "stage", "canary", 0);

        expect(result.status, result.stderr).toBe(0);
        await expect(readState(fixture)).resolves.toMatchObject({
            revision: REVISION,
            stage: "canary",
            trafficPercent: 0,
        });
    });

    it("advances one approved canary traffic percentage without recreating API", async () => {
        const fixture = await createFixture({
            stage: "canary",
            traffic: 0,
            existingState: true,
        });
        const result = runPromotion(fixture, "promote", "traffic", "canary", 1);

        expect(result.status, result.stderr).toBe(0);
        expect(await readFile(fixture.stageFile, "utf8")).toBe("canary\n");
        expect(await readFile(fixture.trafficFile, "utf8")).toBe("1\n");
        expect(await readFile(fixture.dockerLog, "utf8")).not.toContain(
            "compose",
        );
        await expect(readEvidence(fixture)).resolves.toMatchObject({
            changedVariable: "traffic",
            previousTrafficPercent: 0,
            targetTrafficPercent: 1,
        });
    });

    it("rejects a skipped canary percentage without changing state", async () => {
        const fixture = await createFixture({
            stage: "canary",
            traffic: 0,
            existingState: true,
        });
        const result = runPromotion(
            fixture,
            "promote",
            "traffic",
            "canary",
            25,
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("adjacent approved percentage");
        expect(await readFile(fixture.trafficFile, "utf8")).toBe("0\n");
        await expect(readEvidence(fixture)).resolves.toMatchObject({
            status: "failed",
            failedGate: "transition",
            rollbackStatus: "not_required",
        });
    });

    it("restores previous traffic when the post-change critical gate fails", async () => {
        const fixture = await createFixture({
            stage: "canary",
            traffic: 0,
            existingState: true,
            failCriticalAfterChange: true,
        });
        const result = runPromotion(fixture, "promote", "traffic", "canary", 1);

        expect(result.status).not.toBe(0);
        expect(await readFile(fixture.trafficFile, "utf8")).toBe("0\n");
        await expect(readEvidence(fixture)).resolves.toMatchObject({
            status: "failed",
            failedGate: "postchange_gates",
            rollbackStatus: "succeeded",
        });
        await expect(readState(fixture)).resolves.toMatchObject({
            stage: "canary",
            trafficPercent: 0,
        });
    });

    it("promotes canary twenty-five to production only after the observation window", async () => {
        const fixture = await createFixture({
            stage: "canary",
            traffic: 25,
            existingState: true,
        });
        const result = runPromotion(
            fixture,
            "promote",
            "stage",
            "production",
            25,
        );

        expect(result.status, result.stderr).toBe(0);
        expect(await readFile(fixture.stageFile, "utf8")).toBe("production\n");
        expect(await readFile(fixture.trafficFile, "utf8")).toBe("25\n");
        await expect(readEvidence(fixture)).resolves.toMatchObject({
            status: "succeeded",
            previousStage: "canary",
            targetStage: "production",
        });
    });

    it("rejects production before the approved observation window has elapsed", async () => {
        const fixture = await createFixture({
            stage: "canary",
            traffic: 25,
            existingState: true,
            changedAt: "2999-01-01T00:00:00Z",
        });
        const result = runPromotion(
            fixture,
            "promote",
            "stage",
            "production",
            25,
        );

        expect(result.status).not.toBe(0);
        expect(await readFile(fixture.stageFile, "utf8")).toBe("canary\n");
        await expect(readEvidence(fixture)).resolves.toMatchObject({
            status: "failed",
            failedGate: "transition",
            rollbackStatus: "not_required",
        });
    });

    it("rolls canary traffic back by one approved percentage", async () => {
        const fixture = await createFixture({
            stage: "canary",
            traffic: 25,
            existingState: true,
        });
        const result = runPromotion(
            fixture,
            "rollback",
            "traffic",
            "canary",
            5,
        );

        expect(result.status, result.stderr).toBe(0);
        expect(await readFile(fixture.trafficFile, "utf8")).toBe("5\n");
        expect(await readFile(fixture.criticalCountFile, "utf8")).toBe("0\n");
        await expect(readEvidence(fixture)).resolves.toMatchObject({
            status: "succeeded",
            direction: "rollback",
            previousTrafficPercent: 25,
            targetTrafficPercent: 5,
            criticalBefore: null,
            criticalAfter: null,
        });
    });

    async function createFixture(options: {
        stage: "internal" | "canary" | "production";
        traffic: number;
        existingState?: boolean;
        changedAt?: string;
        stateRevision?: string;
        failCriticalAfterChange?: boolean;
    }): Promise<Fixture> {
        const root = await mkdtemp(path.join(tmpdir(), "pipipi-promotion-"));
        roots.push(root);
        const shared = path.join(root, "shared");
        const control = path.join(shared, "async-control");
        const promotion = path.join(shared, "async-promotion");
        const fakeBin = path.join(root, "bin");
        await Promise.all([
            mkdir(control, { recursive: true }),
            mkdir(promotion, { recursive: true }),
            mkdir(fakeBin, { recursive: true }),
        ]);
        for (const file of requiredFiles) {
            await writeFile(path.join(shared, file), "fixture\n");
        }
        const stageFile = path.join(root, "stage");
        const trafficFile = path.join(root, "traffic");
        const criticalCountFile = path.join(root, "critical-count");
        const dockerLog = path.join(root, "docker.log");
        await Promise.all([
            writeFile(stageFile, `${options.stage}\n`),
            writeFile(trafficFile, `${options.traffic}\n`),
            writeFile(criticalCountFile, "0\n"),
            writeFile(dockerLog, ""),
        ]);
        await executable(path.join(fakeBin, "docker"), fakeDocker);
        await executable(
            path.join(fakeBin, "curl"),
            [
                "#!/usr/bin/env bash",
                "printf '%s\\n' '{\"status\":\"ready\"}'",
                "",
            ].join("\n"),
        );
        await executable(
            path.join(fakeBin, "flock"),
            ["#!/usr/bin/env bash", "exit 0", ""].join("\n"),
        );
        await executable(path.join(control, "set-traffic"), fakeTraffic);
        await executable(
            path.join(control, "check-critical-alerts"),
            fakeCriticalGate,
        );
        const runId = runSequence++;
        const aggregate = `/tmp/pipipi-async-promotion-${runId}-1.json`;
        aggregates.push(aggregate);
        await writeFile(aggregate, `${JSON.stringify(gateAggregate())}\n`);
        if (options.existingState) {
            await writeFile(
                path.join(promotion, "state.json"),
                `${JSON.stringify({
                    schemaVersion: 1,
                    revision: options.stateRevision ?? REVISION,
                    stage: options.stage,
                    trafficPercent: options.traffic,
                    changedAt: options.changedAt ?? "2020-01-01T00:00:00Z",
                    promotionRunId: runId - 1,
                    promotionRunAttempt: 1,
                })}\n`,
            );
        }
        return {
            root,
            stageFile,
            trafficFile,
            criticalCountFile,
            dockerLog,
            fakeBin,
            aggregate,
            runId,
            failCriticalAfterChange: options.failCriticalAfterChange ?? false,
        };
    }
});

function runPromotion(
    fixture: Fixture,
    direction: "promote" | "rollback",
    variable: "stage" | "traffic",
    targetStage: "internal" | "canary" | "production",
    targetTraffic: number,
) {
    return spawnSync(
        "bash",
        [
            "ops/promote-async-release.sh",
            fixture.root,
            REVISION,
            direction,
            variable,
            targetStage,
            String(targetTraffic),
            "3600",
            "operator:rollback",
            String(fixture.runId),
            "1",
            fixture.aggregate,
        ],
        {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
                PROMOTION_REVISION: REVISION,
                PROMOTION_STAGE_FILE: fixture.stageFile,
                PROMOTION_TRAFFIC_FILE: fixture.trafficFile,
                PROMOTION_CRITICAL_COUNT_FILE: fixture.criticalCountFile,
                PROMOTION_DOCKER_LOG: fixture.dockerLog,
                PROMOTION_FAIL_CRITICAL_AFTER: String(
                    fixture.failCriticalAfterChange,
                ),
            },
        },
    );
}

async function readEvidence(fixture: Fixture) {
    return JSON.parse(
        await readFile(
            path.join(
                fixture.root,
                "shared/async-promotion/evidence",
                `${REVISION}-${fixture.runId}-1/evidence.json`,
            ),
            "utf8",
        ),
    ) as unknown;
}

async function readState(fixture: Fixture) {
    return JSON.parse(
        await readFile(
            path.join(fixture.root, "shared/async-promotion/state.json"),
            "utf8",
        ),
    ) as unknown;
}

async function executable(file: string, contents: string) {
    await writeFile(file, contents);
    await chmod(file, 0o700);
}

function gateAggregate() {
    return {
        schemaVersion: 1,
        revision: REVISION,
        allEvidenceSameRevision: true,
        internalSmokePassed: true,
        dispatcherWorkerDrillPassed: true,
        redisRebuildDrillPassed: true,
        webhookObservabilityDrillPassed: true,
        migrationVerified: true,
        recoveryVerified: true,
        ownerQueriesVerified: true,
        fiveRolesReady: true,
        capacityWithinBudget: true,
        costWithinBudget: true,
        backupId: "backup-fixture",
        imageId: `sha256:${"0".repeat(64)}`,
        migrationAppliedCount: 8,
        recoveryBatchCount: 1,
        evidenceRuns: {
            internalRelease: 1,
            internalSmoke: 2,
            dispatcherWorkerDrill: 3,
            redisRebuildDrill: 4,
            webhookObservabilityDrill: 5,
        },
    };
}

const fakeDocker = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'printf \'%s\\n\' "$*" >> "$PROMOTION_DOCKER_LOG"',
    'if [ "$1" = inspect ]; then',
    '  container="$2"',
    '  format="$' + '{4:-}"',
    '  if [[ "$format" == *Config.Env* ]]; then',
    '    case "$container" in',
    '      pipipi) printf \'ASYNC_RELEASE_STAGE=%s\\nASYNC_PROCESS_RUNS_ENABLED=true\\n\' "$(<"$PROMOTION_STAGE_FILE")" ;;',
    "      pipipi-process-dispatcher|pipipi-process-worker) printf 'PROCESS_QUEUE_NAME=process-runs\\nPROCESS_QUEUE_PREFIX=pipipi\\n' ;;",
    "      pipipi-webhook-worker) printf 'WEBHOOK_QUEUE_NAME=webhook-deliveries\\nWEBHOOK_QUEUE_PREFIX=pipipi\\n' ;;",
    "    esac",
    '  elif [[ "$format" == *Image* ]]; then',
    "    printf 'sha256:%064d\\n' 0",
    "  else",
    "    printf '%s\\n' \"$PROMOTION_REVISION\"",
    "  fi",
    'elif [ "$1" = compose ]; then',
    '  printf \'%s\\n\' "$PIPIPI_ASYNC_RELEASE_STAGE" > "$PROMOTION_STAGE_FILE"',
    "fi",
    "",
].join("\n");

const fakeTraffic = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'if [ "$1" = get ]; then cat "$PROMOTION_TRAFFIC_FILE"; exit; fi',
    'test "$1" = set',
    'test "$2" = "$PROMOTION_REVISION"',
    'printf \'%s\\n\' "$3" > "$PROMOTION_TRAFFIC_FILE"',
    "",
].join("\n");

const fakeCriticalGate = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    'count="$(<"$PROMOTION_CRITICAL_COUNT_FILE")"',
    'count="$((count + 1))"',
    'printf \'%s\\n\' "$count" > "$PROMOTION_CRITICAL_COUNT_FILE"',
    'if [ "$PROMOTION_FAIL_CRITICAL_AFTER" = true ] && [ "$count" -gt 1 ]; then exit 1; fi',
    'printf \'{"schemaVersion":1,"revision":"%s","measuredAt":"%s","criticalAlertsClear":true,"capacityWithinBudget":true,"costWithinBudget":true,"snapshot":{"runs":{"queued":0,"running":0,"stuck":0},"outbox":{"oldestLagMs":0}}}\\n\' "$PROMOTION_REVISION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    "",
].join("\n");

const requiredFiles = [
    "compose.production.yaml",
    "compose.production.async.yaml",
    ".env",
    "async-api.env",
    "process-dispatcher.env",
    "process-worker.env",
    "webhook-worker.env",
    "retention-cleaner.env",
    "pg-server.crt",
];

type Fixture = Readonly<{
    root: string;
    stageFile: string;
    trafficFile: string;
    criticalCountFile: string;
    dockerLog: string;
    fakeBin: string;
    aggregate: string;
    runId: number;
    failCriticalAfterChange: boolean;
}>;
