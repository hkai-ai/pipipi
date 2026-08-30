/** 解析 Agent Conversations 生产配置并组装 API 侧 Registry、Store、Queue 与 Resource Resolver */

import { createAgentConversations } from "../agent-conversations/index.js";
import { createBullMqAgentTurnQueue } from "../agent-conversations/queue.bullmq.js";
import { HttpOwnedAgentResourceService } from "../agent-conversations/resource.http.js";
import { createOwnedServiceAgentResourceResolver } from "../agent-conversations/resource.js";
import { createPostgresAgentConversationStore } from "../agent-conversations/store.postgres.js";
import { createProductionAgentRuntime } from "../agents/catalog.js";
import {
    designAssistantDeletionGraceMs,
    designAssistantRetentionMs,
} from "../agents/design-assistant.js";
import { assertAgentRegistrationRevisions } from "../agents/postgres.js";
import type { ProcessingHttpOptions } from "../api/http.js";
import { createGatewayCallerIdentityResolver } from "../api/identity.js";
import {
    createProcessAttemptRunner,
    type ProcessRegistry,
} from "../process-runtime/index.js";
import {
    parseBoolean,
    parseConnectionUrl,
    parsePositiveInteger,
    parseQueueComponent,
    parseRequiredPositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { createRuntimePool } from "./postgres-pool.js";

export type AgentConnections = Readonly<{
    databaseUrl: string;
    redisUrl: string;
    queueName?: string;
    queuePrefix?: string;
}>;

export function agentConversationsEnabled(
    environment: StartupEnvironment,
): boolean {
    return parseBoolean(
        environment.AGENT_CONVERSATIONS_ENABLED,
        false,
        "AGENT_CONVERSATIONS_ENABLED",
    );
}

export function loadAgentConnections(
    environment: StartupEnvironment,
): AgentConnections {
    return Object.freeze({
        databaseUrl: parseConnectionUrl(environment.DATABASE_URL, {
            protocols: ["postgres:", "postgresql:"],
            requirePath: true,
            missingMessage:
                "DATABASE_URL is required when Agent Conversations are enabled",
            invalidMessage: "DATABASE_URL must be a PostgreSQL connection URL",
        }),
        redisUrl: parseConnectionUrl(environment.REDIS_URL, {
            protocols: ["redis:", "rediss:"],
            missingMessage:
                "REDIS_URL is required when Agent Conversations are enabled",
            invalidMessage: "REDIS_URL must be a Redis connection URL",
        }),
        queueName: parseQueueComponent(
            environment.AGENT_TURN_QUEUE_NAME,
            "AGENT_TURN_QUEUE_NAME",
            false,
        ),
        queuePrefix: parseQueueComponent(
            environment.AGENT_TURN_QUEUE_PREFIX,
            "AGENT_TURN_QUEUE_PREFIX",
            true,
        ),
    });
}

export function constructAgentConversationsApi(
    environment: StartupEnvironment,
    processRegistry: ProcessRegistry,
):
    | Readonly<{
          http: NonNullable<ProcessingHttpOptions["agentConversations"]>;
          close: () => Promise<void>;
      }>
    | undefined {
    if (!agentConversationsEnabled(environment)) return undefined;
    const connections = loadAgentConnections(environment);
    const pool = createRuntimePool({
        environment,
        connectionString: connections.databaseUrl,
        applicationName: "pipipi-agent-api",
    });
    const queue = createBullMqAgentTurnQueue({
        redisUrl: connections.redisUrl,
        queueName: connections.queueName,
        prefix: connections.queuePrefix,
        connectTimeoutMs: parsePositiveInteger(
            environment.ASYNC_REDIS_CONNECTION_TIMEOUT_MS,
            5_000,
            "ASYNC_REDIS_CONNECTION_TIMEOUT_MS",
        ),
    });
    const processTimeoutMs = parsePositiveInteger(
        environment.PROCESS_TIMEOUT_MS,
        30_000,
        "PROCESS_TIMEOUT_MS",
    );
    const agents = createProductionAgentRuntime({
        environment,
        processRegistry,
        attemptRunner: createProcessAttemptRunner({ processTimeoutMs }),
    });
    const admission = agentAdmission(environment);
    const store = createPostgresAgentConversationStore({
        pool,
        retentionMs: designAssistantRetentionMs,
        deletionGraceMs: designAssistantDeletionGraceMs,
        admission,
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
    const resourceResolver =
        createOwnedServiceAgentResourceResolver(resourceService);
    const conversations = createAgentConversations({
        registry: agents.registry,
        store,
        queue,
        resourceResolver,
        deletionGraceMs: designAssistantDeletionGraceMs,
    });
    const callerIdentity = createGatewayCallerIdentityResolver({
        sharedSecret: required(
            environment.AGENT_GATEWAY_SHARED_SECRET,
            "AGENT_GATEWAY_SHARED_SECRET",
        ),
        secretName: "AGENT_GATEWAY_SHARED_SECRET",
    });
    return Object.freeze({
        http: Object.freeze({
            conversations,
            callerIdentity,
            retryAfterSeconds: parsePositiveInteger(
                environment.AGENT_RETRY_AFTER_SECONDS,
                2,
                "AGENT_RETRY_AFTER_SECONDS",
            ),
            readiness: async () => {
                await Promise.all([
                    store.ready(),
                    queue.ready(),
                    resourceService.ready(),
                    agents.ready(),
                ]);
                await assertAgentRegistrationRevisions({
                    pool,
                    registry: agents.registry,
                });
            },
        }),
        close: async () => {
            try {
                await queue.close();
            } finally {
                await pool.end();
            }
        },
    });
}

export function agentAdmission(environment: StartupEnvironment) {
    const globalBacklogLimit = parseRequiredPositiveInteger(
        environment.AGENT_GLOBAL_BACKLOG_LIMIT,
        "AGENT_GLOBAL_BACKLOG_LIMIT",
        "AGENT_GLOBAL_BACKLOG_LIMIT is required when Agent Conversations are enabled",
    );
    const callerBacklogLimit = parseRequiredPositiveInteger(
        environment.AGENT_CALLER_BACKLOG_LIMIT,
        "AGENT_CALLER_BACKLOG_LIMIT",
        "AGENT_CALLER_BACKLOG_LIMIT is required when Agent Conversations are enabled",
    );
    if (callerBacklogLimit > globalBacklogLimit) {
        throw new Error(
            "AGENT_CALLER_BACKLOG_LIMIT must not exceed AGENT_GLOBAL_BACKLOG_LIMIT",
        );
    }
    return Object.freeze({
        globalBacklogLimit,
        callerBacklogLimit,
        retryAfterSeconds: parseRequiredPositiveInteger(
            environment.AGENT_BACKLOG_RETRY_AFTER_SECONDS,
            "AGENT_BACKLOG_RETRY_AFTER_SECONDS",
            "AGENT_BACKLOG_RETRY_AFTER_SECONDS is required when Agent Conversations are enabled",
        ),
    });
}

export function required(value: string | undefined, name: string): string {
    const candidate = value?.trim();
    if (!candidate) {
        throw new Error(
            `${name} is required when Agent Conversations are enabled`,
        );
    }
    return candidate;
}
