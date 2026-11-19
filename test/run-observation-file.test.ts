import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    createJsonlProcessRunActivityArchive,
    createJsonlProcessRunRecordArchive,
    createJsonlRunObservationStats,
} from "../src/run-observation/jsonl.js";
import { describeRunObservationContract } from "./support/run-observation-contract.js";

const clock = () => new Date("2026-08-11T10:00:00.000Z");

describe("Run observation contract: JSONL files", () => {
    describeRunObservationContract(async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-observation-"));
        const activities = createJsonlProcessRunActivityArchive({
            directory,
            clock,
        });
        return {
            archive: createJsonlProcessRunRecordArchive({ directory, clock }),
            activities,
            stats: createJsonlRunObservationStats({ directory, clock }),
            settle: activities.flush,
        };
    });
});

it("rejects malformed optional caller metadata while retaining old and valid JSONL records", async () => {
    const directory = await mkdtemp(
        join(tmpdir(), "pipipi-record-validation-"),
    );
    const base = {
        schemaVersion: 1,
        recordedAt: clock().toISOString(),
        status: "succeeded",
        process: "test",
        version: "v1",
    };
    const valid = [
        {},
        { callerId: "caller" },
        ...["api_key", "gateway", "anonymous"].map((authMethod) => ({
            callerId: "caller",
            authMethod,
        })),
    ];
    const invalid = [
        { callerId: "" },
        { callerId: " " },
        { callerId: 123 },
        { callerId: null },
        { authMethod: "invalid" },
        { authMethod: null },
        { authMethod: 123 },
    ];
    const rows = [...valid, ...invalid].map((metadata, index) => ({
        ...base,
        ...metadata,
        runId: `record-${index}`,
    }));
    try {
        await writeFile(
            join(directory, "runs-2026-08-11.jsonl"),
            `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        );
        const archive = createJsonlProcessRunRecordArchive({
            directory,
            clock,
        });
        expect((await archive.list()).records).toHaveLength(valid.length);
        for (let index = 0; index < rows.length; index++) {
            const record = await archive.find(`record-${index}`);
            if (index < valid.length) expect(record).toEqual(rows[index]);
            else expect(record).toBeUndefined();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
