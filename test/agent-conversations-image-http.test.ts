/** 通过业务 HTTP 与 Pi Session Seam 验证 owner-scoped 图片输入输出 */
import type {
    CreateAgentSessionOptions,
    CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiInteractiveAgent } from "../src/agent-conversations/agent.pi.js";
import { createAgentConversations } from "../src/agent-conversations/index.js";
import { createInMemoryAgentTurnQueue } from "../src/agent-conversations/queue.js";
import {
    type AgentRegistrationLimits,
    defineAgentRegistration,
    type InteractiveAgent,
    type InteractiveAgentRequest,
} from "../src/agent-conversations/registration.js";
import { createAgentRegistry } from "../src/agent-conversations/registry.js";
import {
    type AgentImageResource,
    type AgentResourceResolver,
    createInMemoryAgentResourceResolver,
    type InMemoryAgentImageRecord,
} from "../src/agent-conversations/resource.js";
import { createInMemoryAgentConversationStore } from "../src/agent-conversations/store.js";
import {
    createAgentTurnDrain,
    createAgentTurnWorker,
} from "../src/agent-conversations/worker.js";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";
import { createPosterSkillRefs } from "../src/processes/poster/skills.js";

const conversationId = "conversation-image";
const turnId = "turn-image-0001";
const expiresAt = "2026-08-30T09:00:00.000Z";
const runningApplications: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
    await Promise.all(
        runningApplications.splice(0).map((application) => application.close()),
    );
});

