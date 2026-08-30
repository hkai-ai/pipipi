/** 通过业务 HTTP 验证 Interactive Agent 的受控 Process Tool、预算、Ledger 与输出来源 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAgentConversations } from "../src/agent-conversations/index.js";
import { createInMemoryAgentTurnQueue } from "../src/agent-conversations/queue.js";
import {
    defineAgentRegistration,
    type InteractiveAgent,
} from "../src/agent-conversations/registration.js";
import { createAgentRegistry } from "../src/agent-conversations/registry.js";
import { createInMemoryAgentConversationStore } from "../src/agent-conversations/store.js";
import { createInMemoryAgentToolLedger } from "../src/agent-conversations/tools.js";
import {
    createAgentTurnDrain,
    createAgentTurnWorker,
} from "../src/agent-conversations/worker.js";
import type { ProcessToolSpec } from "../src/agent-runtime/process-tools.js";
import { createProcessToolRuntime } from "../src/agent-runtime/process-tools.js";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
    type ProcessRegistration,
} from "../src/process-runtime/index.js";

const conversationId = "conversation-tools";
const freeSpec: ProcessToolSpec = {
    process: "refine-text",
    version: "v1",
    toolName: "refine_text",
    description: "Refine approved text.",
    sideEffect: "none",
};
const pricedSpec: ProcessToolSpec = {
    process: "render-design",
    version: "v1",
    toolName: "render_design",
    description: "Priced. Render one approved design.",
    sideEffect: "priced",
};
const runningApplications: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
});

describe("Interactive Agent Process Tools", () => {
    it("binds only exact allow-listed Processes and derives a stable child Run", async () => {
        const processRuns: Array<{
            runId: string;
            content: string;
            signal: AbortSignal;
        }> = [];
        const seenToolNames: string[][] = [];
        const fixture = await startFixture({
            specs: [freeSpec],
            processRuns,
            agent: {
                respond: async (request) => {
                    seenToolNames.push(
                        request.processTools.map((tool) => tool.name),
                    );
                    const result = await request.processTools[0]?.execute({
                        content: "quiet",
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: toolText(result),
                            },
                        ],
                    };
                },
            },
        });

        const response = await open(fixture.url, "open-1", "start");
        expect(response.status).toBe(202);
        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        expect(seenToolNames).toEqual([["refine_text"]]);
        expect(processRuns).toMatchObject([
            {
                runId: "turn-0001.1",
                content: "quiet",
            },
        ]);
        const view = await find(fixture.url);
        expect(await view.json()).toMatchObject({
            turns: [
                {
                    status: "succeeded",
                    output: {
                        content: [{ type: "text", text: "QUIET" }],
                    },
                },
            ],
        });
        expect(fixture.ledger.records("turn-0001")).toMatchObject([
            {
                invocationId: "turn-0001.1",
                process: "refine-text",
                version: "v1",
                sideEffect: "none",
                status: "succeeded",
                inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
                output: { content: "QUIET" },
            },
        ]);

        const callerMechanics = await fetch(
            `${fixture.url}/agent-conversations`,
            {
                method: "POST",
                headers: headers("caller-tools"),
                body: JSON.stringify({
                    agent: { id: "design-assistant", version: "v1" },
                    input: textInput("start"),
                    tools: ["unapproved"],
                }),
            },
        );
        expect(callerMechanics.status).toBe(400);
        expect(await callerMechanics.json()).toMatchObject({
            error: { code: "INVALID_INPUT" },
        });
    });

    it("rejects unavailable Process versions when defining the Registration", () => {
        expect(() =>
            defineAgentRegistration({
                id: "design-assistant",
                version: "v1",
                revision: "tools-1",
                agent: { respond: async () => textOutput("unused") },
                processTools: {
                    specs: [{ ...freeSpec, version: "v2" }],
                    registry: createProcessRegistry([freeRegistration()]),
                    attemptRunner: createProcessAttemptRunner(),
                },
            }),
        ).toThrow('Process Tool "refine-text/v2" is not available');
    });

    it("serializes calls and enforces six total and one priced call per Turn", async () => {
        let active = 0;
        let maxActive = 0;
        const actualRuns: string[] = [];
        const observedResults: unknown[] = [];
        const fixture = await startFixture({
            specs: [freeSpec, pricedSpec],
            execute: async (kind, input, context) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await Promise.resolve();
                actualRuns.push(context.runId);
                active -= 1;
                return {
                    content: `${kind}:${String((input as { content: string }).content)}`,
                };
            },
            agent: {
                respond: async (request) => {
                    const free = request.processTools.find(
                        (tool) => tool.name === "refine_text",
                    );
                    const priced = request.processTools.find(
                        (tool) => tool.name === "render_design",
                    );
                    if (!free || !priced) throw new Error("missing Tool");
                    const firstPriced = await priced.execute({ content: "p1" });
                    const secondPriced = await priced.execute({
                        content: "p2",
                    });
                    const freeResults = await Promise.all(
                        Array.from({ length: 6 }, (_, index) =>
                            free.execute({ content: `f${index}` }),
                        ),
                    );
                    observedResults.push(secondPriced, freeResults.at(-1));
                    return textOutput(toolText(firstPriced));
                },
            },
        });
        await open(fixture.url, "budget", "start");
        await fixture.drain.drainOne();

        expect(maxActive).toBe(1);
        expect(actualRuns).toEqual([
            "turn-0001.1",
            "turn-0001.3",
            "turn-0001.4",
            "turn-0001.5",
            "turn-0001.6",
            "turn-0001.7",
        ]);
        expect(observedResults).toMatchObject([
            {
                error: { code: "PRICED_TURN_BUDGET_EXHAUSTED" },
            },
            { error: { code: "TOOL_BUDGET_EXHAUSTED" } },
        ]);
        expect(fixture.ledger.records("turn-0001")).toHaveLength(6);
    });

    it("caps priced calls across the Conversation at ten", async () => {
        const pricedResults: unknown[] = [];
        let pricedExecutions = 0;
        const fixture = await startFixture({
            specs: [pricedSpec],
            execute: async (_kind, input) => {
                pricedExecutions += 1;
                return {
                    content: `paid:${String((input as { content: string }).content)}`,
                };
            },
            agent: {
                respond: async (request) => {
                    const input = currentText(request.input);
                    const result = await request.processTools[0]?.execute({
                        content: input,
                    });
                    pricedResults.push(result);
                    return textOutput(
                        hasToolOutput(result)
                            ? toolText(result)
                            : "budget exhausted",
                    );
                },
            },
        });

        await open(fixture.url, "priced-1", "message-1");
        await fixture.drain.drainOne();
        let afterTurnId = "turn-0001";
        for (let sequence = 2; sequence <= 11; sequence += 1) {
            const response = await continueTurn(
                fixture.url,
                `priced-${sequence}`,
                afterTurnId,
                `message-${sequence}`,
            );
            expect(response.status).toBe(202);
            afterTurnId = `turn-${String(sequence).padStart(4, "0")}`;
            await fixture.drain.drainOne();
        }

        expect(pricedExecutions).toBe(10);
        expect(pricedResults.at(-1)).toMatchObject({
            error: { code: "PRICED_CONVERSATION_BUDGET_EXHAUSTED" },
        });
        const view = await find(fixture.url);
        const body = await view.json();
        expect(body.turns).toHaveLength(11);
        expect(body.turns.at(-1)).toMatchObject({
            sequence: 11,
            status: "failed",
            error: { code: "INVALID_OUTPUT" },
        });
    });

    it("rejects final text not derived from this Turn's successful Tool output", async () => {
        const fixture = await startFixture({
            specs: [freeSpec],
            agent: {
                respond: async (request) => {
                    await request.processTools[0]?.execute({
                        content: "source",
                    });
                    return textOutput("invented final value");
                },
            },
        });
        await open(fixture.url, "provenance", "start");
        await fixture.drain.drainOne();
        const view = await find(fixture.url);
        expect(await view.json()).toMatchObject({
            turns: [
                {
                    status: "failed",
                    error: { code: "INVALID_OUTPUT" },
                },
            ],
        });
    });
});

describe("Agent Tool Ledger contract", () => {
    it("replays the same ordinal and conflicts on a different input fingerprint", async () => {
        let executions = 0;
        const registry = createProcessRegistry([
            freeRegistration(async (input) => {
                executions += 1;
                return { content: input.content.toUpperCase() };
            }),
        ]);
        const runtime = createProcessToolRuntime({
            specs: [freeSpec],
            registry,
            attemptRunner: createProcessAttemptRunner(),
        });
        const ledger = createInMemoryAgentToolLedger();
        const binding = {
            conversationId,
            turnId: "turn-retry",
            runtime,
            limits: {
                maxCallsPerTurn: 6,
                maxPricedCallsPerTurn: 1,
                maxPricedCallsPerConversation: 10,
            },
            signal: new AbortController().signal,
        };
        const first = ledger.bind(binding);
        const replay = ledger.bind(binding);
        const conflict = ledger.bind(binding);

        const firstResult = await first.tools[0]?.execute({
            content: "same",
        });
        await expect(
            replay.tools[0]?.execute({ content: "same" }),
        ).resolves.toEqual(firstResult);
        await expect(
            conflict.tools[0]?.execute({ content: "different" }),
        ).resolves.toMatchObject({
            error: { code: "TOOL_INVOCATION_CONFLICT" },
        });
        expect(executions).toBe(1);
        expect(ledger.records("turn-retry")).toHaveLength(1);
    });

    it("propagates cancellation to the running Process Attempt", async () => {
        let processSignal: AbortSignal | undefined;
        const registry = createProcessRegistry([
            freeRegistration(
                (_input, context) =>
                    new Promise((resolve) => {
                        processSignal = context.signal;
                        context.signal.addEventListener(
                            "abort",
                            () => resolve({ content: "cancelled" }),
                            { once: true },
                        );
                    }),
            ),
        ]);
        const runtime = createProcessToolRuntime({
            specs: [freeSpec],
            registry,
            attemptRunner: createProcessAttemptRunner(),
        });
        const controller = new AbortController();
        const tool = createInMemoryAgentToolLedger().bind({
            conversationId,
            turnId: "turn-cancel",
            runtime,
            limits: {
                maxCallsPerTurn: 6,
                maxPricedCallsPerTurn: 1,
                maxPricedCallsPerConversation: 10,
            },
            signal: controller.signal,
        }).tools[0];

        const result = tool?.execute({ content: "cancel me" });
        await vi.waitFor(() => expect(processSignal).toBeDefined());
        controller.abort("caller cancelled");

        await expect(result).resolves.toMatchObject({
            status: "failed",
            error: { code: "INTERNAL_ERROR" },
        });
        expect(processSignal?.aborted).toBe(true);
    });
});

async function startFixture(options: {
    specs: readonly ProcessToolSpec[];
    agent: InteractiveAgent;
    processRuns?: Array<{
        runId: string;
        content: string;
        signal: AbortSignal;
    }>;
    execute?: (
        kind: string,
        input: unknown,
        context: { runId: string; signal: AbortSignal },
    ) => Promise<{ content: string }>;
}) {
    let turnSequence = 0;
    const registrations = [
        freeRegistration(async (input, context) => {
            options.processRuns?.push({
                runId: context.runId,
                content: input.content,
                signal: context.signal,
            });
            return options.execute
                ? options.execute("free", input, context)
                : { content: input.content.toUpperCase() };
        }),
        pricedRegistration(async (input, context) =>
            options.execute
                ? options.execute("priced", input, context)
                : { content: `paid:${input.content}` },
        ),
    ];
    const processRegistry = createProcessRegistry(registrations);
    const agentRegistration = defineAgentRegistration({
        id: "design-assistant",
        version: "v1",
        revision: "tools-revision-1",
        agent: options.agent,
        processTools: {
            specs: options.specs,
            registry: processRegistry,
            attemptRunner: createProcessAttemptRunner(),
        },
    });
    const registry = createAgentRegistry([agentRegistration]);
    const store = createInMemoryAgentConversationStore();
    const queue = createInMemoryAgentTurnQueue();
    const ledger = createInMemoryAgentToolLedger();
    const conversations = createAgentConversations({
        registry,
        store,
        queue,
        createConversationId: () => conversationId,
        createTurnId: () => `turn-${String(++turnSequence).padStart(4, "0")}`,
    });
    const drain = createAgentTurnDrain({
        source: queue,
        worker: createAgentTurnWorker({
            registry,
            store,
            toolLedger: ledger,
        }),
    });
    const application = createProcessingApplication({
        executor: {
            execute: async () => ({
                runId: "run-1",
                process: "test",
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
            },
        },
    });
    runningApplications.push(application);
    const { url } = await application.listen();
    return { url, drain, ledger };
}

function freeRegistration(
    execute: (
        input: { content: string },
        context: { runId: string; signal: AbortSignal },
    ) => Promise<{ content: string }> = async (input) => ({
        content: input.content.toUpperCase(),
    }),
): ProcessRegistration {
    return defineProcessRegistration({
        id: "refine-text",
        version: "v1",
        inputSchema: z.strictObject({ content: z.string().trim().min(1) }),
        outputSchema: z.strictObject({ content: z.string().min(1) }),
        activities: [],
        execute,
    });
}

function pricedRegistration(
    execute: (
        input: { content: string },
        context: { runId: string; signal: AbortSignal },
    ) => Promise<{ content: string }>,
): ProcessRegistration {
    return defineProcessRegistration({
        id: "render-design",
        version: "v1",
        inputSchema: z.strictObject({ content: z.string().trim().min(1) }),
        outputSchema: z.strictObject({ content: z.string().min(1) }),
        activities: [],
        execute,
    });
}

function textInput(text: string) {
    return { content: [{ type: "text" as const, text }] };
}

function textOutput(text: string) {
    return textInput(text);
}

function currentText(input: {
    content: readonly (
        | { type: "text"; text: string }
        | { type: "image"; resource: unknown }
    )[];
}) {
    const block = input.content.find((item) => item.type === "text");
    return block?.type === "text" ? block.text : "";
}

function toolText(value: unknown): string {
    if (
        typeof value === "object" &&
        value !== null &&
        "output" in value &&
        typeof value.output === "object" &&
        value.output !== null &&
        "content" in value.output &&
        typeof value.output.content === "string"
    ) {
        return value.output.content;
    }
    throw new Error("Tool did not return text");
}

function hasToolOutput(value: unknown): boolean {
    return typeof value === "object" && value !== null && "output" in value;
}

function headers(key: string) {
    return {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-test-caller": "caller-a",
    };
}

function open(url: string, key: string, text: string) {
    return fetch(`${url}/agent-conversations`, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({
            agent: { id: "design-assistant", version: "v1" },
            input: textInput(text),
        }),
    });
}

function continueTurn(
    url: string,
    key: string,
    afterTurnId: string,
    text: string,
) {
    return fetch(`${url}/agent-conversations/${conversationId}/turns`, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({
            afterTurnId,
            input: textInput(text),
        }),
    });
}

function find(url: string) {
    return fetch(`${url}/agent-conversations/${conversationId}`, {
        headers: { "x-test-caller": "caller-a" },
    });
}

const fakeCallerIdentity: CallerIdentityResolver = {
    resolve: async (headers) => {
        const callerId = headers["x-test-caller"];
        return typeof callerId === "string" ? { callerId } : undefined;
    },
};
