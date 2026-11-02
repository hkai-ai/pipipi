import { describe, expect, it } from "vitest";
import type { ProcessRunRecord, RunTimeline } from "./api.js";
import {
    describeTimeline,
    diagnosticSummary,
    explainError,
} from "./diagnostics.js";

const record: ProcessRunRecord = {
    schemaVersion: 1,
    runId: "run-1",
    process: "character-emoji",
    version: "v3",
    status: "failed",
    errorCode: "AGENT_FAILURE",
    recordedAt: "2026-11-02T02:00:00Z",
    content: {
        input: {
            secret: "private-input",
            url: "https://private.example/source",
        },
        output: { text: "private-output" },
    },
};
const base = {
    schemaVersion: 1,
    timestamp: record.recordedAt,
    runId: record.runId,
    process: "character-emoji",
    version: "v3",
    sequence: 1,
} as const;
describe("operator diagnostics", () => {
    it("uses the last Attempt, not an earlier recovered failure", () => {
        const timeline: RunTimeline = {
            runId: record.runId,
            activities: [
                {
                    ...base,
                    attemptNumber: 1,
                    event: "process_run_activity_finished",
                    activity: "compilation",
                    outcome: "failed",
                    durationMs: 50,
                },
                {
                    ...base,
                    attemptNumber: 2,
                    event: "process_run_attempt_finished",
                    outcome: "failed",
                    errorCode: "AGENT_FAILURE",
                    durationMs: 200,
                },
            ],
        };
        expect(describeTimeline(timeline)).toEqual({
            attempt: 2,
            durationMs: 200,
            failedActivity: undefined,
        });
        const summary = diagnosticSummary(record, timeline);
        expect(summary).toContain("run-1");
        expect(summary).toContain("200 ms");
        expect(summary).not.toMatch(/private-|https:|compilation/);
    });
    it("does not invent evidence or encourage replay after a side effect", () => {
        expect(describeTimeline()).toEqual({
            attempt: 0,
            failedActivity: undefined,
            durationMs: undefined,
        });
        expect(explainError("DEPENDENCY_FAILURE_AFTER_COMMIT").next).toContain(
            "不应直接重新生成",
        );
        expect(explainError("NEW_ERROR").next).toContain("不推断失败原因");
    });
});