describe("Agent Conversation image resources", () => {
    it("preserves mixed block order, releases model access and projects temporary URLs", async () => {
        const events: string[] = [];
        const seen: InteractiveAgentRequest[] = [];
        const fixture = await startFixture({
            records: [
                record("input-image", "caller-a"),
                record("output-image", "caller-a", {
                    outputTurnIds: [turnId],
                }),
            ],
            events: {
                acquired: (id) => events.push(`acquired:${id}`),
                released: (id) => events.push(`released:${id}`),
            },
            agent: {
                respond: async (request) => {
                    seen.push(request);
                    return {
                        content: [
                            { type: "text", text: "完成" },
                            { type: "image", resourceId: "output-image" },
                        ],
                    };
                },
            },
        });

        const accepted = await open(fixture.url, "caller-a", "image-1", [
            { type: "text", text: "参考" },
            { type: "image", resourceId: "input-image" },
            { type: "text", text: "做一个新方案" },
        ]);
        expect(accepted.status).toBe(202);
        await expect(fixture.drain.drainOne()).resolves.toBe("processed");
        expect(events).toEqual([
            "acquired:input-image",
            "released:input-image",
        ]);
        expect(seen[0]?.input.content.map((block) => block.type)).toEqual([
            "text",
            "image",
            "text",
        ]);
        expect(seen[0]?.imageAccess).toEqual([
            {
                resourceId: "input-image",
                mediaType: "image/png",
                data: "BASE64-input-image",
            },
        ]);

        const response = await find(fixture.url, "caller-a");
        const body = await response.json();
        expect(body).toMatchObject({
            turns: [
                {
                    input: {
                        content: [
                            { type: "text", text: "参考" },
                            {
                                type: "image",
                                resource: {
                                    resourceId: "input-image",
                                    mediaType: "image/png",
                                    byteSize: 100,
                                    width: 20,
                                    height: 10,
                                },
                                url: "https://resources.example/input-image",
                                expiresAt,
                            },
                            { type: "text", text: "做一个新方案" },
                        ],
                    },
                    output: {
                        content: [
                            { type: "text", text: "完成" },
                            {
                                type: "image",
                                resource: { resourceId: "output-image" },
                                url: "https://resources.example/output-image",
                                expiresAt,
                            },
                        ],
                    },
                },
            ],
        });
        expect(JSON.stringify(body)).not.toContain("BASE64");

        const stored = await fixture.store.findOwnedPage({
            conversationId,
            ownerId: "caller-a",
            limit: 10,
        });
        expect(JSON.stringify(stored)).not.toContain("https://");
        expect(JSON.stringify(stored)).not.toContain("expiresAt");
        expect(JSON.stringify(stored)).not.toContain("BASE64");
    });

    it("hides resource ownership and rejects URLs, base64 and file paths", async () => {
        const fixture = await startFixture({
            records: [record("input-image", "caller-a")],
        });
        const otherOwner = await open(fixture.url, "caller-b", "other", [
            { type: "image", resourceId: "input-image" },
        ]);
        const missing = await open(fixture.url, "caller-b", "missing", [
            { type: "image", resourceId: "missing-image" },
        ]);
        expect(otherOwner.status).toBe(400);
        expect(await otherOwner.json()).toEqual(await missing.json());

        for (const [key, block] of [
            ["url", { type: "image", url: "https://outside.example/a.png" }],
            ["base64", { type: "image", data: "aGVsbG8=" }],
            ["path", { type: "image", path: "/tmp/private.png" }],
            ["file-url", { type: "image", resourceId: "file:///tmp/a.png" }],
        ] as const) {
            const response = await open(fixture.url, "caller-a", key, [block]);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
                error: { code: "INVALID_INPUT" },
            });
        }
    });

    it("enforces image count, bytes, total, media and dimensions", async () => {
        const fixture = await startFixture({
            records: [
                record("small-a", "caller-a", { byteSize: 6 }),
                record("small-b", "caller-a", { byteSize: 6 }),
                record("large", "caller-a", { byteSize: 11 }),
                record("wide", "caller-a", { width: 101 }),
                record("webp", "caller-a", { mediaType: "image/webp" }),
            ],
            limits: {
                maxImagesPerTurn: 2,
                maxImageBytes: 10,
                maxImageTotalBytes: 10,
                maxImageWidth: 100,
                maxImageHeight: 100,
            },
            imageMediaTypes: ["image/png"],
        });
        const cases: readonly (readonly [
            string,
            readonly Record<string, unknown>[],
        ])[] = [
            [
                "count",
                [
                    { type: "image", resourceId: "small-a" },
                    { type: "image", resourceId: "small-a" },
                    { type: "image", resourceId: "small-a" },
                ],
            ],
            ["single-size", [{ type: "image", resourceId: "large" }]],
            [
                "total-size",
                [
                    { type: "image", resourceId: "small-a" },
                    { type: "image", resourceId: "small-b" },
                ],
            ],
            ["dimension", [{ type: "image", resourceId: "wide" }]],
            ["media", [{ type: "image", resourceId: "webp" }]],
        ];
        for (const [key, content] of cases) {
            const response = await open(fixture.url, "caller-a", key, content);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
                error: { code: "INVALID_INPUT" },
            });
        }
    });

    it("rejects model-invented output resource identities", async () => {
        const fixture = await startFixture({
            agent: {
                respond: async () => ({
                    content: [
                        { type: "image", resourceId: "model-invented-url" },
                    ],
                }),
            },
        });
        await open(fixture.url, "caller-a", "invented", [
            { type: "text", text: "生成图片" },
        ]);
        await fixture.drain.drainOne();
        const response = await find(fixture.url, "caller-a");
        expect(await response.json()).toMatchObject({
            turns: [
                {
                    status: "failed",
                    error: { code: "INVALID_OUTPUT" },
                },
            ],
        });
    });

    it("fails safely and releases prior resources when model content is inaccessible", async () => {
        const events: string[] = [];
        const base = createInMemoryAgentResourceResolver(
            [
                record("available", "caller-a"),
                record("unavailable", "caller-a"),
            ],
            {
                acquired: (id) => events.push(`acquired:${id}`),
                released: (id) => events.push(`released:${id}`),
            },
        );
        const resolver: AgentResourceResolver = {
            ...base,
            acquire: async (request) =>
                request.resource.resourceId === "unavailable"
                    ? undefined
                    : base.acquire(request),
        };
        const fixture = await startFixture({ resolver });
        await open(fixture.url, "caller-a", "access", [
            { type: "image", resourceId: "available" },
            { type: "image", resourceId: "unavailable" },
        ]);
        await fixture.drain.drainOne();
        expect(events).toEqual(["acquired:available", "released:available"]);
        const response = await find(fixture.url, "caller-a");
        expect(await response.json()).toMatchObject({
            turns: [
                {
                    status: "failed",
                    error: { code: "RESOURCE_UNAVAILABLE" },
                },
            ],
        });
    });
});

describe("Pi Interactive Agent image lifecycle", () => {
    it("passes approved images and disposes the request-local Session", async () => {
        const modelRuntime = await ModelRuntime.create({
            modelsPath: null,
            refreshOnCreate: false,
        });
        const prompt = vi.fn(async () => undefined);
        const dispose = vi.fn();
        let captured: CreateAgentSessionOptions | undefined;
        const agent = new PiInteractiveAgent({
            skills: createPosterSkillRefs(),
            instructions: ["Return one strict Conversation response."],
            modelRuntime,
            sessionFactory: async (options) => {
                captured = options;
                return fakeSessionResult({
                    prompt,
                    dispose,
                    messages: [
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text",
                                    text: '{"content":[{"type":"text","text":"ok"}]}',
                                },
                            ],
                            stopReason: "stop",
                        },
                    ],
                });
            },
        });

        await expect(agent.respond(piRequest())).resolves.toEqual({
            content: [{ type: "text", text: "ok" }],
        });
        expect(prompt).toHaveBeenCalledWith(
            expect.stringContaining('"resourceId":"input-image"'),
            {
                images: [
                    {
                        type: "image",
                        mimeType: "image/png",
                        data: "BASE64-input-image",
                    },
                ],
            },
        );
        expect(captured).toMatchObject({
            noTools: "all",
            tools: [],
            customTools: [],
        });
        expect(dispose).toHaveBeenCalledOnce();
    });

    it.each(["failed", "cancelled"] as const)(
        "disposes the Session when the Turn is %s",
        async (mode) => {
            const modelRuntime = await ModelRuntime.create({
                modelsPath: null,
                refreshOnCreate: false,
            });
            const dispose = vi.fn();
            const prompt = vi.fn(async () => {
                throw new Error("provider failure");
            });
            const agent = new PiInteractiveAgent({
                skills: createPosterSkillRefs(),
                instructions: ["Return one strict response."],
                modelRuntime,
                sessionFactory: async () =>
                    fakeSessionResult({ prompt, dispose, messages: [] }),
            });
            const request = piRequest();
            if (mode === "cancelled") {
                const controller = new AbortController();
                controller.abort();
                await expect(
                    agent.respond({ ...request, signal: controller.signal }),
                ).rejects.toThrow("aborted");
                expect(prompt).not.toHaveBeenCalled();
            } else {
                await expect(agent.respond(request)).rejects.toThrow(
                    "provider failure",
                );
            }
            expect(dispose).toHaveBeenCalledOnce();
        },
    );
});

