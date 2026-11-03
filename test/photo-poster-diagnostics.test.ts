import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type CreateAgentSessionResult,
    ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { diagnosticSummary } from "../console/diagnostics.js";
import { parseAgentJson } from "../src/agent-runtime/pi.js";
import { createProcessingApplication } from "../src/api/application.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    createProcessRunner,
    type ProcessRunLogRecord,
} from "../src/process-runtime/index.js";
import { createProcessRunAttemptLog } from "../src/process-runtime/logging.js";
import { createProcessRunRecords } from "../src/process-runtime/records.js";
import { PiPhotoPosterAgent } from "../src/processes/photo-poster/agent.pi.js";
import { createPhotoPosterRegistration } from "../src/processes/photo-poster/registration.js";
import { createPhotoPosterSkillRefs } from "../src/processes/photo-poster/skills.js";
import {
    createJsonlProcessRunActivityArchive,
    createJsonlProcessRunRecordArchive,
} from "../src/run-observation/jsonl.js";

const secret = "PRIVATE_BODY https://private.example/?token=secret";
const input = {
    sourceImageUrl: "https://assets.example/photo.png?private=sample",
    phrase: "QUIET PAWS",
};
const request = {
    process: "travel-abstraction-photo-poster",
    version: "v1",
    input,
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
let modelRuntime: ModelRuntime;
beforeAll(async () => {
    modelRuntime = await ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false,
    });
});
const message = (stopReason: string, text: string, errorMessage?: string) => ({
    role: "assistant",
    stopReason,
    content: [{ type: "text", text }],
    errorMessage,
});

it.each([
    [
        message("error", secret, "502 status code (no body)"),
        "provider_unavailable",
        "request",
        "模型服务暂时不可用",
    ],
    [
        message("error", secret, "504 status code (no body)"),
        "provider_unavailable",
        "request",
        "模型服务暂时不可用",
    ],
    [
        message("error", secret, `OpenAI API error (401): ${secret}`),
        "authentication",
        "request",
        "模型服务拒绝鉴权",
    ],
    [
        message("error", secret, `OpenAI API error (429): ${secret}`),
        "rate_limit",
        "request",
        "模型服务限流",
    ],
    [
        message("error", secret, `OpenAI API error (400): ${secret}`),
        "provider_rejected",
        "request",
        "模型服务拒绝请求",
    ],
    [
        message("error", secret, `OpenAI API error (503): ${secret}`),
        "provider_unavailable",
        "request",
        "模型服务暂时不可用",
    ],
    [
        message("error", secret, "Connection error."),
        "connection",
        "request",
        "模型连接失败",
    ],
    [
        message("error", secret, "Request timed out."),
        "timeout",
        "request",
        "模型请求超时",
    ],
    [message("aborted", secret), "cancelled", "response", "模型执行已取消"],
    [message("stop", ""), "empty_response", "response", "模型返回空内容"],
    [
        message("length", '{"prompt":"truncated'),
        "incomplete_response",
        "response",
        "模型响应未完成",
    ],
    [message("stop", secret), "invalid_json", "json", "模型结果不是合法 JSON"],
    [
        message("stop", JSON.stringify({ prompt: "short", [secret]: secret })),
        "invalid_schema",
        "schema",
        "模型结果未通过规则校验",
    ],
    [
        message("error", secret, `Unclassified ${secret} 401`),
        "execution",
        "request",
        "具体原因尚未确认",
    ],
] as const)(
    "Pi 响应保留 %s 的净化诊断",
    async (response, code, stage, explanation) => {
        const dispose = vi.fn();
        const prompt = vi.fn(async () => undefined);
        const agent = new PiPhotoPosterAgent({
            skills: createPhotoPosterSkillRefs("travel-abstraction"),
            modelRuntime,
            sessionFactory: async () =>
                ({
                    session: {
                        prompt,
                        dispose,
                        abort: async () => undefined,
                        messages: [response],
                    },
                }) as unknown as CreateAgentSessionResult,
        });
        const render = vi.fn();
        const events: ProcessRunLogRecord[] = [];
        const executor = createProcessRunner({
            registry: createProcessRegistry([
                createPhotoPosterRegistration("travel-abstraction", {
                    agent,
                    capability: { render },
                }),
            ]),
            runLogSink: (event) => events.push(event),
        });
        const result = await executor.execute(request);
        expect(result).toMatchObject({
            error: {
                code: "AGENT_FAILURE",
                message: expect.stringContaining(explanation),
            },
        });
        const failure = events.find(
            (event) => event.event === "process_run_activity_finished",
        );
        expect(failure).toMatchObject({
            activity: "photo_poster_compilation",
            outcome: "failed",
            diagnostic: { code, stage },
        });
        if (code === "invalid_schema")
            expect(failure).toMatchObject({
                diagnostic: {
                    issues: [
                        { path: "/prompt", code: "too_small" },
                        { path: "/", code: "unrecognized_keys" },
                    ],
                },
            });
        expect(JSON.stringify({ result, events })).not.toMatch(
            /PRIVATE_BODY|private\.example|token=secret|private=sample|errorMessage|responseText/,
        );
        expect(prompt).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(render).not.toHaveBeenCalled();
    },
);

