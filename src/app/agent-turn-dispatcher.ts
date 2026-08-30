/** 组装 production Agent Turn Outbox Dispatcher、Reconciler、PostgreSQL 与 BullMQ */
import {
    createAgentTurnDispatcherRuntime,
    createAgentTurnOutboxDispatcher,
} from "../agent-conversations/dispatcher.js";
import { createPostgresAgentTurnOutbox } from "../agent-conversations/outbox.js";
import { createBullMqAgentTurnQueue } from "../agent-conversations/queue.bullmq.js";
import { createAgentTurnReconciler } from "../agent-conversations/recovery.js";
import { createPostgresAgentConversationStore } from "../agent-conversations/store.postgres.js";
import {
    designAssistantDeletionGraceMs,
    designAssistantRetentionMs,
} from "../agents/design-assistant.js";
import {
    agentAdmission,
    agentConversationsEnabled,
    loadAgentConnections,
} from "./agent-conversations.js";
import {
    parseBoundedPositiveInteger,
    parsePositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { createRuntimePool } from "./postgres-pool.js";
import type { BackgroundRuntime } from "./role.js";

export function constructAgentTurnDispatcher(
    environment: StartupEnvironment,
): BackgroundRuntime | undefined {
    if (!agentConversationsEnabled(environment)) return undefined;
    const connections = loadAgentConnections(environment);
    const pool = createRuntimePool({
        environment,
        connectionString: connections.databaseUrl,
        applicationName: "pipipi-agent-dispatcher",
    });
    const queue = createBullMqAgentTurnQueue({
        redisUrl: connections.redisUrl,
        queueName: connections.queueName,
        prefix: connections.queuePrefix,
    });
    const store = createPostgresAgentConversationStore({
        pool,
        retentionMs: designAssistantRetentionMs,
        deletionGraceMs: designAssistantDeletionGraceMs,
        admission: agentAdmission(environment),
    });
    const dispatcher = createAgentTurnOutboxDispatcher({
        outbox: createPostgresAgentTurnOutbox({ pool }),
        queue,
        batchSize: parseBoundedPositiveInteger(
            environment.AGENT_OUTBOX_DISPATCH_BATCH_SIZE,
            25,
            "AGENT_OUTBOX_DISPATCH_BATCH_SIZE",
            100,
        ),
        claimLeaseMs: parsePositiveInteger(
            environment.AGENT_OUTBOX_CLAIM_LEASE_MS,
            30_000,
            "AGENT_OUTBOX_CLAIM_LEASE_MS",
        ),
    });
    const reconciler = createAgentTurnReconciler({
        store,
        queue,
        queuedAgeMs: parsePositiveInteger(
            environment.AGENT_TURN_RECONCILE_QUEUED_AGE_MS,
            60_000,
            "AGENT_TURN_RECONCILE_QUEUED_AGE_MS",
        ),
        batchSize: parseBoundedPositiveInteger(
            environment.AGENT_TURN_RECONCILE_BATCH_SIZE,
            25,
            "AGENT_TURN_RECONCILE_BATCH_SIZE",
            100,
        ),
    });
    return createAgentTurnDispatcherRuntime({
        dispatcher,
        reconciler,
        databaseReady: store.ready,
        queueReady: queue.ready,
        closeResources: async () => {
            try {
                await queue.close();
            } finally {
                await pool.end();
            }
        },
        dispatchIntervalMs: parsePositiveInteger(
            environment.AGENT_OUTBOX_DISPATCH_INTERVAL_MS,
            1_000,
            "AGENT_OUTBOX_DISPATCH_INTERVAL_MS",
        ),
        reconciliationIntervalMs: parsePositiveInteger(
            environment.AGENT_TURN_RECONCILE_INTERVAL_MS,
            30_000,
            "AGENT_TURN_RECONCILE_INTERVAL_MS",
        ),
    });
}
