import { describe, expect, it } from "vitest";
import { compareAttemptActivities } from "./activity-comparison.js";
import type { ProcessRunLogRecord } from "./api.js";

describe("Attempt activity comparison", () => {
    it.each([
        [["compile", "render"], "matched"],
        [["compile"], "ended-early"],
        [["render"], "diverged"],
    ] as const)("classifies %j as %s", (actual, outcome) => {
        const timeline = actual.map((activity, index) =>
            startedActivity(activity, index + 2),
        );

        expect(
            compareAttemptActivities(["compile", "render"], timeline),
        ).toEqual([
            {
                attemptNumber: 1,
                actual,
                outcome,
            },
        ]);
    });

    it("keeps retry Attempts separate and includes an Attempt that ended before its first activity", () => {
        const timeline: ProcessRunLogRecord[] = [
            attemptStarted(1),
            startedActivity("compile", 2, 1),
            attemptStarted(2),
        ];

        expect(
            compareAttemptActivities(["compile", "render"], timeline),
        ).toEqual([
            {
                attemptNumber: 1,
                actual: ["compile"],
                outcome: "ended-early",
            },
            {
                attemptNumber: 2,
                actual: [],
                outcome: "ended-early",
            },
        ]);
    });
});

function attemptStarted(attemptNumber: number): ProcessRunLogRecord {
    return {
        schemaVersion: 1,
        timestamp: "2026-08-11T10:00:00.000Z",
        runId: "run-1",
        process: "example",
        version: "v1",
        attemptNumber,
        sequence: 1,
        event: "process_run_attempt_started",
    };
}

function startedActivity(
    activity: string,
    sequence: number,
    attemptNumber = 1,
): ProcessRunLogRecord {
    return {
        ...attemptStarted(attemptNumber),
        sequence,
        event: "process_run_activity_started",
        activity,
    };
}
