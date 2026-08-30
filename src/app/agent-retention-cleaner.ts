/** 组装 production Agent Conversation 过期与墓碑清理 Runtime */
import {
    createAgentConversationCleaner,
    createAgentConversationCleanerRuntime,
} from "../agent-conversations/retention.js";
import { createPostgresAgentConversationCleanup } from "../agent-conversations/retention.postgres.js";
import { designAssistantDeletionGraceMs } from "../agents/design-assistant.js";
import { agentConversationsEnabled } from "./agent-conversations.js";
import {
    parseBoundedPositiveInteger,
    parseConnectionUrl,
    parsePositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { createRuntimePool } from "./postgres-pool.js";
import type { BackgroundRuntime } from "./role.js";

export function constructAgentRetentionCleaner(
    environment: StartupEnvironment,
): BackgroundRuntime | undefined {
    if (!agentConversationsEnabled(environment)) return undefined;
    const pool = createRuntimePool({
        environment,
        connectionString: parseConnectionUrl(environment.DATABASE_URL, {
            protocols: ["postgres:", "postgresql:"],
            requirePath: true,
            missingMessage:
                "DATABASE_URL is required when Agent Conversations are enabled",
            invalidMessage: "DATABASE_URL must be a PostgreSQL connection URL",
        }),
        applicationName: "pipipi-agent-retention-cleaner",
    });
    const cleanup = createPostgresAgentConversationCleanup({
        pool,
        deletionGraceMs: designAssistantDeletionGraceMs,
    });
    const cleaner = createAgentConversationCleaner({
        cleanup,
        batchSize: parseBoundedPositiveInteger(
            environment.AGENT_RETENTION_CLEANUP_BATCH_SIZE,
            25,
            "AGENT_RETENTION_CLEANUP_BATCH_SIZE",
            100,
        ),
        maximumBatchesPerSweep: parseBoundedPositiveInteger(
            environment.AGENT_RETENTION_CLEANUP_MAX_BATCHES_PER_SWEEP,
            100,
            "AGENT_RETENTION_CLEANUP_MAX_BATCHES_PER_SWEEP",
            10_000,
        ),
    });
    return createAgentConversationCleanerRuntime({
        cleaner,
        databaseReady: cleanup.ready,
        closeResources: () => pool.end(),
        intervalMs: parsePositiveInteger(
            environment.AGENT_RETENTION_CLEANUP_INTERVAL_MS,
            3_600_000,
            "AGENT_RETENTION_CLEANUP_INTERVAL_MS",
        ),
    });
}
