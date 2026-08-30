/** 通过业务 HTTP Interface 验证首轮文本 Agent Conversation */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentConversations } from "../src/agent-conversations/index.js";
import { createInMemoryAgentTurnQueue } from "../src/agent-conversations/queue.js";
import {
    defineAgentRegistration,
    type InteractiveAgent,
} from "../src/agent-conversations/registration.js";
import {
    type AgentRegistry,
    createAgentRegistry,
} from "../src/agent-conversations/registry.js";
import { createInMemoryAgentConversationStore } from "../src/agent-conversations/store.js";
import {
    createAgentTurnDrain,
    createAgentTurnWorker,
} from "../src/agent-conversations/worker.js";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";

const conversationId = "conversation-0001";
const turnId = "turn-0001";
const firstTimestamp = "2026-08-30T08:00:00.000Z";
const startedTimestamp = "2026-08-30T08:00:01.000Z";
const finishedTimestamp = "2026-08-30T08:00:02.000Z";

const runningApplications: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
});

describe("Agent Conversations HTTP Interface", () => {
    it("keeps Agent routes disabled without changing /execute", async () => {
        const application = createProcessingApplication({
            executor: successfulExecutor(),
            http: { logSink: () => {} },
        });
        runningApplications.push(application);
        const { url } = await application.listen();

        const disabledOpen = await fetch(`${url}/agent-conversations`, {
            method: "POST",
        });
        const disabledFind = await fetch(
            `${url}/agent-conversations/${conversationId}`,
        );
        const process = await fetch(`${url}/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });

        expect(disabledOpen.status).toBe(404);
        expect(disabledFind.status).toBe(404);
        expect(process.status).toBe(200);
        expect(await process.json()).toMatchObject({ status: "succeeded" });
    });

    it("accepts the first text Turn and exposes its completed result", async () => {
        const seen: unknown[] = [];
        const fixture = await startFixture({
            agent: {
                respond: async (request) => {
                    seen.push(request);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `建议：${request.input.content[0]?.text}`,
                            },
                        ],
                    };
                },
            },
        });

        const response = await open(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "request-1",
        });
        expect(response.status).toBe(202);
        expect(response.headers.get("location")).toBe(
            `/agent-conversations/${conversationId}`,
        );
        expect(response.headers.get("retry-after")).toBe("2");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
            conversationId,
            turnId,
            sequence: 1,
            status: "queued",
            createdAt: firstTimestamp,
        });

        const queued = await find(fixture.url, conversationId, "caller-a");
        expect(queued.status).toBe(200);
        expect(queued.headers.get("retry-after")).toBe("2");
        expect(await queued.json()).toMatchObject({
            conversationId,
            agent: { id: "design-assistant", version: "v1" },
            configRevision: "test-revision-1",
            status: "busy",
            turns: [{ turnId, sequence: 1, status: "queued" }],
        });

        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        const completed = await find(fixture.url, conversationId, "caller-a");
        expect(completed.headers.get("retry-after")).toBeNull();
        expect(await completed.json()).toEqual({
            conversationId,
            agent: { id: "design-assistant", version: "v1" },
            configRevision: "test-revision-1",
            status: "ready",
            createdAt: firstTimestamp,
            updatedAt: finishedTimestamp,
            turns: [
                {
                    turnId,
                    sequence: 1,
                    status: "succeeded",
                    input: {
                        content: [{ type: "text", text: "分析这个设计" }],
                    },
                    output: {
                        content: [{ type: "text", text: "建议：分析这个设计" }],
                    },
                    createdAt: firstTimestamp,
                    startedAt: startedTimestamp,
                    finishedAt: finishedTimestamp,
                },
            ],
        });
        expect(seen).toEqual([
            expect.objectContaining({
                conversationId,
                turnId,
                input: {
                    content: [{ type: "text", text: "分析这个设计" }],
                },
            }),
        ]);
    });

    it("isolates owners and requires trusted identity", async () => {
        const fixture = await startFixture();
        await open(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "request-1",
        });

        const otherOwner = await find(fixture.url, conversationId, "caller-b");
        const unknown = await find(fixture.url, "unknown", "caller-b");
        const unauthenticated = await fetch(
            `${fixture.url}/agent-conversations/${conversationId}`,
        );

        expect(otherOwner.status).toBe(404);
        expect(await otherOwner.json()).toEqual(await unknown.json());
        expect(unauthenticated.status).toBe(401);
        expect(await unauthenticated.json()).toMatchObject({
            error: { code: "CALLER_UNAUTHORIZED" },
        });
    });

    it("requires a bounded Idempotency-Key before accepting work", async () => {
        const fixture = await startFixture();
        const missing = await fetch(`${fixture.url}/agent-conversations`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-test-caller": "caller-a",
            },
            body: JSON.stringify(request()),
        });
        const oversized = await open(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "x".repeat(513),
        });
        const unauthenticated = await fetch(
            `${fixture.url}/agent-conversations`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": "request-1",
                },
                body: JSON.stringify(request()),
            },
        );

        expect(missing.status).toBe(400);
        expect(await missing.json()).toMatchObject({
            error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
        });
        expect(oversized.status).toBe(400);
        expect(await oversized.json()).toMatchObject({
            error: { code: "INVALID_IDEMPOTENCY_KEY" },
        });
        expect(unauthenticated.status).toBe(401);
        await expect(fixture.queue.take()).resolves.toBeUndefined();
    });

    it("replays the same creation and rejects inconsistent key reuse", async () => {
        const fixture = await startFixture();
        const first = await open(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "shared",
        });
        const firstBody = await first.json();
        const replay = await open(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "shared",
        });
        const conflict = await open(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "shared",
            text: "不同请求",
        });

        expect(replay.status).toBe(202);
        expect(await replay.json()).toEqual(firstBody);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({
            error: { code: "IDEMPOTENCY_CONFLICT" },
        });
        await expect(fixture.queue.take()).resolves.toEqual({
            schemaVersion: 1,
            turnId,
        });
        await expect(fixture.queue.take()).resolves.toBeUndefined();
    });

    it("reports the real terminal status on an idempotent replay", async () => {
        const fixture = await startFixture();
        await open(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "shared",
        });
        await expect(fixture.drain.drainOne()).resolves.toBe("processed");

        const replay = await open(fixture.url, {
            callerId: "caller-a",
            idempotencyKey: "shared",
        });

        expect(replay.status).toBe(202);
        expect(await replay.json()).toMatchObject({
            conversationId,
            turnId,
            status: "succeeded",
        });
        await expect(fixture.queue.take()).resolves.toBeUndefined();
    });

    it("rejects unknown versions, invalid text and caller-supplied mechanics", async () => {
        const fixture = await startFixture();

        for (const testCase of [
            {
                request: request({ version: "v2" }),
                status: 404,
                code: "AGENT_NOT_FOUND",
            },
            {
                request: request({ text: "   " }),
                status: 400,
                code: "INVALID_INPUT",
            },
            {
                request: {
                    ...request(),
                    model: "caller-model",
                    tools: ["anything"],
                    system: "caller prompt",
                },
                status: 400,
                code: "INVALID_INPUT",
            },
        ]) {
            const response = await open(fixture.url, {
                callerId: "caller-a",
                idempotencyKey: `case-${testCase.code}-${testCase.status}`,
                request: testCase.request,
            });
            expect(response.status).toBe(testCase.status);
            expect(await response.json()).toMatchObject({
                error: { code: testCase.code },
            });
        }
        await expect(fixture.queue.take()).resolves.toBeUndefined();
    });

    it("sanitizes Agent exceptions and invalid output", async () => {
        for (const { agent, expectedCode } of [
            {
                agent: {
                    respond: async () => {
                        throw new Error("provider secret");
                    },
                },
                expectedCode: "AGENT_FAILURE",
            },
            {
                agent: {
                    respond: async () => ({
                        url: "https://invented.invalid",
                    }),
                },
                expectedCode: "INVALID_OUTPUT",
            },
        ]) {
            const fixture = await startFixture({ agent });
            await open(fixture.url, {
                callerId: "caller-a",
                idempotencyKey: "request-1",
            });
            await expect(fixture.drain.drainOne()).resolves.toBe("processed");
            const response = await find(
                fixture.url,
                conversationId,
                "caller-a",
            );
            const body = await response.json();
            expect(body).toMatchObject({
                status: "ready",
                turns: [
                    {
                        status: "failed",
                        error: {
                            code: expectedCode,
                        },
                    },
                ],
            });
            expect(JSON.stringify(body)).not.toContain("provider secret");
        }
    });
});

async function startFixture(options: { agent?: InteractiveAgent } = {}) {
    const timestamps = [firstTimestamp, startedTimestamp, finishedTimestamp];
    const clock = () => timestamps.shift() ?? finishedTimestamp;
    const registry: AgentRegistry = createAgentRegistry([
        defineAgentRegistration({
            id: "design-assistant",
            version: "v1",
            revision: "test-revision-1",
            agent:
                options.agent ??
                ({
                    respond: async (turn) => ({
                        content: [
                            {
                                type: "text",
                                text: `processed:${turn.input.content[0]?.text}`,
                            },
                        ],
                    }),
                } satisfies InteractiveAgent),
        }),
    ]);
    const store = createInMemoryAgentConversationStore();
    const queue = createInMemoryAgentTurnQueue();
    const conversations = createAgentConversations({
        registry,
        store,
        queue,
        clock,
        createConversationId: () => conversationId,
        createTurnId: () => turnId,
    });
    const drain = createAgentTurnDrain({
        source: queue,
        worker: createAgentTurnWorker({ registry, store, clock }),
    });
    const application = createProcessingApplication({
        executor: successfulExecutor(),
        http: {
            logSink: () => {},
            agentConversations: {
                conversations,
                callerIdentity: fakeCallerIdentity,
                retryAfterSeconds: 2,
            },
        },
    });
    runningApplications.push(application);
    const { url } = await application.listen();
    return { url, queue, drain };
}

function successfulExecutor() {
    return {
        execute: async () => ({
            runId: "process-run-1",
            process: "test-process",
            version: "v1",
            status: "succeeded" as const,
            output: { value: "unchanged" },
        }),
    };
}

const fakeCallerIdentity: CallerIdentityResolver = {
    resolve: async (headers) => {
        const callerId = headers["x-test-caller"];
        return typeof callerId === "string" ? { callerId } : undefined;
    },
};

function request(options: { text?: string; version?: string } = {}) {
    return {
        agent: {
            id: "design-assistant",
            version: options.version ?? "v1",
        },
        input: {
            content: [{ type: "text", text: options.text ?? "分析这个设计" }],
        },
    };
}

async function open(
    url: string,
    options: {
        callerId: string;
        idempotencyKey: string;
        text?: string;
        request?: unknown;
    },
) {
    return fetch(`${url}/agent-conversations`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": options.idempotencyKey,
            "x-test-caller": options.callerId,
        },
        body: JSON.stringify(
            options.request ?? request({ text: options.text }),
        ),
    });
}

async function find(url: string, id: string, callerId: string) {
    return fetch(`${url}/agent-conversations/${encodeURIComponent(id)}`, {
        headers: { "x-test-caller": callerId },
    });
}
