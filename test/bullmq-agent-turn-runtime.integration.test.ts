/** 用真实 PostgreSQL 与 Redis 验证 Agent Turn 发布、执行、重投、重启和 Queue 重建 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { z } from "zod";
import { createAgentTurnOutboxDispatcher } from "../src/agent-conversations/dispatcher.js";
import { createPostgresAgentTurnOutbox } from "../src/agent-conversations/outbox.js";
import {
    createBullMqAgentTurnQueue,
    createBullMqAgentTurnWorker,
} from "../src/agent-conversations/queue.bullmq.js";
import { createAgentTurnReconciler } from "../src/agent-conversations/recovery.js";
import { defineAgentRegistration } from "../src/agent-conversations/registration.js";
import { createAgentRegistry } from "../src/agent-conversations/registry.js";
import {
    createPostgresAgentConversationStore,
    type PostgresAgentConversationStore,
} from "../src/agent-conversations/store.postgres.js";
import { createPostgresAgentToolLedger } from "../src/agent-conversations/tools.postgres.js";
import { createAgentTurnWorker } from "../src/agent-conversations/worker.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";
import { acceptedConversation } from "./support/agent-conversation-store-contract.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
if (process.env.RUN_ASYNC_INTEGRATION === "1" && (!databaseUrl || !redisUrl)) {
    throw new Error(
        "POSTGRES_TEST_DATABASE_URL and REDIS_TEST_URL are required for Agent Turn integration tests",
    );
}
const integrationDescribe =
    databaseUrl && redisUrl ? describe.sequential : describe.skip;

integrationDescribe("BullMQ Agent Turn runtime", () => {
    let pool: Pool;
    let store: PostgresAgentConversationStore;
    const resources: Array<{ close: () => Promise<void> }> = [];

    beforeAll(async () => {
        assertTestDatabase(databaseUrl as string);
        pool = new Pool({ connectionString: databaseUrl, max: 6 });
        await pool.query("DROP SCHEMA public CASCADE");
        await pool.query("CREATE SCHEMA public");
        await migrate(databaseUrl as string);
    }, 30_000);

    beforeEach(async () => {
        await pool.query("TRUNCATE agent_conversations CASCADE");
        store = createPostgresAgentConversationStore({
            pool,
            retentionMs: 30 * 24 * 60 * 60 * 1_000,
            claimLeaseMs: 1_000,
        });
    });

    afterEach(async () => {
        await Promise.allSettled(
            resources
                .splice(0)
                .reverse()
                .map((resource) => resource.close()),
        );
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("dispatches a minimal Job and processes one public terminal result", async () => {
        let calls = 0;
        const registry = registryWith(async () => {
            calls += 1;
            return { content: [{ type: "text", text: "persisted result" }] };
        });
        const original = acceptedConversation(30);
        await store.accept(original);
        const queueRuntime = trackQueue();
        const { queue } = queueRuntime;
        await queue.ready();
        const dispatcher = dispatcherFor(queue);
        await expect(dispatcher.dispatchOnce()).resolves.toEqual({
            claimed: 1,
            published: 1,
            failed: 0,
        });
        const dependenciesReady = vi.fn(async () => undefined);
        const runtime = trackWorker(
            createBullMqAgentTurnWorker({
                redisUrl: redisUrl as string,
                queueName: queueRuntime.name,
                worker: createAgentTurnWorker({ registry, store }),
                dependenciesReady,
            }),
        );
        await runtime.start();
        await runtime.ready();
        expect(dependenciesReady).toHaveBeenCalledOnce();
        await vi.waitFor(async () => {
            const page = await store.findOwnedPage({
                conversationId: original.conversationId,
                ownerId: original.ownerId,
                limit: 10,
            });
            expect(page?.turns[0]).toMatchObject({
                status: "succeeded",
                output: {
                    content: [{ type: "text", text: "persisted result" }],
                },
            });
        });

        await queue.enqueue({ schemaVersion: 1, turnId: original.turnId });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(calls).toBe(1);
    });

    it("suppresses a Worker result that arrives after Conversation deletion", async () => {
        let finishAgent: (() => void) | undefined;
        const registry = registryWith(
            async () =>
                new Promise((resolve) => {
                    finishAgent = () =>
                        resolve({
                            content: [
                                { type: "text", text: "late agent result" },
                            ],
                        });
                }),
        );
        const original = acceptedConversation(34);
        await store.accept(original);
        const queueRuntime = trackQueue();
        await dispatcherFor(queueRuntime.queue).dispatchOnce();
        const runtime = trackWorker(
            createBullMqAgentTurnWorker({
                redisUrl: redisUrl as string,
                queueName: queueRuntime.name,
                worker: createAgentTurnWorker({ registry, store }),
            }),
        );
        await runtime.start();
        await vi.waitFor(async () => {
            expect(await turnStatus(original.turnId)).toBe("running");
        });

        const requestedAt = new Date().toISOString();
        await store.deleteOwned({
            conversationId: original.conversationId,
            ownerId: original.ownerId,
            requestedAt,
            deleteBy: new Date(
                new Date(requestedAt).getTime() + 60_000,
            ).toISOString(),
        });
        finishAgent?.();
        await vi.waitFor(async () => {
            const row = await pool.query<{
                status: string;
                public_output: unknown | null;
            }>(
                `SELECT status, public_output
                 FROM agent_conversation_turns WHERE turn_id = $1`,
                [original.turnId],
            );
            expect(row.rows[0]).toEqual({
                status: "failed",
                public_output: null,
            });
        });
        await expect(
            store.findOwnedMetadata(original.conversationId, original.ownerId),
        ).resolves.toBeUndefined();
    });

    it("releases publication failure and restores a lost Queue from PostgreSQL", async () => {
        const original = acceptedConversation(31);
        await store.accept(original);
        const failing = createAgentTurnOutboxDispatcher({
            outbox: createPostgresAgentTurnOutbox({ pool }),
            queue: {
                enqueue: async () => {
                    throw new Error("Redis publish failed");
                },
                close: async () => {},
            },
        });
        await expect(failing.dispatchOnce()).resolves.toEqual({
            claimed: 1,
            published: 0,
            failed: 1,
        });

        const firstQueueRuntime = trackQueue();
        const firstQueue = firstQueueRuntime.queue;
        await dispatcherFor(firstQueue).dispatchOnce();
        await expect(
            firstQueue.inspectJobs([original.turnId]),
        ).resolves.toEqual([{ turnId: original.turnId, state: "runnable" }]);
        await firstQueue.close();

        const rebuiltQueue = trackQueue().queue;
        const reconciler = createAgentTurnReconciler({
            store,
            queue: rebuiltQueue,
            queuedAgeMs: 1_000,
            clock: () => "2026-08-30T09:00:00.000Z",
        });
        await expect(reconciler.reconcileOnce()).resolves.toEqual({
            found: 1,
            enqueued: 1,
            duplicates: 0,
            deferred: 0,
            failed: 0,
        });
        await expect(
            rebuiltQueue.inspectJobs([original.turnId]),
        ).resolves.toEqual([{ turnId: original.turnId, state: "runnable" }]);
    });

    it("releases an interrupted claim and completes it after Worker restart", async () => {
        let blocked = true;
        const registry = registryWith(async (request) => {
            if (blocked) {
                await new Promise<never>((_resolve, reject) => {
                    request.signal.addEventListener(
                        "abort",
                        () => reject(new Error("worker stopped")),
                        { once: true },
                    );
                });
            }
            return { content: [{ type: "text", text: "recovered result" }] };
        });
        const original = acceptedConversation(32);
        await store.accept(original);
        const queueRuntime = trackQueue();
        const { queue } = queueRuntime;
        await dispatcherFor(queue).dispatchOnce();
        const firstWorker = trackWorker(
            createBullMqAgentTurnWorker({
                redisUrl: redisUrl as string,
                queueName: queueRuntime.name,
                worker: createAgentTurnWorker({ registry, store }),
                shutdownGraceMs: 20,
            }),
        );
        await firstWorker.start();
        await vi.waitFor(async () => {
            expect(await turnStatus(original.turnId)).toBe("running");
        });
        await firstWorker.close();
        await vi.waitFor(async () => {
            expect(await turnStatus(original.turnId)).toBe("queued");
        });

        blocked = false;
        const reconciler = createAgentTurnReconciler({
            store,
            queue,
            queuedAgeMs: 1,
            clock: () => "2026-08-30T09:00:00.000Z",
        });
        await reconciler.reconcileOnce();
        const secondWorker = trackWorker(
            createBullMqAgentTurnWorker({
                redisUrl: redisUrl as string,
                queueName: queueRuntime.name,
                worker: createAgentTurnWorker({ registry, store }),
            }),
        );
        await secondWorker.start();
        await secondWorker.ready();
        await vi.waitFor(async () => {
            expect(await turnStatus(original.turnId)).toBe("succeeded");
        });
    });

    it("replays a committed priced Tool after Worker restart without charging twice", async () => {
        let blocked = true;
        let capabilityCalls = 0;
        const registration = defineAgentRegistration({
            id: "design-assistant",
            version: "v1",
            revision: "registration-revision-1",
            agent: {
                respond: async (request) => {
                    const result = await request.processTools[0]?.execute({
                        content: "paid design",
                    });
                    if (blocked) {
                        await new Promise<never>((_resolve, reject) => {
                            request.signal.addEventListener(
                                "abort",
                                () => reject(new Error("worker stopped")),
                                { once: true },
                            );
                        });
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: toolContent(result),
                            },
                        ],
                    };
                },
            },
            processTools: {
                specs: [
                    {
                        process: "render-design",
                        version: "v1",
                        toolName: "render_design",
                        description: "Render one design",
                        sideEffect: "priced",
                    },
                ],
                registry: createProcessRegistry([
                    defineProcessRegistration({
                        id: "render-design",
                        version: "v1",
                        inputSchema: z.strictObject({
                            content: z.string().min(1),
                        }),
                        outputSchema: z.strictObject({
                            content: z.string().min(1),
                        }),
                        activities: [],
                        execute: async () => {
                            capabilityCalls += 1;
                            return { content: "paid result" };
                        },
                    }),
                ]),
                attemptRunner: createProcessAttemptRunner(),
            },
        });
        const registry = createAgentRegistry([registration]);
        const original = acceptedConversation(33);
        await store.accept(original);
        const queueRuntime = trackQueue();
        const { queue } = queueRuntime;
        await dispatcherFor(queue).dispatchOnce();
        const firstWorker = trackWorker(
            createBullMqAgentTurnWorker({
                redisUrl: redisUrl as string,
                queueName: queueRuntime.name,
                worker: createAgentTurnWorker({
                    registry,
                    store,
                    toolLedger: createPostgresAgentToolLedger({ pool }),
                }),
                shutdownGraceMs: 20,
            }),
        );
        await firstWorker.start();
        await vi.waitFor(() => expect(capabilityCalls).toBe(1));
        await firstWorker.close();
        await vi.waitFor(async () => {
            expect(await turnStatus(original.turnId)).toBe("queued");
        });

        blocked = false;
        await createAgentTurnReconciler({
            store,
            queue,
            queuedAgeMs: 1,
            clock: () => "2026-08-30T09:00:00.000Z",
        }).reconcileOnce();
        const secondWorker = trackWorker(
            createBullMqAgentTurnWorker({
                redisUrl: redisUrl as string,
                queueName: queueRuntime.name,
                worker: createAgentTurnWorker({
                    registry,
                    store,
                    toolLedger: createPostgresAgentToolLedger({ pool }),
                }),
            }),
        );
        await secondWorker.start();
        await secondWorker.ready();
        await vi.waitFor(async () => {
            expect(await turnStatus(original.turnId)).toBe("succeeded");
        });
        expect(capabilityCalls).toBe(1);
    });

    function trackQueue() {
        const name = `agent-test-${randomUUID().slice(0, 8)}`;
        const queue = createBullMqAgentTurnQueue({
            redisUrl: redisUrl as string,
            queueName: name,
        });
        resources.push(queue);
        return Object.freeze({ name, queue });
    }

    function trackWorker<Worker extends { close: () => Promise<void> }>(
        worker: Worker,
    ): Worker {
        resources.push(worker);
        return worker;
    }

    function dispatcherFor(queue: ReturnType<typeof trackQueue>["queue"]) {
        return createAgentTurnOutboxDispatcher({
            outbox: createPostgresAgentTurnOutbox({ pool }),
            queue,
        });
    }

    async function turnStatus(turnId: string): Promise<string | undefined> {
        const result = await pool.query<{ status: string }>(
            "SELECT status FROM agent_conversation_turns WHERE turn_id = $1",
            [turnId],
        );
        return result.rows[0]?.status;
    }
});

function registryWith(
    respond: Parameters<typeof defineAgentRegistration>[0]["agent"]["respond"],
) {
    return createAgentRegistry([
        defineAgentRegistration({
            id: "design-assistant",
            version: "v1",
            revision: "registration-revision-1",
            agent: { respond },
        }),
    ]);
}

function toolContent(value: unknown): string {
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
    throw new Error("Tool did not return content");
}

async function migrate(url: string) {
    return runner({
        databaseUrl: url,
        direction: "up",
        dir: path.resolve("migrations"),
        migrationsTable: "pgmigrations",
        count: Infinity,
        advisoryLockMode: "wait",
        log: () => {},
    });
}

function assertTestDatabase(url: string): void {
    const databaseName = new URL(url).pathname.slice(1);
    if (!databaseName.endsWith("_test")) {
        throw new Error(
            "PostgreSQL integration tests require a database name ending in _test",
        );
    }
}
