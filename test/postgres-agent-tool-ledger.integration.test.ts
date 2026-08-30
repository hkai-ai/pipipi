/** 用真实 PostgreSQL 验证 Agent Tool Ledger 的重放、预算、fencing 与 after-commit 语义 */
import path from "node:path";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { z } from "zod";
import { defineAgentRegistration } from "../src/agent-conversations/registration.js";
import { createAgentRegistry } from "../src/agent-conversations/registry.js";
import { createPostgresAgentConversationStore } from "../src/agent-conversations/store.postgres.js";
import {
    agentToolInputFingerprint,
    agentToolInvocationId,
} from "../src/agent-conversations/tools.js";
import {
    type AgentToolActivity,
    createPostgresAgentToolLedger,
} from "../src/agent-conversations/tools.postgres.js";
import { createAgentTurnWorker } from "../src/agent-conversations/worker.js";
import type { ProcessToolSpec } from "../src/agent-runtime/process-tools.js";
import { createProcessToolRuntime } from "../src/agent-runtime/process-tools.js";
import {
    createProcessAttemptRunner,
    createProcessRegistry,
    defineProcessRegistration,
} from "../src/process-runtime/index.js";
import {
    acceptedConversation,
    acceptedTurn,
    timestamp,
} from "./support/agent-conversation-store-contract.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
if (process.env.RUN_POSTGRES_INTEGRATION === "1" && !databaseUrl) {
    throw new Error(
        "POSTGRES_TEST_DATABASE_URL is required for Agent Tool Ledger integration tests",
    );
}
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;
const pricedSpec: ProcessToolSpec = Object.freeze({
    process: "render-design",
    version: "v1",
    toolName: "render_design",
    description: "Render one design",
    sideEffect: "priced",
});
const limits = Object.freeze({
    maxCallsPerTurn: 6,
    maxPricedCallsPerTurn: 1,
    maxPricedCallsPerConversation: 10,
});

