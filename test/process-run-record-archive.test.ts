import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    createJsonlProcessRunRecordArchive,
    parseProcessRunRecordContent,
    pruneProcessRunRecords,
} from "../src/app/process-run-records.js";
import type { ProcessRunRecord } from "../src/process-runtime/records.js";
import { createProcessRunRecords } from "../src/process-runtime/records.js";

const directories: string[] = [];

afterEach(() => {
    directories.splice(0);
});

async function createDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pipipi-run-records-"));
    directories.push(directory);
    return directory;
}

function record(overrides: Partial<ProcessRunRecord> = {}): ProcessRunRecord {
    return {
        schemaVersion: 1,
        recordedAt: "2026-08-11T10:00:00.000Z",
        runId: "00000000-0000-4000-8000-000000000001",
        process: "news-image-pale-watercolor",
        version: "v1",
        status: "succeeded",
        ...overrides,
    };
}

describe("JSONL Process Run Record Archive", () => {
    it("keeps records readable after the writing process is gone", async () => {
        const directory = await createDirectory();

        const writer = createJsonlProcessRunRecordArchive({ directory });
        await writer.store(record());

        const reader = createJsonlProcessRunRecordArchive({ directory });
        const page = await reader.list();

        expect(page.records).toHaveLength(1);
        expect(page.records[0]?.runId).toBe(
            "00000000-0000-4000-8000-000000000001",
        );
    });

    it("writes one file per UTC day", async () => {
        const directory = await createDirectory();
        const archive = createJsonlProcessRunRecordArchive({
            directory,
            retentionDays: 30,
            clock: () => new Date("2026-08-11T10:00:00.000Z"),
        });

        await archive.store(record({ recordedAt: "2026-08-10T23:59:59.000Z" }));
        await archive.store(
            record({
                recordedAt: "2026-08-11T00:00:01.000Z",
                runId: "00000000-0000-4000-8000-000000000002",
            }),
        );

        expect((await readdir(directory)).sort()).toEqual([
            "runs-2026-08-10.jsonl",
            "runs-2026-08-11.jsonl",
        ]);
    });

    it("lists newest first and pages with before", async () => {
        const directory = await createDirectory();
        const archive = createJsonlProcessRunRecordArchive({
            directory,
            clock: () => new Date("2026-08-11T10:00:00.000Z"),
        });
        for (const [index, recordedAt] of [
            "2026-08-11T10:00:01.000Z",
            "2026-08-11T10:00:02.000Z",
            "2026-08-11T10:00:03.000Z",
        ].entries()) {
            await archive.store(
                record({ recordedAt, runId: `run-${index + 1}` }),
            );
        }

        const first = await archive.list({ limit: 2 });
        expect(first.records.map((entry) => entry.runId)).toEqual([
            "run-3",
            "run-2",
        ]);
        expect(first.nextBefore).toMatch(/^r1\./);

        const second = await archive.list({
            limit: 2,
            ...(first.nextBefore === undefined
                ? {}
                : { before: first.nextBefore }),
        });
        expect(second.records.map((entry) => entry.runId)).toEqual(["run-1"]);
        expect(second.nextBefore).toBeUndefined();
    });

    it("replaces a CRT source image URL with a digest", async () => {
        const directory = await createDirectory();
        const archive = createJsonlProcessRunRecordArchive({ directory });

        await archive.store(
            record({
                process: "crt-interface-image",
                content: {
                    input: {
                        sourceImageUrl: "https://assets.example.com/source.png",
                        palette: "经典",
                        aspectRatio: "4:3",
                    },
                    output: { aspectRatio: "4:3" },
                },
            }),
        );

        const stored = await readFile(
            join(directory, "runs-2026-08-11.jsonl"),
            "utf8",
        );
        expect(stored).not.toContain("https://assets.example.com/source.png");

        const input = (
            await archive.find("00000000-0000-4000-8000-000000000001")
        )?.content?.input as Record<string, unknown>;
        expect(input.sourceImageUrl).toBeUndefined();
        expect(input.sourceImageUrlSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(input.palette).toBe("经典");
    });

    it("skips an unreadable line instead of failing the read", async () => {
        const directory = await createDirectory();
        await writeFile(
            join(directory, "runs-2026-08-11.jsonl"),
            `${JSON.stringify(record())}\nnot json\n{"schemaVersion":2}\n`,
            "utf8",
        );
        const archive = createJsonlProcessRunRecordArchive({
            directory,
            clock: () => new Date("2026-08-11T10:00:00.000Z"),
        });

        expect((await archive.list()).records).toHaveLength(1);
    });

    it("ignores and prunes day files outside the retention window", async () => {
        const directory = await createDirectory();
        await writeFile(
            join(directory, "runs-2026-07-01.jsonl"),
            `${JSON.stringify(record({ recordedAt: "2026-07-01T00:00:00.000Z", runId: "old" }))}\n`,
            "utf8",
        );
        await writeFile(
            join(directory, "runs-2026-08-11.jsonl"),
            `${JSON.stringify(record({ runId: "recent" }))}\n`,
            "utf8",
        );
        const clock = () => new Date("2026-08-11T10:00:00.000Z");

        const archive = createJsonlProcessRunRecordArchive({
            directory,
            retentionDays: 7,
            clock,
        });
        expect(
            (await archive.list()).records.map((entry) => entry.runId),
        ).toEqual(["recent"]);
        expect(await archive.find("old")).toBeUndefined();

        await pruneProcessRunRecords({ directory, retentionDays: 7, clock });
        expect(await readdir(directory)).toEqual(["runs-2026-08-11.jsonl"]);
    });

    it("stores business content only when the content policy allows it", async () => {
        const directory = await createDirectory();
        const archive = createJsonlProcessRunRecordArchive({ directory });
        const records = createProcessRunRecords({
            adapter: archive,
            clock: () => "2026-08-11T10:00:00.000Z",
        });

        await records.record({
            result: {
                runId: "00000000-0000-4000-8000-000000000009",
                process: "content-processing",
                version: "v1",
                status: "succeeded",
                output: { content: "processed" },
            },
            acceptedRequest: { input: { content: "business input" } },
        });

        const stored = await archive.find(
            "00000000-0000-4000-8000-000000000009",
        );
        expect(stored?.content).toBeUndefined();
    });

    it("rejects an unknown content policy", () => {
        expect(parseProcessRunRecordContent("accepted-input-and-output")).toBe(
            "accepted-input-and-output",
        );
        expect(parseProcessRunRecordContent(undefined)).toBe("omit");
        expect(() => parseProcessRunRecordContent("everything")).toThrow(
            /PROCESS_RUN_RECORD_CONTENT/,
        );
    });

    it("rejects a non-positive retention window", async () => {
        const directory = await createDirectory();
        expect(() =>
            createJsonlProcessRunRecordArchive({ directory, retentionDays: 0 }),
        ).toThrow(/PROCESS_RUN_RECORD_RETENTION_DAYS/);
    });
});
