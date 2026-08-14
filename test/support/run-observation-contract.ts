import { expect, it } from "vitest";
import type { ProcessRunActivityArchive } from "../../src/app/process-run-activities.js";
import type { ProcessRunRecordArchive } from "../../src/app/process-run-records.js";
import type { RunObservationStats } from "../../src/app/run-observation-stats.js";
import type { ProcessRunLogRecord } from "../../src/process-runtime/index.js";
import type { ProcessRunRecord } from "../../src/process-runtime/records.js";

export type ObservationBackend = Readonly<{
    archive: ProcessRunRecordArchive;
    activities: ProcessRunActivityArchive;
    stats: RunObservationStats;
    /** Resolves once every best-effort write has settled. */
    settle: () => Promise<void>;
}>;

export function processRunRecord(
    overrides: Partial<ProcessRunRecord> = {},
): ProcessRunRecord {
    return {
        schemaVersion: 1,
        recordedAt: "2026-08-11T10:00:00.000Z",
        runId: "run-1",
        process: "news-image-pale-watercolor",
        version: "v1",
        status: "succeeded",
        ...overrides,
    } as ProcessRunRecord;
}

export function processRunActivity(
    overrides: Partial<ProcessRunLogRecord> = {},
): ProcessRunLogRecord {
    return {
        schemaVersion: 1,
        timestamp: "2026-08-11T10:00:00.000Z",
        runId: "run-1",
        process: "news-image-pale-watercolor",
        version: "v1",
        attemptNumber: 1,
        sequence: 1,
        event: "process_run_attempt_started",
        ...overrides,
    } as ProcessRunLogRecord;
}

/**
 * The behaviour every Run observation storage must provide, run against each
 * Implementation. Operators read the same console against either backend, so a
 * difference here is a difference they would see.
 */
