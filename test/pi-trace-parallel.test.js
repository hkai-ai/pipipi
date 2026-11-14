import { expect, it } from "vitest";
import { observePiSession, promptPi } from "../src/agent-runtime/trace.js";
import { createProcessRunAttemptLog } from "../src/process-runtime/logging.js";

it("按活动实例、会话和调用身份配对同名并行步骤及逆序返回的工具", async () => {
    const events = [];
    const attempt = createProcessRunAttemptLog({
        runId: "parallel",
        process: "parallel",
        version: "v1",
        attemptNumber: 2,
        signal: new AbortController().signal,
        sink: (event) => {
            events.push(event);
        },
    });
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    const execute = (name, gate) =>
        attempt.runActivity("plan", async () => {
            let publish;
            const session = {
                agent: {},
                resourceLoader: {
                    getSkills: () => ({
                        skills: [
                            { name, filePath: "/verified/SKILL.md" },
                            { name: "replaced", filePath: "/new/SKILL.md" },
                            { name: "sdk-only", filePath: "/sdk/SKILL.md" },
                        ],
                    }),
                },
                subscribe: (listener) => {
                    publish = listener;
                },
                prompt: async () => {
                    await session.agent.onPayload(
                        { tools: [{ name }] },
                        { api: "openai-responses", id: name },
                    );
                    publish({
                        type: "message_end",
                        message: {
                            role: "assistant",
                            stopReason: "toolUse",
                            content: [
                                { type: "toolCall", id: "a", name },
                                { type: "toolCall", id: "b", name },
                            ],
                        },
                    });
                    await gate;
                    publish({
                        type: "tool_execution_end",
                        toolCallId: "b",
                        durationMs: 2,
                        isError: true,
                    });
                    publish({
                        type: "tool_execution_end",
                        toolCallId: "a",
                        durationMs: 10,
                        isError: false,
                    });
                },
            };
            observePiSession(
                session,
                new Map([
                    [
                        "binding-only",
                        { filePath: "/unused/SKILL.md", version: "v2" },
                    ],
                    ["replaced", { filePath: "/old/SKILL.md", version: "v2" }],
                    [name, { filePath: "/verified/SKILL.md", version: "v1" }],
                ]),
                [name],
            );
            await promptPi(session, "test");
        });
    const pendingFirst = execute("first", first.promise);
    const pendingSecond = execute("second", second.promise);
    second.resolve();
    await pendingSecond;
    first.resolve();
    await pendingFirst;
    const finished = events.filter(
        (event) => event.event === "process_run_activity_finished",
    );
    expect(finished.map((event) => event.activityId)).toEqual([2, 1]);
    for (const [index, name] of ["second", "first"].entries()) {
        expect(finished[index].sessions[0].skills).toEqual([
            { name, version: "v1" },
            { name: "replaced" },
            { name: "sdk-only" },
        ]);
        expect(finished[index]).toMatchObject({
            runId: "parallel",
            activity: "plan",
            attemptNumber: 2,
            sessions: [
                {
                    sessionId: 1,
                    rounds: [
                        {
                            round: 1,
                            model: name,
                            tools: [name],
                            calls: [
                                {
                                    call: 1,
                                    name,
                                    result: "returned",
                                    durationMs: 10,
                                },
                                {
                                    call: 2,
                                    name,
                                    result: "error",
                                    durationMs: 2,
                                },
                            ],
                        },
                    ],
                },
            ],
        });
    }
});
