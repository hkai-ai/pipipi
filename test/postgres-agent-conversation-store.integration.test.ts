/** 通过真实 PostgreSQL 验证 Agent Conversation 事务、重启、并发与 Outbox */
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
} from "vitest";
import { createAgentConversations } from "../src/agent-conversations/index.js";
import { createPostgresAgentTurnOutbox } from "../src/agent-conversations/outbox.js";
import { createInMemoryAgentTurnQueue } from "../src/agent-conversations/queue.js";
import { defineAgentRegistration } from "../src/agent-conversations/registration.js";
import { createAgentRegistry } from "../src/agent-conversations/registry.js";
import type { AgentConversationStore } from "../src/agent-conversations/store.js";
import { createPostgresAgentConversationStore } from "../src/agent-conversations/store.postgres.js";
import { createProcessingApplication } from "../src/api/application.js";
import type { CallerIdentityResolver } from "../src/api/identity.js";
import {
    acceptedConversation,
    acceptedTurn,
    agentConversationStoreContract,
    timestamp,
} from "./support/agent-conversation-store-contract.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
if (process.env.RUN_POSTGRES_INTEGRATION === "1" && !databaseUrl) {
    throw new Error(
        "POSTGRES_TEST_DATABASE_URL is required for PostgreSQL integration tests",
    );
}
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;
const runningApplications: Array<{ close: () => Promise<void> }> = [];

