/** 通过业务 HTTP Interface 验证多轮文本顺序、Context、幂等竞争与分页 */
import { afterEach, describe, expect, it } from "vitest";
import { estimateAgentContextTokens } from "../src/agent-conversations/context.js";
import {
    type AgentConversationView,
    createAgentConversations,
} from "../src/agent-conversations/index.js";
import { createInMemoryAgentTurnQueue } from "../src/agent-conversations/queue.js";
import {
    type AgentRegistrationLimits,
    defineAgentRegistration,
    globalAgentLimits,
    type InteractiveAgent,
    type InteractiveAgentRequest,
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

const conversationId = "conversation-multiturn";
const runningApplications: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
});

describe("multi-turn Agent Conversations HTTP Interface", () => {
    it("continues a completed Conversation with its successful public history", async () => {
        const seen: InteractiveAgentRequest[] = [];
        const fixture = await startFixture({
            agent: {
                respond: async (request) => {
                    seen.push(request);
                    return textOutput(`answer:${textOf(request)}`);
                },
            },
        });
        const first = await open(fixture.url, "caller-a", "open-1", "first");
        const firstBody = await first.json();
        await fixture.drain.drainOne();

        const second = await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            "turn-2",
            firstBody.turnId,
            "second",
        );
        expect(second.status).toBe(202);
        expect(await second.json()).toMatchObject({
            turnId: "turn-0002",
            sequence: 2,
            status: "queued",
        });
        await fixture.drain.drainOne();

        expect(seen[1]).toMatchObject({
            input: textInput("second"),
            context: {
                history: [
                    {
                        turnId: "turn-0001",
                        sequence: 1,
                        input: textInput("first"),
                        output: textOutput("answer:first"),
                    },
                ],
            },
        });
        const view = await find(fixture.url, conversationId, "caller-a");
        expect(await view.json()).toMatchObject({
            status: "ready",
            turnCount: 2,
            lastTurnId: "turn-0002",
            turns: [
                { sequence: 1, status: "succeeded" },
                { sequence: 2, status: "succeeded" },
            ],
        });
    });

    it("serializes competing tabs and replays before busy or sequence checks", async () => {
        const fixture = await startFixture();
        await open(fixture.url, "caller-a", "open-1", "first");
        await fixture.drain.drainOne();

        const [left, right] = await Promise.all([
            continueTurn(
                fixture.url,
                conversationId,
                "caller-a",
                "left",
                "turn-0001",
                "left",
            ),
            continueTurn(
                fixture.url,
                conversationId,
                "caller-a",
                "right",
                "turn-0001",
                "right",
            ),
        ]);
        expect([left.status, right.status].sort()).toEqual([202, 409]);
        const accepted = left.status === 202 ? left : right;
        const rejected = left.status === 409 ? left : right;
        const acceptedKey = left.status === 202 ? "left" : "right";
        const acceptedText = left.status === 202 ? "left" : "right";
        expect(await rejected.json()).toMatchObject({
            error: { code: "CONVERSATION_BUSY" },
        });
        expect(rejected.headers.get("retry-after")).toBe("2");

        const replay = await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            acceptedKey,
            "turn-0001",
            acceptedText,
        );
        expect(replay.status).toBe(202);
        expect(await replay.json()).toEqual(await accepted.json());

        const conflict = await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            acceptedKey,
            "turn-0001",
            "different",
        );
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({
            error: { code: "IDEMPOTENCY_CONFLICT" },
        });

        await fixture.drain.drainOne();
        const stale = await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            "stale",
            "turn-0001",
            "stale",
        );
        expect(stale.status).toBe(409);
        expect(await stale.json()).toMatchObject({
            error: { code: "CONVERSATION_SEQUENCE_CONFLICT" },
        });
    });

    it("keeps append owner-scoped without revealing Conversation existence", async () => {
        const fixture = await startFixture();
        await open(fixture.url, "caller-a", "open-1", "first");
        await fixture.drain.drainOne();

        const otherOwner = await continueTurn(
            fixture.url,
            conversationId,
            "caller-b",
            "other",
            "turn-0001",
            "intrude",
        );
        const unknown = await continueTurn(
            fixture.url,
            "missing",
            "caller-b",
            "unknown",
            "turn-0001",
            "intrude",
        );
        expect(otherOwner.status).toBe(404);
        expect(await otherOwner.json()).toEqual(await unknown.json());
    });

    it("returns bounded cursor pages and rejects unrecognized query mechanics", async () => {
        const fixture = await startFixture();
        await open(fixture.url, "caller-a", "open-1", "one");
        await fixture.drain.drainOne();
        for (let sequence = 2; sequence <= 5; sequence += 1) {
            await continueTurn(
                fixture.url,
                conversationId,
                "caller-a",
                `turn-${sequence}`,
                `turn-${String(sequence - 1).padStart(4, "0")}`,
                `message-${sequence}`,
            );
            await fixture.drain.drainOne();
        }

        const first = await find(
            fixture.url,
            conversationId,
            "caller-a",
            "?limit=2",
        );
        const firstPage = (await first.json()) as AgentConversationView;
        expect(firstPage.turns.map((turn) => turn.sequence)).toEqual([1, 2]);
        expect(firstPage.nextCursor).toEqual(expect.any(String));
        const second = await find(
            fixture.url,
            conversationId,
            "caller-a",
            `?limit=2&after=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
        );
        const secondPage = (await second.json()) as AgentConversationView;
        expect(secondPage.turns.map((turn) => turn.sequence)).toEqual([3, 4]);
        expect(secondPage.turnCount).toBe(5);

        for (const query of ["?after=invalid", "?limit=0", "?model=x"]) {
            const invalid = await find(
                fixture.url,
                conversationId,
                "caller-a",
                query,
            );
            expect(invalid.status).toBe(400);
            expect(await invalid.json()).toMatchObject({
                error: { code: "INVALID_QUERY" },
            });
        }
    });

    it("rebuilds a bounded summary and excludes failed Turns from Context", async () => {
        const seen: InteractiveAgentRequest[] = [];
        const fixture = await startFixture({
            limits: {
                maxInputBytes: 1_000,
                maxHistoryTurns: 1,
                maxSummaryTokens: 1_000,
                maxContextTokens: 4_000,
            },
            agent: {
                respond: async (request) => {
                    seen.push(request);
                    if (textOf(request) === "failed-private") {
                        throw new Error("hidden provider reasoning");
                    }
                    return textOutput(`answer:${textOf(request)}`);
                },
            },
        });
        await open(fixture.url, "caller-a", "open-1", "first");
        await fixture.drain.drainOne();
        await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            "turn-2",
            "turn-0001",
            "failed-private",
        );
        await fixture.drain.drainOne();
        await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            "turn-3",
            "turn-0002",
            "third",
        );
        await fixture.drain.drainOne();
        await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            "turn-4",
            "turn-0003",
            "fourth",
        );
        await fixture.drain.drainOne();

        const fourthContext = seen.at(-1)?.context;
        expect(fourthContext?.history).toMatchObject([
            { sequence: 3, output: textOutput("answer:third") },
        ]);
        expect(fourthContext?.workingSummary).toContain("Turn 1");
        expect(JSON.stringify(fourthContext)).not.toContain("failed-private");
        expect(JSON.stringify(fourthContext)).not.toContain(
            "hidden provider reasoning",
        );
        expect(
            estimateAgentContextTokens({
                input: seen.at(-1)?.input,
                context: fourthContext,
            }),
        ).toBeLessThanOrEqual(4_000);
    });

    it("enforces Registration Turn limits and rejects limits above global caps", async () => {
        expect(() =>
            defineAgentRegistration({
                id: "invalid-limits",
                version: "v1",
                revision: "revision",
                agent: { respond: async () => textOutput("ok") },
                limits: { maxTurns: globalAgentLimits.maxTurns + 1 },
            }),
        ).toThrow(/maxTurns/);

        const fixture = await startFixture({ limits: { maxTurns: 2 } });
        await open(fixture.url, "caller-a", "open-1", "first");
        await fixture.drain.drainOne();
        await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            "turn-2",
            "turn-0001",
            "second",
        );
        await fixture.drain.drainOne();
        const overLimit = await continueTurn(
            fixture.url,
            conversationId,
            "caller-a",
            "turn-3",
            "turn-0002",
            "third",
        );
        expect(overLimit.status).toBe(409);
        expect(await overLimit.json()).toMatchObject({
            error: { code: "CONVERSATION_TURN_LIMIT_REACHED" },
        });
    });

    it("applies Registration aggregate input and output bounds", async () => {
        const inputFixture = await startFixture({
            limits: { maxInputBytes: 4 },
        });
        const invalidInput = await open(
            inputFixture.url,
            "caller-a",
            "open-1",
            "12345",
        );
        expect(invalidInput.status).toBe(400);
        expect(await invalidInput.json()).toMatchObject({
            error: { code: "INVALID_INPUT" },
        });

        const outputFixture = await startFixture({
            limits: { maxOutputBytes: 4 },
            agent: { respond: async () => textOutput("12345") },
        });
        await open(outputFixture.url, "caller-a", "open-2", "ok");
        await outputFixture.drain.drainOne();
        const completed = await find(
            outputFixture.url,
            conversationId,
            "caller-a",
        );
        expect(await completed.json()).toMatchObject({
            turns: [
                {
                    status: "failed",
                    error: { code: "INVALID_OUTPUT" },
                },
            ],
        });
    });
});

async function startFixture(
    options: {
        agent?: InteractiveAgent;
        limits?: Partial<AgentRegistrationLimits>;
    } = {},
) {
    let turnSequence = 0;
    let clockSequence = 0;
    const clock = () =>
        new Date(Date.UTC(2026, 7, 30, 8, 0, clockSequence++)).toISOString();
    const registry: AgentRegistry = createAgentRegistry([
        defineAgentRegistration({
            id: "design-assistant",
            version: "v1",
            revision: "test-revision-1",
            agent:
                options.agent ??
                ({
                    respond: async (request) =>
                        textOutput(`answer:${textOf(request)}`),
                } satisfies InteractiveAgent),
            limits: options.limits,
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
        createTurnId: () => `turn-${String(++turnSequence).padStart(4, "0")}`,
    });
    const drain = createAgentTurnDrain({
        source: queue,
        worker: createAgentTurnWorker({ registry, store, clock }),
    });
    const application = createProcessingApplication({
        executor: {
            execute: async () => ({
                runId: "process-run-1",
                process: "test-process",
                version: "v1",
                status: "succeeded" as const,
                output: {},
            }),
        },
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
    return { url, drain };
}

const fakeCallerIdentity: CallerIdentityResolver = {
    resolve: async (headers) => {
        const callerId = headers["x-test-caller"];
        return typeof callerId === "string" ? { callerId } : undefined;
    },
};

function textInput(text: string) {
    return { content: [{ type: "text" as const, text }] };
}

function textOutput(text: string) {
    return textInput(text);
}

function textOf(request: InteractiveAgentRequest): string {
    return request.input.content[0]?.text ?? "";
}

function open(url: string, callerId: string, key: string, text: string) {
    return fetch(`${url}/agent-conversations`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            "x-test-caller": callerId,
        },
        body: JSON.stringify({
            agent: { id: "design-assistant", version: "v1" },
            input: textInput(text),
        }),
    });
}

function continueTurn(
    url: string,
    id: string,
    callerId: string,
    key: string,
    afterTurnId: string,
    text: string,
) {
    return fetch(`${url}/agent-conversations/${encodeURIComponent(id)}/turns`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            "x-test-caller": callerId,
        },
        body: JSON.stringify({
            afterTurnId,
            input: textInput(text),
        }),
    });
}

function find(url: string, id: string, callerId: string, query = "") {
    return fetch(
        `${url}/agent-conversations/${encodeURIComponent(id)}${query}`,
        { headers: { "x-test-caller": callerId } },
    );
}
