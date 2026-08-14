import { describe, expect, it } from "vitest";
import { constructProcessDispatcherService } from "../src/app/process-dispatcher.js";
import { constructProcessRecoveryCommand } from "../src/app/process-recovery.js";
import { constructProcessWorkerService } from "../src/app/process-worker.js";
import { constructRetentionCleanerService } from "../src/app/retention-cleaner.js";

describe("Async runtime role construction", () => {
    it("requires only role-owned Dispatcher connection configuration", () => {
        expect(() => constructProcessDispatcherService({})).toThrow(
            "Deployment environment for process-dispatcher is missing required variables: DATABASE_URL, REDIS_URL",
        );
        expect(() =>
            constructProcessDispatcherService({ DATABASE_URL: DATABASE_URL }),
        ).toThrow(
            "Deployment environment for process-dispatcher is missing required variables: REDIS_URL",
        );
        expect(() =>
            constructProcessDispatcherService({
                DATABASE_URL,
                REDIS_URL,
                PROCESS_QUEUE_PREFIX: "bad prefix",
            }),
        ).toThrow("PROCESS_QUEUE_PREFIX is invalid");
        expect(() =>
            constructProcessDispatcherService({
                DATABASE_URL,
                REDIS_URL,
                OUTBOX_DISPATCH_BATCH_SIZE: "101",
            }),
        ).toThrow("OUTBOX_DISPATCH_BATCH_SIZE must not exceed 100");
    });

    it("requires Worker business, persistence, Redis, and retention configuration", () => {
        expect(() => constructProcessWorkerService({})).toThrow(
            "Deployment environment for process-worker is missing required variables: BUSINESS_API_BASE_URL, DATABASE_URL, REDIS_URL, PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS, PROCESS_RUN_RESULT_RETENTION_MS, PROCESS_RUN_METADATA_RETENTION_MS",
        );
        expect(() =>
            constructProcessWorkerService({
                BUSINESS_API_BASE_URL: "https://business.example",
            }),
        ).toThrow(
            "Deployment environment for process-worker is missing required variables: DATABASE_URL, REDIS_URL, PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS, PROCESS_RUN_RESULT_RETENTION_MS, PROCESS_RUN_METADATA_RETENTION_MS",
        );
        expect(() =>
            constructProcessWorkerService({
                BUSINESS_API_BASE_URL: "https://business.example",
                DATABASE_URL,
            }),
        ).toThrow(
            "Deployment environment for process-worker is missing required variables: REDIS_URL, PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS, PROCESS_RUN_RESULT_RETENTION_MS, PROCESS_RUN_METADATA_RETENTION_MS",
        );
        expect(() =>
            constructProcessWorkerService({
                BUSINESS_API_BASE_URL: "https://business.example",
                DATABASE_URL,
                REDIS_URL,
            }),
        ).toThrow(
            "Deployment environment for process-worker is missing required variables: PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS, PROCESS_RUN_RESULT_RETENTION_MS, PROCESS_RUN_METADATA_RETENTION_MS",
        );
    });

    it("rejects a claim lease that can expire during the Process timeout", () => {
        expect(() =>
            constructProcessWorkerService({
                BUSINESS_API_BASE_URL: "https://business.example",
                DATABASE_URL,
                REDIS_URL,
                ...WORKER_RETENTION,
                PROCESS_TIMEOUT_MS: "60000",
                PROCESS_RUN_CLAIM_LEASE_MS: "60000",
            }),
        ).toThrow("PROCESS_RUN_CLAIM_LEASE_MS must exceed PROCESS_TIMEOUT_MS");
    });

    it("bounds Worker shutdown below the container stop grace", () => {
        expect(() =>
            constructProcessWorkerService({
                BUSINESS_API_BASE_URL: "https://business.example",
                DATABASE_URL,
                REDIS_URL,
                ...WORKER_RETENTION,
                PROCESS_WORKER_SHUTDOWN_GRACE_MS: "60001",
            }),
        ).toThrow("PROCESS_WORKER_SHUTDOWN_GRACE_MS must not exceed 60000");
    });

    it("constructs the Retention Cleaner from role-owned PostgreSQL settings", async () => {
        expect(() => constructRetentionCleanerService({})).toThrow(
            "Deployment environment for retention-cleaner is missing required variables: DATABASE_URL",
        );
        expect(() =>
            constructRetentionCleanerService({
                DATABASE_URL,
                RETENTION_CLEANUP_BATCH_SIZE: "101",
            }),
        ).toThrow("RETENTION_CLEANUP_BATCH_SIZE must not exceed 100");
        const service = constructRetentionCleanerService({
            DATABASE_URL,
            WEBHOOK_DELIVERY_HISTORY_RETENTION_MS: "2592000000",
        });
        await service.application.close();
    });

    it("constructs one-shot Queue Recovery from Dispatcher-owned settings", async () => {
        expect(() => constructProcessRecoveryCommand({})).toThrow(
            "Deployment environment for process-recovery is missing required variables: DATABASE_URL, REDIS_URL",
        );
        expect(() => constructProcessRecoveryCommand({ DATABASE_URL })).toThrow(
            "Deployment environment for process-recovery is missing required variables: REDIS_URL",
        );
        const command = constructProcessRecoveryCommand({
            DATABASE_URL,
            REDIS_URL,
        });
        await command.close();
        await command.close();
    });
});

const DATABASE_URL =
    "postgresql://service:local-only@127.0.0.1:55432/pipipi_test";
const REDIS_URL = "redis://127.0.0.1:56379/15";
const WORKER_RETENTION = {
    PROCESS_RUN_ACCEPTED_INPUT_RETENTION_MS: "86400000",
    PROCESS_RUN_RESULT_RETENTION_MS: "604800000",
    PROCESS_RUN_METADATA_RETENTION_MS: "2592000000",
} as const;