async function startFixture(
    options: {
        records?: readonly InMemoryAgentImageRecord[];
        resolver?: AgentResourceResolver;
        events?: Parameters<typeof createInMemoryAgentResourceResolver>[1];
        agent?: InteractiveAgent;
        limits?: Partial<AgentRegistrationLimits>;
        imageMediaTypes?: readonly (
            | "image/jpeg"
            | "image/png"
            | "image/webp"
        )[];
    } = {},
) {
    const resolver =
        options.resolver ??
        createInMemoryAgentResourceResolver(
            options.records ?? [],
            options.events,
        );
    const registration = defineAgentRegistration({
        id: "design-assistant",
        version: "v1",
        revision: "image-revision-1",
        agent:
            options.agent ??
            ({
                respond: async () => ({
                    content: [{ type: "text", text: "ok" }],
                }),
            } satisfies InteractiveAgent),
        limits: options.limits,
        imageMediaTypes: options.imageMediaTypes,
    });
    const registry = createAgentRegistry([registration]);
    const store = createInMemoryAgentConversationStore();
    const queue = createInMemoryAgentTurnQueue();
    const conversations = createAgentConversations({
        registry,
        store,
        queue,
        resourceResolver: resolver,
        createConversationId: () => conversationId,
        createTurnId: () => turnId,
    });
    const drain = createAgentTurnDrain({
        source: queue,
        worker: createAgentTurnWorker({
            registry,
            store,
            resourceResolver: resolver,
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
    return { url, drain, store };
}

function record(
    resourceId: string,
    ownerId: string,
    options: Partial<AgentImageResource> & {
        outputTurnIds?: readonly string[];
    } = {},
): InMemoryAgentImageRecord {
    return {
        ownerId,
        resource: {
            resourceId,
            mediaType: options.mediaType ?? "image/png",
            byteSize: options.byteSize ?? 100,
            width: options.width ?? 20,
            height: options.height ?? 10,
        },
        modelData: `BASE64-${resourceId}`,
        projection: {
            url: `https://resources.example/${resourceId}`,
            expiresAt,
        },
        outputTurnIds: options.outputTurnIds,
    };
}

const fakeCallerIdentity: CallerIdentityResolver = {
    resolve: async (headers) => {
        const callerId = headers["x-test-caller"];
        return typeof callerId === "string" ? { callerId } : undefined;
    },
};

function open(
    url: string,
    callerId: string,
    key: string,
    content: readonly unknown[],
) {
    return fetch(`${url}/agent-conversations`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            "x-test-caller": callerId,
        },
        body: JSON.stringify({
            agent: { id: "design-assistant", version: "v1" },
            input: { content },
        }),
    });
}

function find(url: string, callerId: string) {
    return fetch(`${url}/agent-conversations/${conversationId}`, {
        headers: { "x-test-caller": callerId },
    });
}

function piRequest(): InteractiveAgentRequest {
    const resource = record("input-image", "caller-a").resource;
    return {
        conversationId,
        turnId,
        input: { content: [{ type: "image", resource }] },
        context: { history: [] },
        imageAccess: [
            {
                resourceId: resource.resourceId,
                mediaType: resource.mediaType,
                data: "BASE64-input-image",
            },
        ],
        processTools: [],
        maxToolCalls: 6,
        signal: new AbortController().signal,
    };
}

function fakeSessionResult(options: {
    prompt: (...args: unknown[]) => Promise<void>;
    dispose: () => void;
    messages: unknown[];
}): CreateAgentSessionResult {
    return {
        session: {
            prompt: options.prompt,
            abort: async () => {},
            dispose: options.dispose,
            messages: options.messages,
        },
    } as unknown as CreateAgentSessionResult;
}
