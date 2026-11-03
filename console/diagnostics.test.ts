import { describe, expect, it } from "vitest";
import type { ProcessRunRecord, RunTimeline } from "./api.js";
import {
    describeTimeline,
    diagnosticSummary,
    explainError,
    explainRunFailure,
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
    it("keeps the public error explanation when an activity has only the default diagnostic", () => {
        const diagnostic = {
            stage: "execution",
            code: "internal_failure",
        } as const;
        for (const code of [
            "AGENT_FAILURE",
            "INVALID_INPUT",
            "PROCESS_TIMEOUT",
        ]) {
            expect(explainRunFailure(code, diagnostic)).toEqual(
                explainError(code),
            );
        }
        expect(explainRunFailure("INTERNAL_ERROR", diagnostic).title).toContain(
            "执行发生异常",
        );
        const timeline: RunTimeline = {
            runId: record.runId,
            activities: [
                {
                    ...base,
                    attemptNumber: 1,
                    event: "process_run_activity_finished",
                    activity: "character_emoji_planning",
                    outcome: "failed",
                    durationMs: 1,
                    diagnostic,
                },
            ],
        };
        const summary = diagnosticSummary(record, timeline);
        expect(summary).toContain("失败原因: Agent 执行失败");
        expect(summary).toContain("细分原因: 未记录，仅有默认内部诊断");
        expect(summary).not.toMatch(/失败阶段:|诊断码:/);
        expect(
            diagnosticSummary(
                { ...record, errorCode: "INTERNAL_ERROR" },
                timeline,
            ),
        ).toContain("诊断码: execution/internal_failure");
    });
    it.each([
        ["template_compilation", "template_correction", "invalid_json"],
        ["plan_validation", "plan_correction", "invalid_contract"],
    ] as const)(
        "does not use recovered %s as the final failure",
        (activity, correction, code) => {
            const timeline: RunTimeline = {
                runId: record.runId,
                activities: [
                    {
                        ...base,
                        attemptNumber: 1,
                        event: "process_run_activity_finished",
                        activity,
                        outcome: "failed",
                        durationMs: 1,
                        diagnostic: {
                            stage: code === "invalid_json" ? "json" : "schema",
                            code,
                        },
                    },
                    {
                        ...base,
                        sequence: 2,
                        attemptNumber: 1,
                        event: "process_run_activity_finished",
                        activity: correction,
                        outcome: "succeeded",
                        durationMs: 1,
                    },
                    {
                        ...base,
                        sequence: 3,
                        attemptNumber: 1,
                        event: "process_run_attempt_finished",
                        outcome: "failed",
                        durationMs: 3,
                        errorCode: "AGENT_FAILURE",
                    },
                ],
            };
            expect(describeTimeline(timeline)).toEqual({
                attempt: 1,
                durationMs: 3,
                failedActivity: undefined,
            });
            const summary = diagnosticSummary(record, timeline);
            expect(summary).toContain("失败原因: Agent 执行失败");
            expect(summary).toContain("细分原因: 未记录");
            expect(summary).not.toContain(activity);
            expect(summary).not.toContain(code);
        },
    );
    it("omits all failure metadata from a successful run with an earlier failed activity", () => {
        const summary = diagnosticSummary(
            { ...record, status: "succeeded", errorCode: undefined },
            {
                runId: record.runId,
                activities: [
                    {
                        ...base,
                        attemptNumber: 1,
                        event: "process_run_activity_finished",
                        activity: "compile",
                        outcome: "failed",
                        durationMs: 1,
                        diagnostic: {
                            stage: "schema",
                            code: "invalid_schema",
                            issues: [{ path: "/prompt", code: "too_small" }],
                        },
                    },
                    {
                        ...base,
                        sequence: 2,
                        attemptNumber: 1,
                        event: "process_run_attempt_finished",
                        outcome: "succeeded",
                        durationMs: 2,
                    },
                ],
            },
        );
        expect(summary).toContain("状态: succeeded");
        expect(summary).toContain("Attempt 耗时: 2 ms");
        expect(summary).not.toMatch(
            /失败活动:|失败原因:|失败阶段:|诊断码:|细分原因:|校验:|下一步:/,
        );
    });
    it("does not add a failure explanation to a successful run summary", () => {
        const summary = diagnosticSummary({
            ...record,
            status: "succeeded",
            errorCode: undefined,
        });
        expect(summary).not.toContain("失败原因:");
        expect(summary).not.toContain("下一步:");
    });
    it.each(["DEPENDENCY_FAILURE", "DEPENDENCY_FAILURE_AFTER_COMMIT"] as const)(
        "%s owns title and advice exactly once",
        (errorCode) => {
            for (const diagnostic of [
                undefined,
                { stage: "execution", code: "internal_failure" },
                { stage: "dependency", code: "dependency_failure" },
            ] as const) {
                const timeline: RunTimeline = {
                    runId: record.runId,
                    activities: [
                        {
                            ...base,
                            attemptNumber: 1,
                            event: "process_run_activity_finished",
                            activity: "rendering",
                            outcome: "failed",
                            durationMs: 1,
                            ...(diagnostic ? { diagnostic } : {}),
                        },
                    ],
                };
                const expected = explainError(errorCode);
                expect(explainRunFailure(errorCode, diagnostic)).toEqual(
                    expected,
                );
                const summary = diagnosticSummary(
                    { ...record, errorCode },
                    timeline,
                );
                expect(summary).toContain(`失败原因: ${expected.title}`);
                expect(summary.split(expected.next)).toHaveLength(2);
                if (diagnostic?.code === "internal_failure") {
                    expect(summary).toContain(
                        "细分原因: 未记录，仅有默认内部诊断",
                    );
                    expect(summary).not.toMatch(/失败阶段:|诊断码:/);
                } else if (diagnostic)
                    expect(summary).toContain(
                        `诊断码: ${diagnostic.stage}/${diagnostic.code}`,
                    );
            }
        },
    );
    it("prefers terminal cancellation to an earlier recoverable model error", () => {
        const timeline: RunTimeline = {
            runId: record.runId,
            activities: [
                {
                    ...base,
                    attemptNumber: 1,
                    event: "process_run_activity_finished",
                    activity: "compile",
                    outcome: "failed",
                    durationMs: 20,
                    diagnostic: { stage: "request", code: "connection" },
                },
                {
                    ...base,
                    attemptNumber: 1,
                    sequence: 2,
                    event: "process_run_attempt_finished",
                    outcome: "cancelled",
                    durationMs: 30,
                    errorCode: "INTERNAL_ERROR",
                    diagnostic: {
                        stage: "execution",
                        code: "process_cancelled",
                    },
                },
            ],
        };
        expect(diagnosticSummary(record, timeline)).toContain("流程已取消");
        expect(diagnosticSummary(record, timeline)).not.toContain(
            "模型连接失败",
        );
        const unknownEnd: RunTimeline = {
            ...timeline,
            activities: timeline.activities.map((entry) =>
                entry.event === "process_run_attempt_finished"
                    ? {
                          ...entry,
                          outcome: "failed",
                          errorCode: "INTERNAL_ERROR",
                          diagnostic: {
                              stage: "execution",
                              code: "internal_failure",
                          },
                      }
                    : entry,
            ),
        };
        expect(diagnosticSummary(record, unknownEnd)).toContain("模型连接失败");
        expect(
            diagnosticSummary(
                { ...record, errorCode: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
                timeline,
            ),
        ).toContain("不应直接重新生成");
    });
    it("includes only sanitized diagnostic metadata in the copied summary", () => {
        const timeline: RunTimeline = {
            runId: record.runId,
            activities: [
                {
                    ...base,
                    attemptNumber: 1,
                    event: "process_run_activity_finished",
                    activity: "photo_poster_compilation",
                    outcome: "failed",
                    durationMs: 100,
                    diagnostic: {
                        stage: "schema",
                        code: "invalid_schema",
                        issues: [
                            { path: "/PRIVATE_BODY", code: "PRIVATE_BODY" },
                        ],
                    },
                },
            ],
        };
        const summary = diagnosticSummary(record, timeline);
        expect(summary).toContain("模型结果未通过规则校验");
        expect(summary).toContain("校验: /* (custom)");
        expect(summary).not.toMatch(
            /PRIVATE_BODY|private-input|private-output/,
        );
    });
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