postgresDescribe("PostgreSQL Agent Tool Ledger", () => {
    let pool: Pool;

    beforeAll(async () => {
        assertTestDatabase(databaseUrl as string);
        pool = new Pool({ connectionString: databaseUrl, max: 6 });
        await pool.query("DROP SCHEMA public CASCADE");
        await pool.query("CREATE SCHEMA public");
        await migrate(databaseUrl as string);
    }, 30_000);

    beforeEach(async () => {
        await pool.query("TRUNCATE agent_conversations CASCADE");
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("persists a stable child Run and replays it after Ledger restart", async () => {
        const original = acceptedConversation(40);
        await conversationStore().accept(original);
        let calls = 0;
        const runtime = pricedRuntime(async (content) => {
            calls += 1;
            return { content: `rendered:${content}` };
        });
        const activities: AgentToolActivity[] = [];
        const first = createPostgresAgentToolLedger({
            pool,
            logSink: (activity) => activities.push(activity),
        });
        const firstResult = await binding(
            first,
            original,
            runtime,
        ).tools[0]?.execute({ content: "private brief" });
        const restarted = createPostgresAgentToolLedger({ pool });
        const replay = await binding(
            restarted,
            original,
            runtime,
        ).tools[0]?.execute({ content: "private brief" });

        expect(replay).toEqual(firstResult);
        expect(calls).toBe(1);
        await expect(
            restarted.findRecords(original.turnId),
        ).resolves.toMatchObject([
            {
                invocationId: `${original.turnId}.1`,
                invocation: 1,
                process: "render-design",
                version: "v1",
                sideEffect: "priced",
                status: "succeeded",
            },
        ]);
        const stored = await pool.query<{
            child_run_id: string;
            input_fingerprint: string;
            status: string;
        }>(
            "SELECT child_run_id, input_fingerprint, status FROM agent_tool_invocations",
        );
        expect(stored.rows).toEqual([
            {
                child_run_id: `${original.turnId}.1`,
                input_fingerprint: agentToolInputFingerprint({
                    toolName: "render_design",
                    input: { content: "private brief" },
                }),
                status: "succeeded",
            },
        ]);
        expect(JSON.stringify(activities)).not.toContain("private brief");
    });

    it("recovers prepared work but fences uncertain priced execution", async () => {
        const original = acceptedConversation(41);
        await conversationStore().accept(original);
        const invocationId = agentToolInvocationId(original.turnId, 1);
        const fingerprint = agentToolInputFingerprint({
            toolName: pricedSpec.toolName,
            input: { content: "recover" },
        });
        await pool.query(
            `
        INSERT INTO agent_tool_invocations (
          invocation_id, conversation_id, turn_id, invocation, tool_name,
          process_id, process_version, input_fingerprint, side_effect,
          child_run_id, status, created_at, updated_at
        )
        VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'priced', $1, 'prepared', $8, $8)
      `,
            [
                invocationId,
                original.conversationId,
                original.turnId,
                pricedSpec.toolName,
                pricedSpec.process,
                pricedSpec.version,
                fingerprint,
                timestamp(1),
            ],
        );
        let calls = 0;
        let release: ((value: { content: string }) => void) | undefined;
        const runtime = pricedRuntime(
            () =>
                new Promise((resolve) => {
                    calls += 1;
                    release = resolve;
                }),
        );
        const firstLedger = createPostgresAgentToolLedger({ pool });
        const first = binding(firstLedger, original, runtime).tools[0]?.execute(
            {
                content: "recover",
            },
        );
        await vi.waitFor(() => expect(calls).toBe(1));

        const recoveredLedger = createPostgresAgentToolLedger({ pool });
        await expect(
            binding(recoveredLedger, original, runtime).tools[0]?.execute({
                content: "recover",
            }),
        ).resolves.toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
        });
        release?.({ content: "late result" });
        await expect(first).resolves.toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
        });
        expect(calls).toBe(1);
        await expect(
            recoveredLedger.findRecords(original.turnId),
        ).resolves.toMatchObject([
            {
                status: "failed",
                error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
            },
        ]);
    });

    it("rejects changed input and keeps the priced budget across adapters", async () => {
        const original = acceptedConversation(42);
        await conversationStore().accept(original);
        let calls = 0;
        const runtime = pricedRuntime(async (content) => {
            calls += 1;
            return { content };
        });
        const first = createPostgresAgentToolLedger({ pool });
        await binding(first, original, runtime).tools[0]?.execute({
            content: "first",
        });
        const restarted = createPostgresAgentToolLedger({ pool });
        await expect(
            binding(restarted, original, runtime).tools[0]?.execute({
                content: "changed",
            }),
        ).resolves.toMatchObject({
            error: { code: "TOOL_INVOCATION_CONFLICT" },
        });
        expect(calls).toBe(1);
    });

    it("enforces per-Turn and per-Conversation priced budgets across adapters", async () => {
        const original = acceptedConversation(44);
        const store = conversationStore();
        await store.accept(original);
        let calls = 0;
        const runtime = pricedRuntime(async (content) => {
            calls += 1;
            return { content };
        });
        const firstBinding = binding(
            createPostgresAgentToolLedger({ pool }),
            original,
            runtime,
        );
        await firstBinding.tools[0]?.execute({ content: "turn-1" });
        await expect(
            firstBinding.tools[0]?.execute({ content: "turn-1-again" }),
        ).resolves.toMatchObject({
            error: { code: "PRICED_TURN_BUDGET_EXHAUSTED" },
        });
        await finishTurn(store, original.turnId, 1);

        let previousTurnId = original.turnId;
        for (let sequence = 2; sequence <= 10; sequence += 1) {
            const turn = acceptedTurn(original, sequence, {
                afterTurnId: previousTurnId,
            });
            await store.acceptTurn(turn);
            await binding(
                createPostgresAgentToolLedger({ pool }),
                { ...original, turnId: turn.turnId },
                runtime,
            ).tools[0]?.execute({ content: `turn-${sequence}` });
            await finishTurn(store, turn.turnId, sequence);
            previousTurnId = turn.turnId;
        }
        const eleventh = acceptedTurn(original, 11, {
            afterTurnId: previousTurnId,
        });
        await store.acceptTurn(eleventh);
        await expect(
            binding(
                createPostgresAgentToolLedger({ pool }),
                { ...original, turnId: eleventh.turnId },
                runtime,
            ).tools[0]?.execute({ content: "turn-11" }),
        ).resolves.toMatchObject({
            error: { code: "PRICED_CONVERSATION_BUDGET_EXHAUSTED" },
        });
        expect(calls).toBe(10);
    });

    it("maps invalid Agent output after a priced success to after-commit", async () => {
        const original = acceptedConversation(43);
        const store = conversationStore();
        await store.accept(original);
        let calls = 0;
        const registration = defineAgentRegistration({
            id: original.agent.id,
            version: original.agent.version,
            revision: original.configRevision,
            agent: {
                respond: async (request) => {
                    await request.processTools[0]?.execute({
                        content: "design",
                    });
                    return { content: [{ type: "text", text: "invented" }] };
                },
            },
            processTools: {
                specs: [pricedSpec],
                registry: runtimeRegistry(async () => {
                    calls += 1;
                    return { content: "paid result" };
                }),
                attemptRunner: createProcessAttemptRunner(),
            },
        });
        const worker = createAgentTurnWorker({
            registry: createAgentRegistry([registration]),
            store,
            toolLedger: createPostgresAgentToolLedger({ pool }),
        });

        await expect(
            worker.process({ schemaVersion: 1, turnId: original.turnId }),
        ).resolves.toBe("processed");
        const page = await store.findOwnedPage({
            conversationId: original.conversationId,
            ownerId: original.ownerId,
            limit: 10,
        });
        expect(page?.turns[0]).toMatchObject({
            status: "failed",
            error: { code: "DEPENDENCY_FAILURE_AFTER_COMMIT" },
        });
        expect(calls).toBe(1);
    });

    function conversationStore() {
        return createPostgresAgentConversationStore({
            pool,
            retentionMs: 30 * 24 * 60 * 60 * 1_000,
        });
    }
});

