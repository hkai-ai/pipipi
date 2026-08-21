/** Redis 的 Availability Probe，检测连接、配置与安全基线 */
import { Redis } from "ioredis";
import type {
    AvailabilityAttribute,
    AvailabilityProbe,
    AvailabilityProbeInspection,
} from "./monitor.js";

export type RedisAvailabilityClient = Readonly<{
    connect: () => Promise<unknown>;
    ping: () => Promise<string>;
    info: (section: string) => Promise<string>;
    disconnect: () => unknown;
}>;

export function createRedisAvailabilityProbe(options: {
    redisUrl: string;
    name?: string;
    timeoutMs?: number;
    client?: RedisAvailabilityClient;
    clock?: () => number;
}): AvailabilityProbe {
    const target = parseRedisTarget(options.redisUrl);
    const timeoutMs = positiveInteger(options.timeoutMs ?? 5_000);
    const clock = options.clock ?? (() => performance.now());

    return Object.freeze({
        name: options.name ?? "redis",
        kind: "redis" as const,
        inspect: async (): Promise<AvailabilityProbeInspection> => {
            const client =
                options.client ??
                new Redis(target.url, {
                    lazyConnect: true,
                    enableReadyCheck: true,
                    maxRetriesPerRequest: 1,
                    connectTimeout: timeoutMs,
                    commandTimeout: timeoutMs,
                });
            const startedAt = clock();
            const connectionAttributes = Object.freeze({
                configurationPresent: true,
                tlsConfigured: target.tlsConfigured,
                authenticationConfigured: target.authenticationConfigured,
            });
            try {
                await client.connect();
                if ((await client.ping()) !== "PONG") {
                    throw new Error("Redis PING failed");
                }
                const [server, memory, persistence, replication, stats] =
                    await Promise.all(
                        [
                            "server",
                            "memory",
                            "persistence",
                            "replication",
                            "stats",
                        ].map(async (section) =>
                            parseInfo(await client.info(section)),
                        ),
                    );
                const attributes = Object.freeze({
                    ...connectionAttributes,
                    ...stringAttribute(server.redis_version, "version"),
                    ...integerAttribute(memory.used_memory, "usedMemoryBytes"),
                    ...integerAttribute(memory.maxmemory, "maxMemoryBytes"),
                    ...memoryUtilization(memory.used_memory, memory.maxmemory),
                    ...stringAttribute(
                        memory.maxmemory_policy,
                        "maxMemoryPolicy",
                    ),
                    ...integerAttribute(stats.evicted_keys, "evictedKeys"),
                    ...integerAttribute(
                        stats.rejected_connections,
                        "rejectedConnections",
                    ),
                    ...booleanAttribute(persistence.aof_enabled, "aofEnabled"),
                    ...stringAttribute(
                        persistence.aof_last_write_status,
                        "aofLastWriteStatus",
                    ),
                    ...stringAttribute(
                        persistence.rdb_last_bgsave_status,
                        "rdbLastSaveStatus",
                    ),
                    ...stringAttribute(replication.role, "replicationRole"),
                    ...integerAttribute(
                        replication.connected_slaves,
                        "connectedReplicas",
                    ),
                });
                const complete =
                    validVersion(server.redis_version) &&
                    validUnsignedInteger(memory.used_memory) &&
                    validUnsignedInteger(memory.maxmemory) &&
                    memory.maxmemory_policy !== undefined &&
                    validUnsignedInteger(stats.evicted_keys) &&
                    validUnsignedInteger(stats.rejected_connections) &&
                    ["0", "1"].includes(persistence.aof_enabled ?? "") &&
                    ["ok", "err"].includes(
                        persistence.aof_last_write_status ?? "",
                    ) &&
                    ["ok", "err"].includes(
                        persistence.rdb_last_bgsave_status ?? "",
                    ) &&
                    ["master", "slave"].includes(replication.role ?? "") &&
                    validUnsignedInteger(replication.connected_slaves);
                const safe =
                    complete &&
                    target.tlsConfigured &&
                    target.authenticationConfigured &&
                    memory.maxmemory_policy === "noeviction" &&
                    persistence.aof_enabled === "1" &&
                    persistence.aof_last_write_status === "ok" &&
                    persistence.rdb_last_bgsave_status === "ok";
                return Object.freeze({
                    status: safe
                        ? ("available" as const)
                        : ("degraded" as const),
                    latencyMs: elapsed(startedAt, clock()),
                    attributes,
                    ...(safe
                        ? {}
                        : {
                              errorCode: complete
                                  ? "REDIS_CONFIGURATION_UNSAFE"
                                  : "REDIS_OBSERVATION_INCOMPLETE",
                          }),
                });
            } catch {
                return Object.freeze({
                    status: "unavailable" as const,
                    latencyMs: elapsed(startedAt, clock()),
                    attributes: connectionAttributes,
                    errorCode: "REDIS_UNAVAILABLE",
                });
            } finally {
                client.disconnect();
            }
        },
    });
}

