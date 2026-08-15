import { describe, expect, it, vi } from "vitest";
import { createRedisAvailabilityProbe } from "../src/availability/redis.js";

describe("Redis Availability Probe", () => {
    it("reports TLS, authentication, memory, persistence and replication attributes", async () => {
        const disconnect = vi.fn();
        const probe = createRedisAvailabilityProbe({
            redisUrl: "rediss://default:redis-secret@redis.internal:6379/0",
            client: {
                connect: async () => undefined,
                ping: async () => "PONG",
                info: async (section) => sections[section] ?? "",
                disconnect,
            },
            clock: timestamps(200, 225),
        });

        const result = await probe.inspect();

        expect(result).toEqual({
            status: "available",
            latencyMs: 25,
            attributes: {
                configurationPresent: true,
                tlsConfigured: true,
                authenticationConfigured: true,
                version: "8.2.1",
                usedMemoryBytes: 1024,
                maxMemoryBytes: 4096,
                memoryUtilizationPercent: 25,
                maxMemoryPolicy: "noeviction",
                evictedKeys: 0,
                rejectedConnections: 0,
                aofEnabled: true,
                aofLastWriteStatus: "ok",
                rdbLastSaveStatus: "ok",
                replicationRole: "master",
                connectedReplicas: 1,
            },
        });
        expect(disconnect).toHaveBeenCalledOnce();
        expect(JSON.stringify(result)).not.toContain("redis-secret");
        expect(JSON.stringify(result)).not.toContain("redis.internal");
    });

    it("marks an insecure or evicting Redis configuration as degraded", async () => {
        const probe = createRedisAvailabilityProbe({
            redisUrl: "redis://redis.internal:6379/0",
            client: {
                connect: async () => undefined,
                ping: async () => "PONG",
                info: async (section) =>
                    section === "memory"
                        ? sections.memory.replace("noeviction", "allkeys-lru")
                        : (sections[section] ?? ""),
                disconnect: () => undefined,
            },
        });

        await expect(probe.inspect()).resolves.toMatchObject({
            status: "degraded",
            attributes: {
                configurationPresent: true,
                tlsConfigured: false,
                authenticationConfigured: false,
                maxMemoryPolicy: "allkeys-lru",
            },
            errorCode: "REDIS_CONFIGURATION_UNSAFE",
        });
    });

    it("fails closed when required Redis observations are missing", async () => {
        const probe = createRedisAvailabilityProbe({
            redisUrl: "rediss://default:redis-secret@redis.internal:6379/0",
            client: {
                connect: async () => undefined,
                ping: async () => "PONG",
                info: async (section) =>
                    section === "persistence"
                        ? "aof_enabled:1\r\naof_last_write_status:ok\r\n"
                        : (sections[section] ?? ""),
                disconnect: () => undefined,
            },
        });

        await expect(probe.inspect()).resolves.toMatchObject({
            status: "degraded",
            errorCode: "REDIS_OBSERVATION_INCOMPLETE",
        });
    });

    it("returns a stable unavailable result when Redis cannot be reached", async () => {
        const probe = createRedisAvailabilityProbe({
            redisUrl: "rediss://default:redis-secret@redis.internal:6379/0",
            client: {
                connect: async () => {
                    throw new Error("redis-secret connection refused");
                },
                ping: async () => "PONG",
                info: async () => "",
                disconnect: () => undefined,
            },
        });

        const result = await probe.inspect();

        expect(result).toMatchObject({
            status: "unavailable",
            attributes: {
                configurationPresent: true,
                tlsConfigured: true,
                authenticationConfigured: true,
            },
            errorCode: "REDIS_UNAVAILABLE",
        });
        expect(JSON.stringify(result)).not.toContain("redis-secret");
    });

    it.each([
        "rediss://default:secret@redis.internal:6379/0?tls=",
        "rediss://default:secret@redis.internal:6379/0?connectTimeout=0",
        "rediss://default:secret@redis.internal:6379/0?commandTimeout=0",
    ])("rejects a connection option override in %s", (redisUrl) => {
        expect(() => createRedisAvailabilityProbe({ redisUrl })).toThrow(
            "REDIS_URL must be a valid Redis connection URL",
        );
    });
});

const sections: Readonly<Record<string, string>> = {
    server: "redis_version:8.2.1\r\n",
    memory: [
        "used_memory:1024",
        "maxmemory:4096",
        "maxmemory_policy:noeviction",
    ].join("\r\n"),
    persistence: [
        "aof_enabled:1",
        "aof_last_write_status:ok",
        "rdb_last_bgsave_status:ok",
    ].join("\r\n"),
    replication: "role:master\r\nconnected_slaves:1\r\n",
    stats: "evicted_keys:0\r\nrejected_connections:0\r\n",
};

function timestamps(...values: number[]) {
    let index = 0;
    return () => values[index++] ?? values.at(-1) ?? 0;
}
