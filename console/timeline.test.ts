import { describe, expect, it } from "vitest";
import type { ProcessRunLogRecord } from "./api.js";
import { eventTitle, groupAttempts } from "./timeline.jsx";

const base = {
    schemaVersion: 1,
    runId: "run-1",
    process: "character-emoji",
    version: "v2",
    timestamp: "2026-11-02T00:00:00.000Z",
    attemptNumber: 1,
    sequence: 1,
} as const;

describe("execution timeline presentation", () => {
    it("keeps retries separate and orders events by sequence", () => {
        const events: ProcessRunLogRecord[] = [
            {
                ...base,
                attemptNumber: 2,
                sequence: 2,
                event: "process_run_attempt_finished",
                outcome: "succeeded",
                durationMs: 30,
            },
            {
                ...base,
                sequence: 2,
                event: "process_run_attempt_finished",
                outcome: "failed",
                errorCode: "AGENT_FAILURE",
                durationMs: 20,
            },
            { ...base, event: "process_run_attempt_started" },
            { ...base, attemptNumber: 2, event: "process_run_attempt_started" },
        ];
        const attempts = groupAttempts(events);
        expect(
            attempts.map(({ number, outcome, durationMs }) => ({
                number,
                outcome,
                durationMs,
            })),
        ).toEqual([
            { number: 1, outcome: "failed", durationMs: 20 },
            { number: 2, outcome: "succeeded", durationMs: 30 },
        ]);
        expect(attempts[0].events.map((event) => event.sequence)).toEqual([
            1, 2,
        ]);
        expect(eventTitle(events[1])).toBe("执行结束 · 失败");
    });
    it("does not infer an overall result from a partial activity log", () => {
        const event = {
            ...base,
            event: "process_run_activity_finished",
            activity: "character_emoji_planning",
            outcome: "failed",
            durationMs: 15,
        } as const;
        const [attempt] = groupAttempts([event]);
        expect(attempt.outcome).toBeUndefined();
        expect(attempt.durationMs).toBeUndefined();
        expect(eventTitle(event)).toBe("构思表情包方案 · 失败");
        expect(eventTitle({ ...event, activity: "unmapped_stage" })).toBe(
            "业务处理步骤 · 失败",
        );
    });
});
