import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    combineProcessRunLogSinks,
    type ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import {
    createJsonlProcessRunActivityArchive,
    pruneProcessRunActivities,
} from "../src/run-observation/jsonl.js";

const fixedClock = () => new Date("2026-08-11T10:00:00.000Z");

async function createDirectory(): Promise<string> {
    return mkdtemp(join(tmpdir(), "pipipi-activities-"));
}

function activity(
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

describe("JSONL Process Run Activity Archive", () => {
    it("reconstructs an Attempt timeline for one Run", async () => {
        const directory = await createDirectory();
        const archive = createJsonlProcessRunActivityArchive({
            directory,
            clock: fixedClock,
        });

        archive.record(activity({ sequence: 1 }));
        archive.record(
            activity({
                sequence: 2,
                event: "process_run_activity_started",
                activity: "news_image_rendering",
            }),
        );
        archive.record(
            activity({
                sequence: 3,
                event: "process_run_activity_finished",
                activity: "news_image_rendering",
                outcome: "succeeded",
                durationMs: 41_230,
            }),
        );
        archive.record(activity({ runId: "other-run", sequence: 1 }));
        await archive.flush();

        const timeline = await archive.findByRun("run-1");

        expect(timeline.map((entry) => entry.event)).toEqual([
            "process_run_attempt_started",
            "process_run_activity_started",
            "process_run_activity_finished",
        ]);
        expect(timeline.at(-1)).toMatchObject({ durationMs: 41_230 });
    });

    it("orders a multi-Attempt Run by attempt then sequence", async () => {
        const directory = await createDirectory();
        const archive = createJsonlProcessRunActivityArchive({
            directory,
            clock: fixedClock,
        });

        archive.record(activity({ attemptNumber: 2, sequence: 1 }));
        archive.record(activity({ attemptNumber: 1, sequence: 2 }));
        archive.record(activity({ attemptNumber: 1, sequence: 1 }));
        await archive.flush();

        expect(
            (await archive.findByRun("run-1")).map(
                (entry) => `${entry.attemptNumber}:${entry.sequence}`,
            ),
        ).toEqual(["1:1", "1:2", "2:1"]);
    });

    it("keeps the timeline readable after the writing process is gone", async () => {
        const directory = await createDirectory();
        const writer = createJsonlProcessRunActivityArchive({
            directory,
            clock: fixedClock,
        });
        writer.record(activity());
        await writer.flush();

        const reader = createJsonlProcessRunActivityArchive({
            directory,
            clock: fixedClock,
        });

        expect(await reader.findByRun("run-1")).toHaveLength(1);
    });

    it("writes activities to their own day files", async () => {
        const directory = await createDirectory();
        const archive = createJsonlProcessRunActivityArchive({
            directory,
            clock: fixedClock,
        });

        archive.record(activity({ timestamp: "2026-08-10T23:59:59.000Z" }));
        archive.record(activity({ timestamp: "2026-08-11T00:00:01.000Z" }));
        await archive.flush();

        expect((await readdir(directory)).sort()).toEqual([
            "activities-2026-08-10.jsonl",
            "activities-2026-08-11.jsonl",
        ]);
    });

    it("skips an unreadable line instead of failing the read", async () => {
        const directory = await createDirectory();
        await writeFile(
            join(directory, "activities-2026-08-11.jsonl"),
            `${JSON.stringify(activity())}\nnot json\n{"schemaVersion":2}\n`,
            "utf8",
        );
        const archive = createJsonlProcessRunActivityArchive({
            directory,
            clock: fixedClock,
        });

        expect(await archive.findByRun("run-1")).toHaveLength(1);
    });

    it("ignores and prunes day files outside the retention window", async () => {
        const directory = await createDirectory();
        await writeFile(
            join(directory, "activities-2026-07-01.jsonl"),
            `${JSON.stringify(activity({ runId: "old", timestamp: "2026-07-01T00:00:00.000Z" }))}\n`,
            "utf8",
        );
        await writeFile(
            join(directory, "activities-2026-08-11.jsonl"),
            `${JSON.stringify(activity({ runId: "recent" }))}\n`,
            "utf8",
        );

        const archive = createJsonlProcessRunActivityArchive({
            directory,
            retentionDays: 7,
            clock: fixedClock,
        });
        expect(await archive.findByRun("old")).toEqual([]);
        expect(await archive.findByRun("recent")).toHaveLength(1);

        await pruneProcessRunActivities({
            directory,
            retentionDays: 7,
            clock: fixedClock,
        });
        expect(await readdir(directory)).toEqual([
            "activities-2026-08-11.jsonl",
        ]);
    });

    it("does not share day files with the Run Record archive", async () => {
        const directory = await createDirectory();
        const archive = createJsonlProcessRunActivityArchive({
            directory,
            clock: fixedClock,
        });

        archive.record(activity());
        await archive.flush();

        expect(await readdir(directory)).toEqual([
            "activities-2026-08-11.jsonl",
        ]);
    });
});

describe("combined Process Run log Sinks", () => {
    it("delivers each record to every Sink", () => {
        const first: ProcessRunLogRecord[] = [];
        const second: ProcessRunLogRecord[] = [];
        const sink = combineProcessRunLogSinks(
            (record) => first.push(record),
            (record) => second.push(record),
        );

        sink(activity());

        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
    });

    it("isolates a failing Sink from the others", () => {
        const delivered: ProcessRunLogRecord[] = [];
        const sink = combineProcessRunLogSinks(
            () => {
                throw new Error("destination is down");
            },
            (record) => delivered.push(record),
        );

        expect(() => sink(activity())).not.toThrow();
        expect(delivered).toHaveLength(1);
    });
});
