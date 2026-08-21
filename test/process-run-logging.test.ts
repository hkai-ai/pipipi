import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    createProcessAttemptRunner,
    defineProcessRegistration,
    failProcess,
    type ProcessRunLogClock,
    type ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import { createProcessExecutor } from "../src/processes/catalog.js";
import { createContentRegistration } from "../src/processes/content/registration.js";
import { createPinoProcessRunLogSink } from "../src/run-observation/pino.js";

const inputSchema = z.strictObject({ value: z.string() });
const outputSchema = z.strictObject({ value: z.string() });

describe("Process Run activity logging", () => {
    it("connects production Process activities to the shared log sink", async () => {
        const records: ProcessRunLogRecord[] = [];
        const executor = createProcessExecutor({
            registrations: [
                createContentRegistration({
                    capability: {
                        process: async (input) => ({
                            content: `processed ${input.content}`,
                        }),
                    },
                }),
            ],
            runLogSink: (record) => records.push(record),
            runLogClock: clock([0, 10, 20, 30]),
        });

        const result = await executor.execute({
            process: "content-processing",
            version: "v1",
            input: { content: "sensitive launch copy" },
        });

        expect(result.status).toBe("succeeded");
        expect(records.map((record) => record.event)).toEqual([
            "process_run_attempt_started",
            "process_run_activity_started",
            "process_run_activity_finished",
            "process_run_attempt_finished",
        ]);
        expect(records).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    process: "content-processing",
                    version: "v1",
                    activity: "content_processing",
                }),
            ]),
        );
        expect(JSON.stringify(records)).not.toContain("sensitive");
    });

    it("records ordered, content-free activities for one Process Attempt", async () => {
        const records: ProcessRunLogRecord[] = [];
        const registration = defineProcessRegistration({
            id: "logged-process",
            version: "v1",
            inputSchema,
            outputSchema,
            activities: ["load_policy", "apply_policy"],
            execute: async (input, context) => {
                await context.runActivity("load_policy", async () => ({
                    policy: "sensitive policy",
                }));
                return context.runActivity("apply_policy", async () => ({
                    value: `processed ${input.value}`,
                }));
            },
        });
        const acceptance = registration.accept({ value: "sensitive input" });
        if (!acceptance.accepted) throw new Error("Expected accepted input");
        const runner = createProcessAttemptRunner({
            logSink: (record) => records.push(record),
            logClock: clock([0, 10, 25, 30, 50, 60]),
        });

        const result = await runner.run({
            runId: "00000000-0000-4000-8000-000000000001",
            registration,
            acceptedInput: acceptance.acceptedInput,
            attemptNumber: 3,
        });

        expect(result).toEqual({
            runId: "00000000-0000-4000-8000-000000000001",
            process: "logged-process",
            version: "v1",
            status: "succeeded",
            output: { value: "processed sensitive input" },
        });
        expect(records).toEqual([
            baseRecord(1, 3, { event: "process_run_attempt_started" }),
            baseRecord(2, 3, {
                event: "process_run_activity_started",
                activity: "load_policy",
            }),
            baseRecord(3, 3, {
                event: "process_run_activity_finished",
                activity: "load_policy",
                outcome: "succeeded",
                durationMs: 15,
            }),
            baseRecord(4, 3, {
                event: "process_run_activity_started",
                activity: "apply_policy",
            }),
            baseRecord(5, 3, {
                event: "process_run_activity_finished",
                activity: "apply_policy",
                outcome: "succeeded",
                durationMs: 20,
            }),
            baseRecord(6, 3, {
                event: "process_run_attempt_finished",
                outcome: "succeeded",
                durationMs: 60,
            }),
        ]);
        expect(JSON.stringify(records)).not.toContain("sensitive");
    });

    it("records a safe failed activity and the stable public error code", async () => {
        const records: ProcessRunLogRecord[] = [];
        const registration = defineProcessRegistration({
            id: "logged-process",
            version: "v1",
            inputSchema,
            outputSchema,
            activities: ["call_dependency"],
            execute: async (_input, context) => {
                try {
                    await context.runActivity("call_dependency", async () => {
                        throw new Error("provider secret was rejected");
                    });
                } catch {
                    return failProcess(
                        "DEPENDENCY_FAILURE",
                        "A required dependency is unavailable",
                    );
                }
                throw new Error("unreachable");
            },
        });
        const acceptance = registration.accept({ value: "input" });
        if (!acceptance.accepted) throw new Error("Expected accepted input");

        const result = await createProcessAttemptRunner({
            logSink: (record) => records.push(record),
            logClock: clock([0, 5, 15, 20]),
        }).run({
            runId: "00000000-0000-4000-8000-000000000001",
            registration,
            acceptedInput: acceptance.acceptedInput,
        });

        expect(result.status).toBe("failed");
        expect(records.at(-2)).toEqual(
            baseRecord(3, 1, {
                event: "process_run_activity_finished",
                activity: "call_dependency",
                outcome: "failed",
                durationMs: 10,
            }),
        );
        expect(records.at(-1)).toEqual(
            baseRecord(4, 1, {
                event: "process_run_attempt_finished",
                outcome: "failed",
                durationMs: 20,
                errorCode: "DEPENDENCY_FAILURE",
            }),
        );
        expect(JSON.stringify(records)).not.toContain("provider secret");
    });

    it("marks the active stage cancelled when the Process Attempt times out", async () => {
        const records: ProcessRunLogRecord[] = [];
        let completeDependency: (() => void) | undefined;
        const registration = defineProcessRegistration({
            id: "logged-process",
            version: "v1",
            inputSchema,
            outputSchema,
            activities: ["wait_for_dependency"],
            execute: async (input, context) => {
                await context.runActivity(
                    "wait_for_dependency",
                    () =>
                        new Promise<void>((resolve) => {
                            completeDependency = resolve;
                        }),
                );
                return input;
            },
        });
        const acceptance = registration.accept({ value: "input" });
        if (!acceptance.accepted) throw new Error("Expected accepted input");

        const result = await createProcessAttemptRunner({
            processTimeoutMs: 5,
            logSink: (record) => records.push(record),
            logClock: clock([0, 5, 10, 15]),
        }).run({
            runId: "00000000-0000-4000-8000-000000000001",
            registration,
            acceptedInput: acceptance.acceptedInput,
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "PROCESS_TIMEOUT" },
        });
        expect(records).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    event: "process_run_activity_finished",
                    activity: "wait_for_dependency",
                    outcome: "cancelled",
                }),
                expect.objectContaining({
                    event: "process_run_attempt_finished",
                    outcome: "timed_out",
                    errorCode: "PROCESS_TIMEOUT",
                }),
            ]),
        );
        const finishedRecordCount = records.length;
        completeDependency?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(records).toHaveLength(finishedRecordCount);
        expect(records.at(-1)?.event).toBe("process_run_attempt_finished");
    });

    it("keeps execution successful when the log sink or clock fails", async () => {
        let activityCalls = 0;
        const registration = defineProcessRegistration({
            id: "logged-process",
            version: "v1",
            inputSchema,
            outputSchema,
            activities: ["apply_policy"],
            execute: async (input, context) =>
                context.runActivity("apply_policy", async () => {
                    activityCalls += 1;
                    return input;
                }),
        });
        const acceptance = registration.accept({ value: "input" });
        if (!acceptance.accepted) throw new Error("Expected accepted input");

        const result = await createProcessAttemptRunner({
            logSink: () => {
                throw new Error("log destination unavailable");
            },
            logClock: {
                timestamp: () => {
                    throw new Error("clock unavailable");
                },
                monotonicMilliseconds: () => {
                    throw new Error("clock unavailable");
                },
            },
        }).run({
            runId: "00000000-0000-4000-8000-000000000001",
            registration,
            acceptedInput: acceptance.acceptedInput,
        });

        expect(result.status).toBe("succeeded");
        expect(activityCalls).toBe(1);
    });

    it("rejects undeclared or unsafe activity names", async () => {
        expect(() =>
            defineProcessRegistration({
                id: "logged-process",
                version: "v1",
                inputSchema,
                outputSchema,
                activities: ["input-from-user"],
                execute: async (input) => input,
            }),
        ).toThrow("lower snake case");
        expect(() =>
            defineProcessRegistration({
                id: "logged-process",
                version: "v1",
                inputSchema,
                outputSchema,
                activities: ["apply_policy", "apply_policy"],
                execute: async (input) => input,
            }),
        ).toThrow("duplicated");

        const registration = defineProcessRegistration({
            id: "logged-process",
            version: "v1",
            inputSchema,
            outputSchema,
            activities: ["apply_policy"],
            execute: async (input, context) =>
                context.runActivity("undeclared_activity", async () => input),
        });
        const acceptance = registration.accept({ value: "input" });
        if (!acceptance.accepted) throw new Error("Expected accepted input");

        const result = await createProcessAttemptRunner().run({
            runId: "00000000-0000-4000-8000-000000000001",
            registration,
            acceptedInput: acceptance.acceptedInput,
        });

        expect(result).toMatchObject({
            status: "failed",
            error: { code: "INTERNAL_ERROR" },
        });
    });
});

