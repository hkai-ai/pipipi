import { expect, it } from "vitest";
import { observePiSession, promptPi } from "../src/agent-runtime/trace.js";
import { createProcessRunAttemptLog } from "../src/process-runtime/logging.js";
import { sanitizePiSessions } from "../src/process-runtime/pi-trace.js";

it.each([
    [
        { total: 0.0012, totalFromProvider: true },
        { totalUsd: 0.0012, source: "provider" },
    ],
    [
        { total: 0, totalFromProvider: true },
        { totalUsd: 0, source: "provider" },
    ],
    [
        { total: 0.02, totalFromProvider: false },
        { totalUsd: 0.02, source: "estimate" },
    ],
    [{ total: 0.02 }, { totalUsd: 0.02, source: "estimate" }],
    [{ total: 0 }, undefined],
    [{ total: -1, totalFromProvider: true }, undefined],
    [{ total: Number.NaN, totalFromProvider: true }, undefined],
    [{ total: Number.POSITIVE_INFINITY, totalFromProvider: true }, undefined],
    [{ total: "0.01", totalFromProvider: true }, undefined],
    [undefined, undefined],
])("费用只保存有效金额及来源，不把零估算当免费：%j", async (cost, expected) => {
    const events = [];
    const attempt = createProcessRunAttemptLog({
        runId: "cost",
        process: "cost",
        version: "v1",
        attemptNumber: 1,
        signal: new AbortController().signal,
        sink: (event) => events.push(event),
    });
    await attempt.runActivity("plan", async () => {
        let publish;
        const session = {
            agent: {},
            resourceLoader: { getSkills: () => ({ skills: [] }) },
            subscribe: (listener) => {
                publish = listener;
            },
            prompt: async () => {
                await session.agent.onPayload(
                    {},
                    { api: "openai-responses", id: "test" },
                );
                publish({
                    type: "message_end",
                    message: {
                        role: "assistant",
                        content: [],
                        stopReason: "stop",
                        usage: { cost, secret: "PRIVATE" },
                    },
                });
            },
        };
        observePiSession(session, [], []);
        await promptPi(session, "PRIVATE");
    });
    const finished = events.find(
        (event) => event.event === "process_run_activity_finished",
    );
    expect(finished).toBeDefined();
    expect(finished.sessions[0].rounds[0].cost).toEqual(expected);
    expect(sanitizePiSessions(finished.sessions)).toEqual(finished.sessions);
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
});
