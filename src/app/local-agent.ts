/** 组装仅供回环地址联调的单进程文本 Agent API，不访问模型或外部基础设施 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { createAgentConversations } from "../agent-conversations/index.js";
import { createInMemoryAgentTurnQueue } from "../agent-conversations/queue.js";
import {
    defineAgentRegistration,
    type InteractiveAgentRequest,
} from "../agent-conversations/registration.js";
import { createAgentRegistry } from "../agent-conversations/registry.js";
import { createInMemoryAgentConversationStore } from "../agent-conversations/store.js";
import {
    createAgentTurnDrain,
    createAgentTurnWorker,
} from "../agent-conversations/worker.js";
import {
    createProcessingApplication,
    type ProcessingApplication,
} from "../api/application.js";
import type { CallerIdentityResolver } from "../api/identity.js";
import {
    createProcessRegistry,
    createProcessRunner,
} from "../process-runtime/index.js";

const defaultAccessToken = "pipipi-local-development-token";
const defaultCallerId = "memebuy:local-development";

export type LocalAgentEnvironment = Readonly<
    Record<string, string | undefined>
>;

export type ConstructedLocalAgentService = Readonly<{
    application: ProcessingApplication;
    port: number;
}>;

export function constructLocalAgentService(
    environment: LocalAgentEnvironment,
): ConstructedLocalAgentService {
    if (environment.NODE_ENV === "production") {
        throw new Error("The local Agent service cannot run in production");
    }
    const accessToken =
        environment.PIPIPI_LOCAL_AGENT_ACCESS_TOKEN?.trim() ||
        defaultAccessToken;
    const callerId =
        environment.PIPIPI_LOCAL_AGENT_CALLER_ID?.trim() || defaultCallerId;
    assertBoundedValue(accessToken, "PIPIPI_LOCAL_AGENT_ACCESS_TOKEN", 512);
    assertBoundedValue(callerId, "PIPIPI_LOCAL_AGENT_CALLER_ID", 512);

    const registry = createAgentRegistry([
        defineAgentRegistration({
            id: "design-assistant",
            version: "v1",
            revision: "local-scripted-contract-v1",
            agent: { respond: scriptedResponse },
        }),
    ]);
    const store = createInMemoryAgentConversationStore();
    const source = createInMemoryAgentTurnQueue();
    const drain = createAgentTurnDrain({
        source,
        worker: createAgentTurnWorker({ registry, store }),
    });
    let closed = false;
    let draining = false;
    let drainRequested = false;
    const drainSoon = () => {
        drainRequested = true;
        if (closed || draining) return;
        draining = true;
        queueMicrotask(() => {
            void drainRequestedTurns(drain, () => {
                const requested = drainRequested;
                drainRequested = false;
                return requested;
            })
                .catch(() => {
                    process.stderr.write(
                        `${JSON.stringify({ event: "local_agent_turn_failed" })}\n`,
                    );
                })
                .finally(() => {
                    draining = false;
                    if (drainRequested) drainSoon();
                });
        });
    };
    const queue = Object.freeze({
        enqueue: async (job: Parameters<typeof source.enqueue>[0]) => {
            const result = await source.enqueue(job);
            drainSoon();
            return result;
        },
        close: async () => {
            closed = true;
            await source.close();
        },
    });
    const conversations = createAgentConversations({
        registry,
        store,
        queue,
    });
    const emptyProcessRegistry = createProcessRegistry([]);
    const application = createProcessingApplication({
        executor: createProcessRunner({ registry: emptyProcessRegistry }),
        http: {
            agentConversations: {
                conversations,
                callerIdentity: bearerCallerIdentity(accessToken, callerId),
                retryAfterSeconds: 1,
            },
        },
        closeResources: queue.close,
    });

    return Object.freeze({
        application,
        port: parsePort(environment.PIPIPI_LOCAL_AGENT_PORT),
    });
}

async function scriptedResponse(request: InteractiveAgentRequest) {
    const text = request.input.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    const turnNumber = request.context.history.length + 1;
    return Object.freeze({
        content: Object.freeze([
            Object.freeze({
                type: "text" as const,
                text: `本地联调回复（第 ${turnNumber} 轮）：${text}`,
            }),
        ]),
    });
}

function bearerCallerIdentity(
    expectedToken: string,
    callerId: string,
): CallerIdentityResolver {
    const expected = Buffer.from(expectedToken, "utf8");
    return Object.freeze({
        resolve: async (headers: IncomingHttpHeaders) => {
            const token = bearerToken(headers.authorization);
            if (!token) return undefined;
            const supplied = Buffer.from(token, "utf8");
            if (
                supplied.byteLength !== expected.byteLength ||
                !timingSafeEqual(supplied, expected)
            ) {
                return undefined;
            }
            return Object.freeze({ callerId });
        },
    });
}

function bearerToken(value: string | string[] | undefined): string | undefined {
    if (typeof value !== "string" || !value.startsWith("Bearer ")) {
        return undefined;
    }
    const token = value.slice("Bearer ".length).trim();
    return token.length > 0 ? token : undefined;
}

async function drainAll(drain: ReturnType<typeof createAgentTurnDrain>) {
    while ((await drain.drainOne()) !== "empty") {
        // Drain every accepted local Turn before yielding back to the next job.
    }
}

async function drainRequestedTurns(
    drain: ReturnType<typeof createAgentTurnDrain>,
    takeRequest: () => boolean,
) {
    while (takeRequest()) await drainAll(drain);
}

function parsePort(value: string | undefined): number {
    const port = value === undefined ? 4300 : Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(
            "PIPIPI_LOCAL_AGENT_PORT must be an integer between 1 and 65535",
        );
    }
    return port;
}

function assertBoundedValue(value: string, name: string, maximumBytes: number) {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < 1 || bytes > maximumBytes) {
        throw new Error(`${name} must be 1 to ${maximumBytes} UTF-8 bytes`);
    }
}