async function finishTurn(
    store: ReturnType<typeof createPostgresAgentConversationStore>,
    turnId: string,
    sequence: number,
): Promise<void> {
    const started = await store.start({
        turnId,
        startedAt: timestamp(sequence * 3 + 1),
    });
    if (!started) throw new Error("Expected Agent Turn to start");
    const completed = await store.complete({
        turnId,
        completedAt: timestamp(sequence * 3 + 2),
        completion: {
            status: "succeeded",
            output: { content: [{ type: "text", text: "done" }] },
        },
    });
    if (!completed) throw new Error("Expected Agent Turn to complete");
}

function binding(
    ledger: ReturnType<typeof createPostgresAgentToolLedger>,
    conversation: ReturnType<typeof acceptedConversation>,
    runtime: ReturnType<typeof pricedRuntime>,
) {
    return ledger.bind({
        conversationId: conversation.conversationId,
        turnId: conversation.turnId,
        runtime,
        limits,
        signal: new AbortController().signal,
    });
}

function pricedRuntime(
    execute: (content: string) => Promise<{ content: string }>,
) {
    return createProcessToolRuntime({
        specs: [pricedSpec],
        registry: runtimeRegistry(async (input) => execute(input.content)),
        attemptRunner: createProcessAttemptRunner(),
    });
}

function runtimeRegistry(
    execute: (input: { content: string }) => Promise<{ content: string }>,
) {
    return createProcessRegistry([
        defineProcessRegistration({
            id: pricedSpec.process,
            version: pricedSpec.version,
            inputSchema: z.strictObject({ content: z.string().min(1) }),
            outputSchema: z.strictObject({ content: z.string().min(1) }),
            activities: [],
            execute,
        }),
    ]);
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
