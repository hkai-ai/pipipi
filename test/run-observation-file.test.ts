import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { createJsonlProcessRunActivityArchive } from "../src/app/process-run-activities.js";
import { createJsonlProcessRunRecordArchive } from "../src/app/process-run-records.js";
import { describeRunObservationContract } from "./support/run-observation-contract.js";

const clock = () => new Date("2026-08-11T10:00:00.000Z");

describe("Run observation contract: JSONL files", () => {
    describeRunObservationContract(async () => {
        const directory = await mkdtemp(join(tmpdir(), "pipipi-observation-"));
        return {
            archive: createJsonlProcessRunRecordArchive({ directory, clock }),
            activities: createJsonlProcessRunActivityArchive({
                directory,
                clock,
            }),
            settle: () => new Promise((resolve) => setTimeout(resolve, 10)),
        };
    });
});
