import {
    createHttpAvailabilityProbe,
    createPublicHttpAvailabilityProbe,
    type PublicHttpAvailabilityClient,
} from "../availability/http.js";
import {
    type AvailabilityMonitor,
    type AvailabilityProbe,
    createAvailabilityMonitor,
} from "../availability/monitor.js";
import {
    createRedisAvailabilityProbe,
    type RedisAvailabilityClient,
} from "../availability/redis.js";
import { createGenericAvailabilityWebhookNotifier } from "../availability/webhook.js";
import type { WebhookHttpClient } from "../webhooks/delivery/target-policy.js";
import {
    parseBoolean,
    parsePositiveInteger,
    type StartupEnvironment,
} from "./config.js";
import { assertDeploymentEnvironment } from "./deployment-environment.js";

export function constructAvailabilityMonitor(
    environment: StartupEnvironment,
    dependencies: {
        request?: (input: string, init: RequestInit) => Promise<Response>;
        publicHttpClient?: PublicHttpAvailabilityClient;
        redisClient?: RedisAvailabilityClient;
        webhookHttpClient?: WebhookHttpClient;
        clock?: () => string;
        monotonicClock?: () => number;
    } = {},
): AvailabilityMonitor {
    assertDeploymentEnvironment(environment, "availability-monitor");
    const revision = requiredRevision(environment.PIPIPI_REVISION);
    const publicBaseUrl = publicBase(environment.AVAILABILITY_PUBLIC_BASE_URL);
    const webhookUrl = required(
        environment.AVAILABILITY_WEBHOOK_URL,
        "AVAILABILITY_WEBHOOK_URL is required for Availability Monitor",
    );
    const timeoutMs = parsePositiveInteger(
        environment.AVAILABILITY_PROBE_TIMEOUT_MS,
        5_000,
        "AVAILABILITY_PROBE_TIMEOUT_MS",
    );
    const asyncRolesEnabled = parseBoolean(
        environment.AVAILABILITY_ASYNC_ROLES_ENABLED,
        false,
        "AVAILABILITY_ASYNC_ROLES_ENABLED",
    );
    const request = dependencies.request;
    const monotonicClock = dependencies.monotonicClock;
    const probes = [
        createPublicHttpAvailabilityProbe({
            name: "gateway-health",
            url: new URL("/healthz", publicBaseUrl).toString(),
            expectedStatus: "ok",
            timeoutMs,
            client: dependencies.publicHttpClient,
            clock: monotonicClock,
        }),
        createPublicHttpAvailabilityProbe({
            name: "gateway-readiness",
            url: new URL("/readyz", publicBaseUrl).toString(),
            expectedStatus: "ready",
            timeoutMs,
            client: dependencies.publicHttpClient,
            clock: monotonicClock,
        }),
        createHttpAvailabilityProbe({
            name: "business-api-readiness",
            url: "http://127.0.0.1:4400/readyz",
            expectedStatus: "ok",
            timeoutMs,
            request,
            clock: monotonicClock,
        }),
        ...(asyncRolesEnabled
            ? asyncRoleProbes({ timeoutMs, request, clock: monotonicClock })
            : []),
        redisProbe(environment.REDIS_URL, {
            timeoutMs,
            client: dependencies.redisClient,
            clock: monotonicClock,
        }),
    ];

    return createAvailabilityMonitor({
        revision,
        probes,
        notifier: createGenericAvailabilityWebhookNotifier({
            url: webhookUrl,
            timeoutMs: parsePositiveInteger(
                environment.AVAILABILITY_WEBHOOK_TIMEOUT_MS,
                10_000,
                "AVAILABILITY_WEBHOOK_TIMEOUT_MS",
            ),
            httpClient: dependencies.webhookHttpClient,
        }),
        clock: dependencies.clock,
    });
}

function redisProbe(
    value: string | undefined,
    options: {
        timeoutMs: number;
        client?: RedisAvailabilityClient;
        clock?: () => number;
    },
): AvailabilityProbe {
    const candidate = value?.trim();
    if (!candidate) {
        return unavailableRedisProbe("REDIS_CONFIGURATION_MISSING", false);
    }
    try {
        return createRedisAvailabilityProbe({
            redisUrl: candidate,
            ...options,
        });
    } catch {
        return unavailableRedisProbe("REDIS_CONFIGURATION_INVALID", true);
    }
}

function unavailableRedisProbe(
    errorCode: string,
    configurationPresent: boolean,
): AvailabilityProbe {
    return Object.freeze({
        name: "redis",
        kind: "redis" as const,
        inspect: async () =>
            Object.freeze({
                status: "unavailable" as const,
                latencyMs: 0,
                attributes: Object.freeze({ configurationPresent }),
                errorCode,
            }),
    });
}

function asyncRoleProbes(options: {
    timeoutMs: number;
    request?: (input: string, init: RequestInit) => Promise<Response>;
    clock?: () => number;
}) {
    const roles = [
        ["process-dispatcher", 4310],
        ["process-worker", 4320],
        ["webhook-worker", 4330],
        ["retention-cleaner", 4340],
    ] as const;
    return roles.map(([role, port]) =>
        createHttpAvailabilityProbe({
            name: `${role}-readiness`,
            url: `http://127.0.0.1:${port}/readyz`,
            expectedStatus: "ready",
            expectedRole: String(role),
            timeoutMs: options.timeoutMs,
            request: options.request,
            clock: options.clock,
        }),
    );
}

function requiredRevision(value: string | undefined): string {
    const candidate = value?.trim();
    if (!candidate || !/^[0-9a-f]{40}$/.test(candidate)) {
        throw new Error("PIPIPI_REVISION must be a full commit SHA");
    }
    return candidate;
}

function publicBase(value: string | undefined): string {
    const candidate = required(
        value,
        "AVAILABILITY_PUBLIC_BASE_URL is required for Availability Monitor",
    );
    try {
        const url = new URL(candidate);
        if (
            url.protocol !== "https:" ||
            !url.hostname ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
        ) {
            throw new Error();
        }
        return url.toString();
    } catch {
        throw new Error("AVAILABILITY_PUBLIC_BASE_URL must use public HTTPS");
    }
}

function required(value: string | undefined, message: string): string {
    const candidate = value?.trim();
    if (!candidate) throw new Error(message);
    return candidate;
}
