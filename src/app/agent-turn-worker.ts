/** 组装 production Agent Turn Worker、准确 Registry、持久 Store/Ledger 与 Resource Resolver */

import { writeAgentActivity } from "../agent-conversations/logging.js";
import { createBullMqAgentTurnWorker } from "../agent-conversations/queue.bullmq.js";
import { HttpOwnedAgentResourceService } from "../agent-conversations/resource.http.js";
import { createOwnedServiceAgentResourceResolver } from "../agent-conversations/resource.js";
import { createPostgresAgentConversationStore } from "../agent-conversations/store.postgres.js";
import { createPostgresAgentToolLedger } from "../agent-conversations/tools.postgres.js";
import { createAgentTurnWorker } from "../agent-conversations/worker.js";
import { createProductionAgentRuntime } from "../agents/catalog.js";
import {
    designAssistantDeletionGraceMs,
    designAssistantRetentionMs,
} from "../agents/design-assistant.js";
import { assertAgentRegistrationRevisions } from "../agents/postgres.js";
import type {
    ProcessAttemptRunner,
    ProcessRegistry,
} from "../process-runtime/index.js";
import {
    agentAdmission,
    agentConversationsEnabled,
    loadAgentConnections,
    required,
} from "./agent-conversations.js";
import {
    optionalNonEmpty,
    parseBoundedPositiveInteger,
    parsePositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { createRuntimePool } from "./postgres-pool.js";
import type { BackgroundRuntime } from "./role.js";

export function constructAgentTurnWorker(options: {
    environment: StartupEnvironment;
    processRegistry: ProcessRegistry;
    attemptRunner: ProcessAttemptRunner;
}): BackgroundRuntime | undefined {
    const { environment } = options;
    if (!agentConversationsEnabled(environment)) return undefined;
    const connections = loadAgentConnections(environment);
    const timeoutMs = parseBoundedPositiveInteger(
        environment.AGENT_TURN_TIMEOUT_MS,
        120_000,
        "AGENT_TURN_TIMEOUT_MS",
        240_000,
    );
    const claimLeaseMs = parsePositiveInteger(
        environment.AGENT_TURN_CLAIM_LEASE_MS,
        timeoutMs + 30_000,
        "AGENT_TURN_CLAIM_LEASE_MS",
    );
    if (claimLeaseMs <= timeoutMs) {
        throw new Error(
            "AGENT_TURN_CLAIM_LEASE_MS must exceed AGENT_TURN_TIMEOUT_MS",
        );
    }
    const pool = createRuntimePool({
        environment,
        connectionString: connections.databaseUrl,
        applicationName: "pipipi-agent-worker",
    });
    const store = createPostgresAgentConversationStore({
        pool,
        retentionMs: designAssistantRetentionMs,
        deletionGraceMs: designAssistantDeletionGraceMs,
        claimLeaseMs,
        admission: agentAdmission(environment),
    });
    const agents = createProductionAgentRuntime({
        environment,
        processRegistry: options.processRegistry,
        attemptRunner: options.attemptRunner,
    });
    const resourceService = new HttpOwnedAgentResourceService({
        baseUrl: required(
            environment.AGENT_RESOURCE_SERVICE_BASE_URL,
            "AGENT_RESOURCE_SERVICE_BASE_URL",
        ),
        sharedSecret: required(
            environment.AGENT_RESOURCE_SERVICE_SHARED_SECRET,
            "AGENT_RESOURCE_SERVICE_SHARED_SECRET",
        ),
        timeoutMs: parsePositiveInteger(
            environment.AGENT_RESOURCE_SERVICE_TIMEOUT_MS,
            10_000,
            "AGENT_RESOURCE_SERVICE_TIMEOUT_MS",
        ),
    });
    const ledger = createPostgresAgentToolLedger({
        pool,
        logSink: writeAgentActivity,
    });
    const worker = createBullMqAgentTurnWorker({
        redisUrl: connections.redisUrl,
        queueName: connections.queueName,
        prefix: connections.queuePrefix,
        concurrency: parsePositiveInteger(
            environment.AGENT_WORKER_CONCURRENCY,
            1,
            "AGENT_WORKER_CONCURRENCY",
        ),
        workerName: optionalNonEmpty(environment.AGENT_WORKER_NAME),
        shutdownGraceMs: parseBoundedPositiveInteger(
            environment.AGENT_WORKER_SHUTDOWN_GRACE_MS,
            30_000,
            "AGENT_WORKER_SHUTDOWN_GRACE_MS",
            60_000,
        ),
        worker: createAgentTurnWorker({
            registry: agents.registry,
            store,
            resourceResolver:
                createOwnedServiceAgentResourceResolver(resourceService),
            toolLedger: ledger,
            timeoutMs,
            logSink: writeAgentActivity,
        }),
        dependenciesReady: async () => {
            await Promise.all([
                store.ready(),
                ledger.ready(),
                resourceService.ready(),
                agents.ready(),
            ]);
            await assertAgentRegistrationRevisions({
                pool,
                registry: agents.registry,
            });
        },
    });
    return Object.freeze({
        start: worker.start,
        ready: worker.ready,
        close: async () => {
            try {
                await worker.close();
            } finally {
                await pool.end();
            }
        },
    });
}