postgresDescribe("PostgreSQL Agent Conversation Store", () => {
    let primaryPool: Pool;
    let secondaryPool: Pool;
    let primaryStore: AgentConversationStore;
    let secondaryStore: AgentConversationStore;

    beforeAll(async () => {
        assertTestDatabase(databaseUrl as string);
        primaryPool = new Pool({ connectionString: databaseUrl, max: 4 });
        secondaryPool = new Pool({ connectionString: databaseUrl, max: 2 });
        await primaryPool.query("DROP SCHEMA public CASCADE");
        await primaryPool.query("CREATE SCHEMA public");
        await migrate("up");
        primaryStore = postgresStore(primaryPool);
        secondaryStore = postgresStore(secondaryPool);
    }, 30_000);

    beforeEach(async () => {
        await primaryPool.query("TRUNCATE agent_conversations CASCADE");
    });

    afterEach(async () => {
        await Promise.all(
            runningApplications
                .splice(0)
                .map((application) => application.close()),
        );
    });

    afterAll(async () => {
        await Promise.all([primaryPool?.end(), secondaryPool?.end()]);
    });

    agentConversationStoreContract("PostgreSQL", () => primaryStore);

    it("keeps Turn, operation and outbox atomic when outbox insertion fails", async () => {
        const original = acceptedConversation(20);
        const duplicateOutboxStore = createPostgresAgentConversationStore({
            pool: primaryPool,
            retentionMs: 30 * 24 * 60 * 60 * 1_000,
            createOutboxMessageId: () => "same-outbox-message",
        });
        await duplicateOutboxStore.accept(original);
        await finish(original.turnId, duplicateOutboxStore);
        const second = acceptedTurn(original, 2);

        await expect(
            duplicateOutboxStore.acceptTurn(second),
        ).rejects.toMatchObject({ code: "23505" });
        await expect(
            primaryStore.findOwnedMetadata(
                original.conversationId,
                original.ownerId,
            ),
        ).resolves.toMatchObject({ turnCount: 1, busy: false });
        await expect(primaryStore.acceptTurn(second)).resolves.toMatchObject({
            outcome: "created",
            turn: { sequence: 2 },
        });
    });

    it("serializes concurrent continuation across adapter instances", async () => {
        const original = acceptedConversation(21);
        await primaryStore.accept(original);
        await finish(original.turnId, primaryStore);
        const left = acceptedTurn(original, 2, {
            turnId: "turn-concurrent-left",
            idempotencyKey: "continue-concurrent-left",
            requestFingerprint: "c".repeat(64),
        });
        const right = acceptedTurn(original, 2, {
            turnId: "turn-concurrent-right",
            idempotencyKey: "continue-concurrent-right",
            requestFingerprint: "d".repeat(64),
        });

        const outcomes = await Promise.all([
            primaryStore.acceptTurn(left),
            secondaryStore.acceptTurn(right),
        ]);
        expect(outcomes.map((result) => result.outcome).sort()).toEqual([
            "busy",
            "created",
        ]);
        await expect(
            primaryStore.findOwnedMetadata(
                original.conversationId,
                original.ownerId,
            ),
        ).resolves.toMatchObject({ turnCount: 2, busy: true });
    });

    it("releases, reclaims and acknowledges durable outbox messages", async () => {
        const original = acceptedConversation(22);
        await primaryStore.accept(original);
        const first = createPostgresAgentTurnOutbox({ pool: primaryPool });
        const second = createPostgresAgentTurnOutbox({ pool: secondaryPool });

        const [claimed] = await first.claim({
            limit: 10,
            claimToken: "dispatcher-one",
            claimedAt: timestamp(1),
            claimExpiresAt: timestamp(31),
        });
        expect(claimed).toMatchObject({
            job: { schemaVersion: 1, turnId: original.turnId },
        });
        if (!claimed) throw new Error("Expected Agent Turn outbox claim");
        await expect(
            first.release({
                messageId: claimed.messageId,
                claimToken: claimed.claimToken,
            }),
        ).resolves.toBe(true);

        const [reclaimed] = await second.claim({
            limit: 1,
            claimToken: "dispatcher-two",
            claimedAt: timestamp(2),
            claimExpiresAt: timestamp(32),
        });
        if (!reclaimed) throw new Error("Expected released outbox message");
        await expect(
            second.markPublished({
                messageId: reclaimed.messageId,
                claimToken: reclaimed.claimToken,
                publishedAt: timestamp(3),
            }),
        ).resolves.toBe(true);
        await expect(
            first.claim({
                limit: 1,
                claimToken: "dispatcher-three",
                claimedAt: timestamp(4),
                claimExpiresAt: timestamp(34),
            }),
        ).resolves.toEqual([]);
    });

    it("enforces public Content Block bounds without persistence fields for model internals", async () => {
        const oversized = acceptedConversation(23, {
            acceptedInput: {
                content: [{ type: "text", text: "x".repeat(280_000) }],
            },
        });
        await expect(primaryStore.accept(oversized)).rejects.toMatchObject({
            code: "23514",
        });
        await expect(
            primaryStore.findOwnedMetadata(
                oversized.conversationId,
                oversized.ownerId,
            ),
        ).resolves.toBeUndefined();

        const columns = await primaryPool.query<{ column_name: string }>(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name IN ('agent_conversations', 'agent_conversation_turns')
        `);
        const names = columns.rows.map((row) => row.column_name);
        expect(names).toContain("working_summary");
        expect(names).not.toEqual(
            expect.arrayContaining([
                "compiled_prompt",
                "hidden_reasoning",
                "provider_messages",
                "secret",
                "internal_error",
            ]),
        );
    });

    it("preserves HTTP identity and idempotency across API restart", async () => {
        const registry = createAgentRegistry([
            defineAgentRegistration({
                id: "design-assistant",
                version: "v1",
                revision: "postgres-registration-1",
                agent: {
                    respond: async () => ({
                        content: [{ type: "text", text: "unused" }],
                    }),
                },
            }),
        ]);
        const body = {
            agent: { id: "design-assistant", version: "v1" },
            input: {
                content: [{ type: "text", text: "persist this request" }],
            },
        };
        const first = await startHttp({
            store: primaryStore,
            registry,
            conversationId: "conversation-before-restart",
            turnId: "turn-before-restart",
        });
        const accepted = await fetch(`${first.url}/agent-conversations`, {
            method: "POST",
            headers: operationHeaders("restart-key"),
            body: JSON.stringify(body),
        });
        expect(accepted.status).toBe(202);
        const acceptedBody = await accepted.json();
        await first.application.close();
        runningApplications.splice(
            runningApplications.indexOf(first.application),
            1,
        );

        const restarted = await startHttp({
            store: secondaryStore,
            registry,
            conversationId: "new-candidate-conversation",
            turnId: "new-candidate-turn",
        });
        const found = await fetch(
            `${restarted.url}/agent-conversations/conversation-before-restart`,
            { headers: { "x-test-caller": "caller-restart" } },
        );
        expect(found.status).toBe(200);
        expect(await found.json()).toMatchObject({
            conversationId: "conversation-before-restart",
            turns: [{ turnId: "turn-before-restart", status: "queued" }],
        });
        const replay = await fetch(`${restarted.url}/agent-conversations`, {
            method: "POST",
            headers: operationHeaders("restart-key"),
            body: JSON.stringify(body),
        });
        expect(replay.status).toBe(202);
        expect(await replay.json()).toEqual(acceptedBody);
    });

    it("rolls migration back without changing Process Run tables", async () => {
        await migrate("down", 1);
        const tables = await primaryPool.query<{
            process_runs: string | null;
            agent_conversations: string | null;
        }>(`
          SELECT
            to_regclass('public.process_runs')::text AS process_runs,
            to_regclass('public.agent_conversations')::text AS agent_conversations
        `);
        expect(tables.rows[0]).toEqual({
            process_runs: "process_runs",
            agent_conversations: null,
        });
        await migrate("up");
    });

    async function migrate(direction: "up" | "down", count = Infinity) {
        return runner({
            databaseUrl: databaseUrl as string,
            direction,
            dir: path.resolve("migrations"),
            migrationsTable: "pgmigrations",
            count,
            advisoryLockMode: "wait",
            log: () => {},
        });
    }
});

function postgresStore(pool: Pool): AgentConversationStore {
    return createPostgresAgentConversationStore({
        pool,
        retentionMs: 30 * 24 * 60 * 60 * 1_000,
    });
}

async function finish(
    turnId: string,
    store: AgentConversationStore,
): Promise<void> {
    const started = await store.start({ turnId, startedAt: timestamp(1) });
    if (!started) throw new Error("Expected Agent Turn start");
    const completed = await store.complete({
        turnId,
        completedAt: timestamp(2),
        completion: {
            status: "succeeded",
            output: { content: [{ type: "text", text: "done" }] },
        },
    });
    if (!completed) throw new Error("Expected Agent Turn completion");
}

async function startHttp(options: {
    store: AgentConversationStore;
    registry: ReturnType<typeof createAgentRegistry>;
    conversationId: string;
    turnId: string;
}) {
    const conversations = createAgentConversations({
        registry: options.registry,
        store: options.store,
        queue: createInMemoryAgentTurnQueue(),
        createConversationId: () => options.conversationId,
        createTurnId: () => options.turnId,
        clock: () => timestamp(0),
    });
    const application = createProcessingApplication({
        executor: {
            execute: async () => ({
                runId: "run-unused",
                process: "unused",
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
    return { application, url };
}

const fakeCallerIdentity: CallerIdentityResolver = {
    resolve: async (headers) => {
        const callerId = headers["x-test-caller"];
        return typeof callerId === "string" ? { callerId } : undefined;
    },
};

function operationHeaders(idempotencyKey: string) {
    return {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-test-caller": "caller-restart",
    };
}

function assertTestDatabase(url: string): void {
    const databaseName = new URL(url).pathname.slice(1);
    if (!databaseName.endsWith("_test")) {
        throw new Error(
            "PostgreSQL integration tests require a database name ending in _test",
        );
    }
}
