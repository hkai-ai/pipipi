import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
    ConsoleCallerKeys,
    ConsoleIssuedKey,
} from "../src/api/console-contract.js";
import { constructProcessingService } from "../src/app/api.js";
import { createPostgresCallerApiKeyStore } from "../src/caller-api-keys/postgres.js";
import { createPostgresProcessRunRecordArchive } from "../src/run-observation/postgres.js";
import { callerApiKeyContract } from "./support/caller-api-key-contract.js";

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
if (process.env.RUN_POSTGRES_INTEGRATION === "1" && !databaseUrl)
    throw new Error(
        "POSTGRES_TEST_DATABASE_URL is required for PostgreSQL integration tests",
    );
const postgresDescribe = databaseUrl ? describe.sequential : describe.skip;
postgresDescribe("PostgreSQL caller keys and CLI", () => {
    let pool: Pool;
    beforeAll(async () => {
        if (!new URL(databaseUrl as string).pathname.endsWith("_test"))
            throw new Error("Only a test database is allowed");
        pool = new Pool({ connectionString: databaseUrl });
        await runner({
            databaseUrl: databaseUrl as string,
            direction: "up",
            dir: path.resolve("migrations"),
            migrationsTable: "pgmigrations",
            count: Infinity,
            advisoryLockMode: "wait",
            log: () => {},
        });
    }, 30000);
    beforeEach(async () => {
        await pool.query("TRUNCATE caller_api_keys, caller_api_key_audits");
    });
    afterAll(async () => {
        await pool?.end();
    });
    callerApiKeyContract((clock) =>
        createPostgresCallerApiKeyStore({ pool, clock }),
    );
    it("shares persistent keys between the CLI, Console and synchronous authentication", async () => {
        const cli = async (...args: string[]) =>
            JSON.parse(
                (
                    await promisify(execFile)(
                        process.execPath,
                        [
                            "--import",
                            "tsx",
                            "src/bin/caller-api-keys.ts",
                            ...args,
                        ],
                        { env: { ...process.env, DATABASE_URL: databaseUrl } },
                    )
                ).stdout,
            );
        const issued = await cli(
            "issue",
            "--caller-id",
            "cli-prod",
            "--label",
            "integration",
        );
        const service = constructProcessingService({
            DATABASE_URL: databaseUrl,
            CRT_BUSINESS_API_BASE_URL: "http://127.0.0.1:4400",
            PROCESS_RUN_RECORD_STORE: "postgres",
            CONSOLE_ENABLED: "true",
            CONSOLE_BASE_PATH: "/ops-secret",
            EXECUTE_AUTH_MODE: "required",
            CALLER_AUTH_GATEWAY_FALLBACK: "false",
            ASYNC_PROCESS_RUNS_ENABLED: "false",
        });
        const { url } = await service.application.listen();
        const call = (key: string) =>
            fetch(`${url}/execute`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${key}`,
                },
                body: JSON.stringify({
                    process: "not-registered",
                    version: "v1",
                    input: {},
                }),
            });
        try {
            const response = await call(issued.key);
            expect(response.status).toBe(404);
            const result = await response.json();
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(
                await createPostgresProcessRunRecordArchive({ pool }).find(
                    result.runId,
                ),
            ).toMatchObject({ callerId: "cli-prod", authMethod: "api_key" });
            const list = await cli("list", "--caller-id", "cli-prod");
            expect(list).toEqual([
                expect.objectContaining({
                    keyId: issued.metadata.keyId,
                    status: "active",
                }),
            ]);
            expect(JSON.stringify(list)).not.toContain(issued.key);
            const endpoint = `${url}/ops-secret/caller-keys`;
            const consolePost = (path: string, body: object) =>
                fetch(endpoint + path, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-pipipi-console-action": "1",
                    },
                    body: JSON.stringify(body),
                });
            const consoleIssue = await consolePost("", {
                callerId: "cli-prod",
                label: "Console rotation",
            });
            expect(consoleIssue.status).toBe(201);
            const next = (await consoleIssue.json()) as ConsoleIssuedKey;
            expect(next.persistent).toBe(true);
            expect((await call(next.key)).status).toBe(404);
            expect(
                (await consolePost(`/${issued.metadata.keyId}/revoke`, {}))
                    .status,
            ).toBe(200);
            const denied = await call(issued.key);
            expect(denied.status).toBe(401);
            expect(await denied.text()).not.toContain(issued.key);
            expect(
                await cli("revoke", "--key-id", next.metadata.keyId),
            ).toEqual({ revoked: true });
            expect((await call(next.key)).status).toBe(401);

            const inventory = await fetch(`${endpoint}?callerId=cli-prod`);
            expect(inventory.status).toBe(200);
            const text = await inventory.text();
            expect(text).not.toContain(issued.key);
            expect(text).not.toContain(next.key);
            const verified = JSON.parse(text) as ConsoleCallerKeys;
            expect(verified.auth).toEqual({
                persistent: true,
                executeAuthMode: "required",
                gatewayFallbackEnabled: false,
            });
            expect(verified.keys.map((key) => key.status)).toEqual([
                "revoked",
                "revoked",
            ]);
            expect(
                verified.audits.map((audit) => [audit.operation, audit.keyId]),
            ).toEqual([
                ["revoke", next.metadata.keyId],
                ["revoke", issued.metadata.keyId],
                ["issue", next.metadata.keyId],
                ["issue", issued.metadata.keyId],
            ]);
        } finally {
            await service.application.close();
        }
    });
});
