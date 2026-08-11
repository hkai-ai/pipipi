import { expect, it } from "vitest";
import type { ProcessRunActivityArchive } from "../../src/app/process-run-activities.js";
import type { ProcessRunRecordArchive } from "../../src/app/process-run-records.js";
import type { ProcessRunLogRecord } from "../../src/process-runtime/index.js";
import type { ProcessRunRecord } from "../../src/process-runtime/records.js";

export type ObservationBackend = Readonly<{
    archive: ProcessRunRecordArchive;
    activities: ProcessRunActivityArchive;
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

    it("returns an empty page when nothing is stored", async () => {
        const { archive } = await createBackend();

        expect((await archive.list()).records).toEqual([]);
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
}