it("HTTP 错误和持久化活动在 omit 下给出同一诊断，重建归档后控制台仍可读取", async () => {
    const directory = await mkdtemp(join(tmpdir(), "poster-diagnostics-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const now = new Date("2026-11-03T03:21:59.000Z");
    const clock = () => now;
    const archive = createJsonlProcessRunRecordArchive({ directory, clock });
    const activities = createJsonlProcessRunActivityArchive({
        directory,
        clock,
    });
    const records = createProcessRunRecords({
        adapter: archive,
        content: "omit",
        clock: () => now.toISOString(),
    });
    const registration = createPhotoPosterRegistration("travel-abstraction", {
        agent: {
            compile: async () => parseAgentJson([message("stop", secret)]),
        },
        capability: { render: vi.fn() },
    });
    const executor = createProcessRunner({
        registry: createProcessRegistry([registration]),
        runRecords: records,
        runLogSink: activities.record,
        runLogClock: {
            timestamp: () => now.toISOString(),
            monotonicMilliseconds: () => 0,
        },
    });
    const app = createProcessingApplication({
        executor,
        http: {
            logSink: () => {},
            console: {
                basePath: "/ops",
                assetDirectory: "dist/console",
                records: archive,
                activities,
            },
        },
    });
    const { url } = await app.listen();
    cleanups.push(() => app.close());
    const response = await fetch(`${url}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
    });
    const result = await response.json();
    expect(response.status).toBe(502);
    expect(result.error.message).toContain("模型结果不是合法 JSON");
    await activities.flush();
    const restored = createJsonlProcessRunActivityArchive({ directory, clock });
    const events = await restored.findByRun(result.runId);
    expect(events).toHaveLength(4);
    const record = await archive.find(result.runId);
    expect(record).toBeDefined();
    if (!record) throw new Error("missing run");
    expect(record.content).toBeUndefined();
    const summary = diagnosticSummary(record, {
        runId: result.runId,
        activities: events,
    });
    expect(summary).toContain("模型结果不是合法 JSON");
    expect(summary).toContain("json/invalid_json");
    const timelineResponse = await fetch(
        `${url}/ops/runs/${result.runId}/activities`,
    );
    expect(timelineResponse.status).toBe(200);
    expect(await timelineResponse.json()).toMatchObject({
        activities: expect.arrayContaining([
            expect.objectContaining({
                diagnostic: { stage: "json", code: "invalid_json" },
            }),
        ]),
    });
    const disk = await readFile(
        join(directory, "activities-2026-11-03.jsonl"),
        "utf8",
    );
    expect(disk).not.toContain(secret);
});

it.each(["throw", "reject"])(
    "诊断写入 %s 不改变原业务结果和调用次数",
    async (mode) => {
        const compile = vi.fn(async () => ({ prompt: "short" }));
        const render = vi.fn();
        const executor = createProcessRunner({
            registry: createProcessRegistry([
                createPhotoPosterRegistration("travel-abstraction", {
                    agent: { compile },
                    capability: { render },
                }),
            ]),
            runLogSink: () => {
                if (mode === "throw") throw new Error(secret);
                return Promise.reject(new Error(secret));
            },
            runRecords: createProcessRunRecords({
                adapter: {
                    store: () => {
                        if (mode === "throw") throw new Error(secret);
                        return Promise.reject(new Error(secret));
                    },
                    find: async () => undefined,
                },
            }),
        });
        expect(await executor.execute(request)).toMatchObject({
            error: {
                code: "AGENT_FAILURE",
                message: expect.stringContaining("模型结果未通过规则校验"),
            },
        });
        expect(compile).toHaveBeenCalledOnce();
        expect(render).not.toHaveBeenCalled();
    },
);

it("外部取消保持 cancelled 活动，不记录模型依赖故障", async () => {
    const controller = new AbortController();
    const events: ProcessRunLogRecord[] = [];
    const render = vi.fn();
    const registration = createPhotoPosterRegistration("travel-abstraction", {
        agent: {
            compile: async () => {
                controller.abort();
                throw new Error(secret);
            },
        },
        capability: { render },
    });
    const accepted = registration.accept(input);
    if (!accepted.accepted) throw new Error("invalid fixture");
    const result = await createProcessAttemptRunner({
        logSink: (event) => events.push(event),
    }).run({
        runId: "cancelled",
        registration,
        acceptedInput: accepted.acceptedInput,
        signal: controller.signal,
    });
    expect(result).toMatchObject({
        error: { code: "INTERNAL_ERROR", message: "流程已取消" },
    });
    expect(events).toContainEqual(
        expect.objectContaining({
            event: "process_run_attempt_finished",
            outcome: "cancelled",
        }),
    );
    expect(JSON.stringify(events)).not.toMatch(
        /authentication|connection|PRIVATE_BODY/,
    );
    expect(events.at(-1)).toMatchObject({
        diagnostic: { stage: "execution", code: "process_cancelled" },
    });
    expect(render).not.toHaveBeenCalled();
});

it("诊断函数失败不覆盖活动原异常", async () => {
    const events: ProcessRunLogRecord[] = [];
    const log = createProcessRunAttemptLog({
        runId: "r",
        process: "p",
        version: "v1",
        attemptNumber: 1,
        signal: new AbortController().signal,
        sink: (event) => events.push(event),
    });
    const original = new Error(secret);
    await expect(
        log.runActivity(
            "compile",
            () => {
                throw original;
            },
            () => {
                throw new Error("diagnostic sink");
            },
        ),
    ).rejects.toBe(original);
    expect(events).toContainEqual(
        expect.objectContaining({ outcome: "failed" }),
    );
    expect(JSON.stringify(events)).not.toContain(secret);
});