export function describeRunObservationContract(
    createBackend: () => Promise<ObservationBackend>,
): void {
    it("reads back a stored record", async () => {
        const { archive } = await createBackend();

        await archive.store(processRunRecord({ runId: "read-back" }));

        expect(await archive.find("read-back")).toMatchObject({
            runId: "read-back",
            process: "news-image-pale-watercolor",
            status: "succeeded",
        });
    });

    it("reports an unknown record as absent", async () => {
        const { archive } = await createBackend();

        expect(await archive.find("never-stored")).toBeUndefined();
    });

    it("keeps business content when the record carries it", async () => {
        const { archive } = await createBackend();

        await archive.store(
            processRunRecord({
                runId: "with-content",
                content: {
                    input: { title: "标题", summary: "摘要" },
                    output: { style: "pale-watercolor" },
                },
            }),
        );

        expect((await archive.find("with-content"))?.content).toEqual({
            input: { title: "标题", summary: "摘要" },
            output: { style: "pale-watercolor" },
        });
    });

    it("keeps the failure code of a failed record", async () => {
        const { archive } = await createBackend();

        await archive.store(
            processRunRecord({
                runId: "failed-run",
                status: "failed",
                errorCode: "DEPENDENCY_FAILURE",
            }),
        );

        expect(await archive.find("failed-run")).toMatchObject({
            status: "failed",
            errorCode: "DEPENDENCY_FAILURE",
        });
    });

    it("replaces a replayed record with its latest outcome", async () => {
        const { archive } = await createBackend();

        await archive.store(
            processRunRecord({
                runId: "replayed",
                status: "failed",
                errorCode: "DEPENDENCY_FAILURE",
            }),
        );
        await archive.store(
            processRunRecord({
                runId: "replayed",
                recordedAt: "2026-08-11T10:00:05.000Z",
                status: "succeeded",
            }),
        );

        expect(await archive.find("replayed")).toMatchObject({
            status: "succeeded",
        });
    });

    it("stores only a digest of a CRT source image URL", async () => {
        const { archive } = await createBackend();

        await archive.store(
            processRunRecord({
                runId: "crt-run",
                process: "crt-interface-image",
                content: {
                    input: {
                        sourceImageUrl: "https://assets.example.com/source.png",
                        palette: "经典",
                    },
                },
            }),
        );

        const input = (await archive.find("crt-run"))?.content?.input as Record<
            string,
            unknown
        >;
        expect(input.sourceImageUrl).toBeUndefined();
        expect(input.sourceImageUrlSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(input.palette).toBe("经典");
    });

    it("lists records newest first", async () => {
        const { archive } = await createBackend();
        for (const [index, recordedAt] of [
            "2026-08-11T10:00:01.000Z",
            "2026-08-11T10:00:02.000Z",
            "2026-08-11T10:00:03.000Z",
        ].entries()) {
            await archive.store(
                processRunRecord({ runId: `run-${index + 1}`, recordedAt }),
            );
        }

        expect(
            (await archive.list()).records.map((entry) => entry.runId),
        ).toEqual(["run-3", "run-2", "run-1"]);
    });

    it("pages older records with the returned cursor", async () => {
        const { archive } = await createBackend();
        for (const [index, recordedAt] of [
            "2026-08-11T10:00:01.000Z",
            "2026-08-11T10:00:02.000Z",
            "2026-08-11T10:00:03.000Z",
        ].entries()) {
            await archive.store(
                processRunRecord({ runId: `run-${index + 1}`, recordedAt }),
            );
        }

        const first = await archive.list({ limit: 2 });
        expect(first.records.map((entry) => entry.runId)).toEqual([
            "run-3",
            "run-2",
        ]);
        expect(first.nextBefore).toBeDefined();

        const second = await archive.list({
            limit: 2,
            ...(first.nextBefore === undefined
                ? {}
                : { before: first.nextBefore }),
        });
        expect(second.records.map((entry) => entry.runId)).toEqual(["run-1"]);
        expect(second.nextBefore).toBeUndefined();
    });

    it("does not skip records that share the cursor timestamp", async () => {
        const { archive } = await createBackend();
        for (const runId of ["same-a", "same-b", "same-c"]) {
            await archive.store(
                processRunRecord({
                    runId,
                    recordedAt: "2026-08-11T10:00:00.000Z",
                }),
            );
        }

        const first = await archive.list({ limit: 2 });
        const second = await archive.list({
            limit: 2,
            ...(first.nextBefore ? { before: first.nextBefore } : {}),
        });

        expect(first.records.map((record) => record.runId)).toEqual([
            "same-c",
            "same-b",
        ]);
        expect(second.records.map((record) => record.runId)).toEqual([
            "same-a",
        ]);
    });

    it("lists only the latest outcome of a replayed run", async () => {
        const { archive } = await createBackend();
        await archive.store(
            processRunRecord({
                runId: "listed-replay",
                recordedAt: "2026-08-11T10:00:00.000Z",
                status: "failed",
                errorCode: "DEPENDENCY_FAILURE",
            }),
        );
        await archive.store(
            processRunRecord({
                runId: "listed-replay",
                recordedAt: "2026-08-11T10:00:01.000Z",
                status: "succeeded",
            }),
        );

        expect((await archive.list()).records).toEqual([
            expect.objectContaining({
                runId: "listed-replay",
                status: "succeeded",
            }),
        ]);
        expect((await archive.list({ status: "failed" })).records).toEqual([]);
    });

    it("returns an empty page when nothing is stored", async () => {
        const { archive } = await createBackend();

        expect((await archive.list()).records).toEqual([]);
    });

    it("combines Process, status, error-code, and time-range filters", async () => {
        const { archive } = await createBackend();
        for (const record of [
            processRunRecord({
                runId: "matching",
                recordedAt: "2026-08-11T10:30:00.000Z",
                process: "crt-interface-image",
                status: "failed",
                errorCode: "AGENT_FAILURE",
            }),
            processRunRecord({
                runId: "wrong-error",
                recordedAt: "2026-08-11T10:20:00.000Z",
                process: "crt-interface-image",
                status: "failed",
                errorCode: "DEPENDENCY_FAILURE",
            }),
            processRunRecord({
                runId: "too-old",
                recordedAt: "2026-08-11T09:59:59.999Z",
                process: "crt-interface-image",
                status: "failed",
                errorCode: "AGENT_FAILURE",
            }),
            processRunRecord({
                runId: "exclusive-end",
                recordedAt: "2026-08-11T11:00:00.000Z",
                process: "crt-interface-image",
                status: "failed",
                errorCode: "AGENT_FAILURE",
            }),
        ]) {
            await archive.store(record);
        }

        const page = await archive.list({
            process: "crt-interface-image",
            status: "failed",
            errorCode: "AGENT_FAILURE",
            since: "2026-08-11T10:00:00.000Z",
            until: "2026-08-11T11:00:00.000Z",
        });

        expect(page.records.map((record) => record.runId)).toEqual([
            "matching",
        ]);
    });

    it("keeps combined filters active across pagination", async () => {
        const { archive } = await createBackend();
        for (const [runId, recordedAt, errorCode] of [
            ["match-new", "2026-08-11T10:40:00.000Z", "AGENT_FAILURE"],
            ["match-old", "2026-08-11T10:20:00.000Z", "AGENT_FAILURE"],
            ["not-a-match", "2026-08-11T10:30:00.000Z", "DEPENDENCY_FAILURE"],
        ] as const) {
            await archive.store(
                processRunRecord({
                    runId,
                    recordedAt,
                    process: "crt-interface-image",
                    status: "failed",
                    errorCode,
                }),
            );
        }
        const filters = {
            process: "crt-interface-image",
            status: "failed" as const,
            errorCode: "AGENT_FAILURE",
            since: "2026-08-11T10:00:00.000Z",
            until: "2026-08-11T11:00:00.000Z",
        };

        const first = await archive.list({ ...filters, limit: 1 });
        const second = await archive.list({
            ...filters,
            limit: 1,
            ...(first.nextBefore ? { before: first.nextBefore } : {}),
        });

        expect(first.records.map((record) => record.runId)).toEqual([
            "match-new",
        ]);
        expect(second.records.map((record) => record.runId)).toEqual([
            "match-old",
        ]);
    });

    it("reconstructs an Attempt timeline ordered by attempt then sequence", async () => {
        const { activities, settle } = await createBackend();

        activities.record(
            processRunActivity({ attemptNumber: 2, sequence: 1 }),
        );
        activities.record(
            processRunActivity({ attemptNumber: 1, sequence: 2 }),
        );
        activities.record(
            processRunActivity({ attemptNumber: 1, sequence: 1 }),
        );
        activities.record(processRunActivity({ runId: "other", sequence: 1 }));
        await settle();

        expect(
            (await activities.findByRun("run-1")).map(
                (entry) => `${entry.attemptNumber}:${entry.sequence}`,
            ),
        ).toEqual(["1:1", "1:2", "2:1"]);
    });

    it("keeps activity detail needed to explain a failure", async () => {
        const { activities, settle } = await createBackend();

        activities.record(
            processRunActivity({
                sequence: 3,
                event: "process_run_activity_finished",
                activity: "crt_prompt_compilation",
                outcome: "failed",
                durationMs: 1_234,
            }),
        );
        activities.record(
            processRunActivity({
                sequence: 4,
                event: "process_run_attempt_finished",
                outcome: "failed",
                durationMs: 1_240,
                errorCode: "AGENT_FAILURE",
            }),
        );
        await settle();

        const timeline = await activities.findByRun("run-1");
        expect(timeline[0]).toMatchObject({
            activity: "crt_prompt_compilation",
            outcome: "failed",
            durationMs: 1_234,
        });
        expect(timeline[1]).toMatchObject({ errorCode: "AGENT_FAILURE" });
    });

    it("returns an empty timeline for an unknown run", async () => {
        const { activities } = await createBackend();

        expect(await activities.findByRun("never-ran")).toEqual([]);
    });

    it("counts outcomes per Process inside the window", async () => {
        const { archive, stats } = await createBackend();
        await archive.store(
            processRunRecord({ runId: "a", recordedAt: inWindow(1) }),
        );
        await archive.store(
            processRunRecord({ runId: "b", recordedAt: inWindow(2) }),
        );
        await archive.store(
            processRunRecord({
                runId: "c",
                recordedAt: inWindow(3),
                process: "crt-interface-image",
                status: "failed",
                errorCode: "AGENT_FAILURE",
            }),
        );

        const summary = await stats.summarise({ since: windowStart });

        expect(summary.totals).toEqual({ succeeded: 2, failed: 1 });
        expect(summary.byProcess).toEqual([
            {
                process: "news-image-pale-watercolor",
                version: "v1",
                succeeded: 2,
                failed: 0,
            },
            {
                process: "crt-interface-image",
                version: "v1",
                succeeded: 0,
                failed: 1,
            },
        ]);
        expect(summary.byErrorCode).toEqual([
            { errorCode: "AGENT_FAILURE", count: 1 },
        ]);
        expect(summary.byDay).toEqual([
            {
                day: "2026-08-11",
                succeeded: 2,
                failed: 1,
                byErrorCode: [{ errorCode: "AGENT_FAILURE", count: 1 }],
            },
        ]);
        expect(summary.recentFailures).toEqual([
            {
                runId: "c",
                recordedAt: inWindow(3),
                process: "crt-interface-image",
                version: "v1",
                errorCode: "AGENT_FAILURE",
            },
        ]);
    });

    it("excludes records older than the window", async () => {
        const { archive, stats } = await createBackend();
        await archive.store(
            processRunRecord({
                runId: "old",
                recordedAt: "2026-08-01T00:00:00.000Z",
            }),
        );
        await archive.store(
            processRunRecord({ runId: "new", recordedAt: inWindow(1) }),
        );

        expect((await stats.summarise({ since: windowStart })).totals).toEqual({
            succeeded: 1,
            failed: 0,
        });
    });

    it("counts only the latest outcome of a replayed run", async () => {
        const { archive, stats } = await createBackend();
        await archive.store(
            processRunRecord({
                runId: "stats-replay",
                recordedAt: inWindow(1),
                status: "failed",
                errorCode: "DEPENDENCY_FAILURE",
            }),
        );
        await archive.store(
            processRunRecord({
                runId: "stats-replay",
                recordedAt: inWindow(2),
                status: "succeeded",
            }),
        );

        const summary = await stats.summarise({ since: windowStart });

        expect(summary.totals).toEqual({ succeeded: 1, failed: 0 });
        expect(summary.byErrorCode).toEqual([]);
        expect(summary.recentFailures).toEqual([]);
    });

    it("summarises Attempt durations from finished Attempts only", async () => {
        const { activities, stats, settle } = await createBackend();
        for (const [index, durationMs] of [10, 20, 30, 40].entries()) {
            activities.record(
                processRunActivity({
                    runId: `run-${index}`,
                    timestamp: inWindow(index + 1),
                    sequence: 4,
                    event: "process_run_attempt_finished",
                    outcome: "succeeded",
                    durationMs,
                }),
            );
        }
        // An activity-level duration must not be counted as an Attempt.
        activities.record(
            processRunActivity({
                runId: "run-9",
                timestamp: inWindow(5),
                sequence: 3,
                event: "process_run_activity_finished",
                activity: "news_image_rendering",
                outcome: "succeeded",
                durationMs: 9_999,
            }),
        );
        await settle();

        const duration = (await stats.summarise({ since: windowStart }))
            .attemptDurationMs;

        expect(duration.samples).toBe(4);
        expect(duration.max).toBe(40);
        expect(duration.p50).toBe(20);
        expect(duration.p95).toBe(40);
    });

    it("reports an empty summary when the window holds nothing", async () => {
        const { stats } = await createBackend();

        const summary = await stats.summarise({ since: windowStart });

        expect(summary.totals).toEqual({ succeeded: 0, failed: 0 });
        expect(summary.byProcess).toEqual([]);
        expect(summary.byErrorCode).toEqual([]);
        expect(summary.byDay).toEqual([]);
        expect(summary.recentFailures).toEqual([]);
        expect(summary.attemptDurationMs).toEqual({ samples: 0 });
    });
}

const windowStart = "2026-08-11T00:00:00.000Z";

function inWindow(minute: number): string {
    return `2026-08-11T09:${String(minute).padStart(2, "0")}:00.000Z`;
}