describe("Process Run Pino Adapter", () => {
    it("writes stable metadata and severity as newline-delimited JSON", () => {
        const lines: string[] = [];
        const sink = createPinoProcessRunLogSink({
            destination: { write: (line) => lines.push(line) },
        });

        sink(baseRecord(1, 1, { event: "process_run_attempt_started" }));
        sink(
            baseRecord(2, 1, {
                event: "process_run_activity_finished",
                activity: "call_dependency",
                outcome: "failed",
                durationMs: 12,
            }),
        );
        sink(
            baseRecord(3, 1, {
                event: "process_run_attempt_finished",
                outcome: "failed",
                durationMs: 20,
                errorCode: "INTERNAL_ERROR",
            }),
        );

        const records = lines.map(parsePinoLine);
        expect(records.map((record) => record.level)).toEqual([30, 40, 50]);
        expect(records[0]).toMatchObject({
            service: "pi-business-processing-service",
            module: "process-run-activity-logging",
            timestamp: "2026-08-10T00:00:00.000Z",
            event: "process_run_attempt_started",
            msg: "process_run_attempt_started",
        });
        expect(records[0]).not.toHaveProperty("time");
    });

    it("honors the configured threshold and removes sensitive fallback fields", () => {
        const lines: string[] = [];
        const sink = createPinoProcessRunLogSink({
            level: "warn",
            destination: { write: (line) => lines.push(line) },
        });

        sink({
            ...baseRecord(1, 1, {
                event: "process_run_attempt_started",
            }),
            input: "private input",
        } as unknown as ProcessRunLogRecord);
        sink({
            ...baseRecord(2, 1, {
                event: "process_run_attempt_finished",
                outcome: "timed_out",
                durationMs: 100,
                errorCode: "PROCESS_TIMEOUT",
            }),
            prompt: "private prompt",
            headers: { authorization: "Bearer private-token" },
        } as unknown as ProcessRunLogRecord);

        expect(lines).toHaveLength(1);
        const record = parsePinoLine(lines[0]);
        expect(record).toMatchObject({
            level: 40,
            event: "process_run_attempt_finished",
            outcome: "timed_out",
        });
        expect(record).not.toHaveProperty("prompt");
        expect(record).not.toHaveProperty("input");
        expect(JSON.stringify(record)).not.toContain("private");
    });
});

function clock(monotonicValues: number[]): ProcessRunLogClock {
    let monotonicIndex = 0;
    return {
        timestamp: () => "2026-08-10T00:00:00.000Z",
        monotonicMilliseconds: () => {
            const value = monotonicValues[monotonicIndex];
            monotonicIndex += 1;
            if (value === undefined) {
                throw new Error("Test clock was exhausted");
            }
            return value;
        },
    };
}

function baseRecord(
    sequence: number,
    attemptNumber: number,
    event: Record<string, unknown>,
): ProcessRunLogRecord {
    return {
        schemaVersion: 1,
        timestamp: "2026-08-10T00:00:00.000Z",
        runId: "00000000-0000-4000-8000-000000000001",
        process: "logged-process",
        version: "v1",
        attemptNumber,
        sequence,
        ...event,
    } as ProcessRunLogRecord;
}

function parsePinoLine(line: string | undefined): Record<string, unknown> {
    if (line === undefined) throw new Error("Expected a Pino log line");
    return JSON.parse(line) as Record<string, unknown>;
}