function validVersion(value: string | undefined): boolean {
    return value !== undefined && /^\d+\.\d+(?:\.\d+)?$/.test(value);
}

function validUnsignedInteger(value: string | undefined): boolean {
    if (value === undefined || !/^\d+$/.test(value)) return false;
    return Number.isSafeInteger(Number(value));
}

function parseRedisTarget(value: string): Readonly<{
    url: string;
    tlsConfigured: boolean;
    authenticationConfigured: boolean;
}> {
    try {
        const url = new URL(value.trim());
        if (
            !["redis:", "rediss:"].includes(url.protocol) ||
            !url.hostname ||
            url.search ||
            url.hash
        ) {
            throw new Error();
        }
        return Object.freeze({
            url: url.toString(),
            tlsConfigured: url.protocol === "rediss:",
            authenticationConfigured: url.password.length > 0,
        });
    } catch {
        throw new Error("REDIS_URL must be a valid Redis connection URL");
    }
}

function parseInfo(value: string): Readonly<Record<string, string>> {
    const entries: [string, string][] = [];
    for (const line of value.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        const separator = line.indexOf(":");
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        const candidate = line.slice(separator + 1);
        if (/^[a-z][a-z0-9_]*$/.test(key) && candidate.length <= 128) {
            entries.push([key, candidate]);
        }
    }
    return Object.freeze(Object.fromEntries(entries));
}

function integerAttribute(
    value: string | undefined,
    name: string,
): Readonly<Record<string, number>> {
    if (value === undefined || !/^\d+$/.test(value)) return Object.freeze({});
    const parsed = Number(value);
    return Number.isSafeInteger(parsed)
        ? Object.freeze({ [name]: parsed })
        : Object.freeze({});
}

function memoryUtilization(
    usedMemory: string | undefined,
    maxMemory: string | undefined,
): Readonly<Record<string, number>> {
    if (
        usedMemory === undefined ||
        maxMemory === undefined ||
        !/^\d+$/.test(usedMemory) ||
        !/^[1-9]\d*$/.test(maxMemory)
    ) {
        return Object.freeze({});
    }
    const used = Number(usedMemory);
    const maximum = Number(maxMemory);
    if (!Number.isSafeInteger(used) || !Number.isSafeInteger(maximum)) {
        return Object.freeze({});
    }
    return Object.freeze({
        memoryUtilizationPercent: Math.max(
            0,
            Math.min(100, Math.round((used / maximum) * 100)),
        ),
    });
}

function booleanAttribute(
    value: string | undefined,
    name: string,
): Readonly<Record<string, boolean>> {
    return value === "0" || value === "1"
        ? Object.freeze({ [name]: value === "1" })
        : Object.freeze({});
}

function stringAttribute(
    value: string | undefined,
    name: string,
): Readonly<Record<string, AvailabilityAttribute>> {
    return value && /^[A-Za-z0-9._-]{1,128}$/.test(value)
        ? Object.freeze({ [name]: value })
        : Object.freeze({});
}

function positiveInteger(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
        throw new Error(
            "Redis Availability timeout must be between 1 and 300000 milliseconds",
        );
    }
    return value;
}

function elapsed(startedAt: number, completedAt: number): number {
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return 0;
    return Math.max(0, Math.round(completedAt - startedAt));
}
